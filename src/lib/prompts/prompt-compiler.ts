import { clamp, round } from "@/lib/core/result";
import type { ProviderCapabilities } from "@/lib/providers/types";
import { STRICTNESS_WEIGHT } from "@/lib/spec/vocab";
import { referencesForShot, type Shot, type VideoGenerationSpec } from "@/lib/spec/spec";
import { getRenderer } from "./adapters";
import { buildBlueprint, trimBlueprint } from "./blueprint";
import { cameraFields } from "./camera-language";

/**
 * The compiled artefact for one shot. This is what the UI shows the user and
 * what the provider adapter turns into a model call.
 *
 * Deliberately excludes the intermediate `PromptBlueprint`: it is fully
 * derivable, nothing consumes it, and it is persisted on every job — carrying
 * it roughly doubled the stored size of a job record for no benefit.
 */
export interface CompiledShotPrompt {
  shotId: string;
  shotTitle: string;
  positive: string;
  negative: string;
  /** Section breakdown for the prompt inspector. */
  sections: Array<{ label: string; text: string }>;
  /** Structured camera intent, for providers that consume fields not prose. */
  cameraFields: Record<string, string | number>;
  /** How the references must be honoured, in plain language. */
  referenceInstructions: string[];
  /** Normalised, provider-agnostic generation settings. */
  parameters: {
    width: number;
    height: number;
    fps: number;
    durationSec: number;
    frames: number;
    seed: number;
    promptAdherence: number;
    referenceAdherence: number;
    consistencyStrength: number;
  };
  /** Rough token estimate — useful for spotting prompts that are too long. */
  approxTokens: number;
  /** Sections dropped to fit the provider's text-encoder budget. */
  trimmedSections: string[];
}

export interface CompiledSpecPrompts {
  specId: string;
  providerId: string;
  promptStyle: string;
  shots: CompiledShotPrompt[];
}

/**
 * Compiles a spec into provider-ready prompts.
 *
 * The user never writes prompting syntax; this is where their casual sentence
 * has become a set of professional, model-specific generation instructions.
 */
export function compileSpec(
  spec: VideoGenerationSpec,
  capabilities: ProviderCapabilities,
): CompiledSpecPrompts {
  return {
    specId: spec.id,
    providerId: capabilities.id,
    promptStyle: capabilities.promptStyle,
    shots: spec.shots.map((shot) => compileShot(spec, shot, capabilities)),
  };
}

export function compileShot(
  spec: VideoGenerationSpec,
  shot: Shot,
  capabilities: ProviderCapabilities,
): CompiledShotPrompt {
  const render = getRenderer(capabilities.promptStyle);

  // Trim to the text-encoder budget *before* rendering, so what gets dropped is
  // chosen by importance rather than by where the model happens to truncate.
  // The trimmer measures through the real renderer, so the budget is enforced
  // against the string the provider will actually send.
  const { blueprint, trimmed } = trimBlueprint(
    buildBlueprint(spec, shot),
    capabilities.maxPromptTokens,
    (b) => {
      const r = render(b);
      return estimateTokens(r.positive) + estimateTokens(r.negative);
    },
  );
  const rendered = render(blueprint);

  // A provider with no negative-prompt support must have those constraints
  // folded into the positive prompt, or they are silently lost.
  let positive = rendered.positive;
  let negative = rendered.negative;
  const sections = [...rendered.sections];

  if (!capabilities.supportsNegativePrompt && negative) {
    const avoidText = `Avoid entirely: ${negative}.`;
    positive = `${positive}\n\n${avoidText}`;
    sections.push({ label: "Avoid (inlined)", text: avoidText });
    negative = "";
  }

  const refs = referencesForShot(spec, shot.id);
  const referenceAdherence =
    refs.length > 0 ? clamp(Math.max(...refs.map((r) => r.weight)), 0, 1) : 0;

  const frames = Math.max(1, Math.round(shot.durationSec * spec.delivery.generation.fps));

  return {
    shotId: shot.id,
    shotTitle: shot.title,
    positive,
    negative,
    sections,
    cameraFields: cameraFields(shot.camera),
    referenceInstructions: blueprint.references,
    parameters: {
      width: spec.delivery.generation.width,
      height: spec.delivery.generation.height,
      fps: spec.delivery.generation.fps,
      durationSec: shot.durationSec,
      frames,
      seed: capabilities.supportsSeed ? shot.seed : 0,
      // Higher realism means following the (heavily constrained) text more
      // closely; stylised work benefits from letting the model roam.
      promptAdherence: round(promptAdherenceFor(spec), 3),
      referenceAdherence: round(referenceAdherence, 3),
      consistencyStrength: round(spec.consistency.strength, 3),
    },
    approxTokens: estimateTokens(positive) + estimateTokens(negative),
    trimmedSections: trimmed,
  };
}

function promptAdherenceFor(spec: VideoGenerationSpec): number {
  const base = { stylised: 0.45, standard: 0.6, high: 0.72, maximum: 0.82 }[spec.realism.level];
  // Strong identity references mean the image should lead, not the text.
  const identityPull = spec.references.some((r) => r.usage === "identity" && r.adherence === "strict")
    ? -0.07
    : 0;
  const consistencyPull = STRICTNESS_WEIGHT[spec.consistency.crossShot.colorGrade] * 0.05;
  return clamp(base + identityPull + consistencyPull, 0.3, 0.95);
}

/** Deliberately crude: ~4 characters per token is close enough to flag bloat. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
