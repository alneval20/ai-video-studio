import type { BrandProfile } from "@/lib/brands/types";
import { buildConsistencyContract, seedForShot } from "@/lib/consistency/consistency-engine";
import { ID } from "@/lib/core/ids";
import { clamp } from "@/lib/core/result";
import { planShots } from "@/lib/planner/shot-planner";
import { buildRealismDirective } from "@/lib/realism/realism-engine";
import { hasIdentityReference, resolveReferences } from "@/lib/references/reference-manager";
import type { StoredReference } from "@/lib/references/types";
import { getArchetype } from "@/lib/social/aesthetics";
import {
  SPEC_VERSION,
  VideoGenerationSpec,
  type DirectorMeta,
  type RealismDomain,
  type SceneSubject,
  type Shot,
} from "@/lib/spec/spec";
import { ASPECT_RATIO_VALUE, FORMAT_DEFAULTS, type AspectRatio, type Strictness } from "@/lib/spec/vocab";
import type { DirectorOutput } from "./types";

export interface AssembleSpecInput {
  projectId: string;
  prompt: string;
  director: DirectorOutput;
  brand: BrandProfile | null;
  references: StoredReference[];
  /** Which provider will run this — determines what reference usages survive. */
  provider: {
    id: string;
    supportsInitFrame: boolean;
    supportedReferenceUsages: import("@/lib/spec/vocab").ReferenceUsage[];
    /** Generation resolution ceiling on the long edge. */
    maxGenerationEdge: number;
    /** Exact validated sizes, when the provider is constrained to a set. */
    supportedGenerationSizes?: ReadonlyArray<{ width: number; height: number }>;
    maxFps: number;
    maxClipSeconds: number;
    options?: Record<string, unknown>;
  };
  advanced?: {
    cameraPresetId?: string | null;
    shotCount?: number | null;
    seed?: number | null;
    consistencyStrength?: number | null;
    referenceStrength?: number | null;
    motionBudget?: number | null;
    negativePrompt?: string | null;
    maxShots?: number;
  };
}

export interface AssembleSpecResult {
  spec: VideoGenerationSpec;
  /** Decisions worth showing the user in the plan inspector. */
  notes: string[];
}

/**
 * Turns a validated DirectorBrief into the full VideoGenerationSpec.
 *
 * This is pure, deterministic application code — no model calls, no I/O. Given
 * the same brief, brand, references and provider capabilities it always
 * produces the same spec, which is what makes the pipeline testable and makes a
 * failed shot reproducible for repair.
 */
export function assembleSpec(input: AssembleSpecInput): AssembleSpecResult {
  const { brief } = input.director;
  const notes: string[] = [];
  const adv = input.advanced ?? {};

  const archetype = getArchetype(brief.socialArchetype);
  const brand = input.brand;

  // --- delivery ------------------------------------------------------------
  const formatDefaults = FORMAT_DEFAULTS[brief.format];
  const totalDurationSec = clamp(brief.targetDurationSec, 2, formatDefaults.maxDurationSec);
  const generation = chooseGenerationSize(
    formatDefaults.aspectRatio,
    input.provider.maxGenerationEdge,
    input.provider.supportedGenerationSizes,
  );
  const generationFps = Math.min(24, input.provider.maxFps);

  if (generation.width !== formatDefaults.exportWidth) {
    notes.push(
      `Generating at ${generation.width}×${generation.height} @ ${generationFps}fps, ` +
        `upscaled to ${formatDefaults.exportWidth}×${formatDefaults.exportHeight} on export.`,
    );
  }

  // --- scene ---------------------------------------------------------------
  const subjects: SceneSubject[] = brief.subjects.map((s) => ({
    key: s.key,
    kind: s.kind,
    label: labelFor(s.key),
    description: s.description,
    hero: s.hero,
    identityNotes: s.identityNotes,
  }));
  const allSubjectKinds = subjects.map((s) => s.kind);

  // --- realism (global) ----------------------------------------------------
  const realismOverrides = (brand?.realismOverrides ?? {}) as Partial<Record<RealismDomain, Strictness>>;
  const extraNegatives = [
    ...(brand?.avoid ?? []),
    ...(adv.negativePrompt ? [adv.negativePrompt] : []),
  ];

  // First pass: we don't yet know whether references will bind as identity
  // conditioning, because that depends on the shot list. Assume they will if any
  // identity-role reference was uploaded, then recompute per shot below.
  const provisionalIdentityRefs = input.references.some((r) =>
    ["product", "logo", "character", "food", "clothing", "first_frame"].includes(r.role),
  );

  const motionBudget = clamp(
    adv.motionBudget ?? brand?.camera.motionBudget ?? archetype.motionBudget,
    0,
    1,
  );

  // --- shots ---------------------------------------------------------------
  const plan = planShots({
    brief,
    archetype,
    totalDurationSec,
    maxShots: adv.maxShots ?? 6,
    forcedShotCount: adv.shotCount ?? null,
    forcedCameraPresetId: adv.cameraPresetId ?? null,
    motionBudget,
    realismOverrides,
    extraNegatives,
    hasIdentityReference: provisionalIdentityRefs,
  });
  notes.push(...plan.notes);

  // Clamp shots to what the provider can actually render in one clip.
  let shots: Shot[] = plan.shots.map((shot) => {
    if (shot.durationSec <= input.provider.maxClipSeconds) return shot;
    notes.push(
      `${shot.title} trimmed from ${shot.durationSec}s to ${input.provider.maxClipSeconds}s — ` +
        `the ${input.provider.id} provider cannot generate longer clips in one pass.`,
    );
    return { ...shot, durationSec: input.provider.maxClipSeconds };
  });

  // --- references ----------------------------------------------------------
  const references = resolveReferences({
    references: input.references,
    subjects,
    shots: shots.map((s) => ({ id: s.id, featuredSubjectKeys: s.featuredSubjectKeys, index: s.index })),
    referenceStrength: clamp(adv.referenceStrength ?? 0.8, 0, 1),
    brandAdherence: brand
      ? { logo: brand.consistency.logoAdherence, product: brand.consistency.productAdherence }
      : undefined,
    providerSupportsInitFrame: input.provider.supportsInitFrame,
    supportedUsages: input.provider.supportedReferenceUsages,
  });

  const degraded = references.filter((r) => r.usage === "descriptive_only" && r.role !== "style");
  if (degraded.length > 0) {
    notes.push(
      `${degraded.length} reference image(s) could not be used as model conditioning by the ` +
        `${input.provider.id} provider and are described in the prompt instead.`,
    );
  }

  const identityBound = hasIdentityReference(references);

  // Attach per-shot reference ids and recompute realism now that we know
  // whether identity conditioning actually survived provider negotiation.
  const multiShot = shots.length > 1;
  shots = shots.map((shot) => {
    const shotRefs = references.filter((r) => r.shotIds === null || r.shotIds.includes(shot.id));
    const kinds = shot.featuredSubjectKeys
      .map((k) => subjects.find((s) => s.key === k)?.kind)
      .filter((k): k is SceneSubject["kind"] => Boolean(k));

    return {
      ...shot,
      referenceIds: shotRefs.map((r) => r.referenceId),
      realism: buildRealismDirective({
        level: brief.realismLevel,
        subjectKinds: kinds.length > 0 ? kinds : allSubjectKinds,
        hasMotion: shot.camera.moveIntensity > 0.12 || shot.motion.subjectMotion !== "micro",
        hasIdentityReference: identityBound && shotRefs.length > 0,
        multiShot,
        overrides: realismOverrides,
        extraNegatives: [...extraNegatives, ...brief.userAvoidances],
      }),
    };
  });

  // --- consistency ---------------------------------------------------------
  const specId = ID.spec();
  const consistency = buildConsistencyContract({
    subjects,
    shots: shots.map((s) => ({ id: s.id, featuredSubjectKeys: s.featuredSubjectKeys })),
    references,
    strength: clamp(adv.consistencyStrength ?? brand?.consistency.strength ?? 0.8, 0, 1),
    seedSource: `${input.projectId}:${input.prompt}`,
    seedOverride: adv.seed ?? null,
    multiShot,
  });

  shots = shots.map((shot) => ({ ...shot, seed: seedForShot(consistency, shot.index, 0) }));

  // --- global realism ------------------------------------------------------
  const realism = buildRealismDirective({
    level: brief.realismLevel,
    subjectKinds: allSubjectKinds,
    hasMotion: shots.some((s) => s.camera.moveIntensity > 0.12),
    hasIdentityReference: identityBound,
    multiShot,
    overrides: realismOverrides,
    extraNegatives: [...extraNegatives, ...brief.userAvoidances],
  });

  const directorMeta: DirectorMeta = {
    engine: input.director.engine,
    model: input.director.model,
    fallbackUsed: input.director.fallbackUsed,
    warnings: input.director.warnings,
    elapsedMs: input.director.elapsedMs,
  };

  const actualDuration = Number(shots.reduce((sum, s) => sum + s.durationSec, 0).toFixed(2));

  const spec: VideoGenerationSpec = {
    specVersion: SPEC_VERSION,
    id: specId,
    projectId: input.projectId,
    createdAt: new Date().toISOString(),
    source: {
      prompt: input.prompt,
      language: brief.sourceLanguage,
      brandProfileId: brand?.id ?? null,
    },
    creative: {
      logline: brief.logline,
      visualStyle: brief.visualStyle,
      colorGrade: brief.colorGrade,
      mood: brief.mood,
      socialArchetype: brief.socialArchetype,
      aestheticTags: [...archetype.aestheticTags, ...(brand?.signatureNotes ?? [])],
    },
    delivery: {
      format: brief.format,
      aspectRatio: formatDefaults.aspectRatio,
      generation: { ...generation, fps: generationFps },
      export: {
        width: formatDefaults.exportWidth,
        height: formatDefaults.exportHeight,
        fps: 30,
      },
      totalDurationSec: actualDuration,
    },
    scene: {
      environment: {
        setting: brief.environment.setting,
        timeOfDay: brief.environment.timeOfDay,
        lighting: brief.environment.lighting,
        backgroundActivity: brief.environment.backgroundActivity,
        atmosphereNotes: brief.environment.atmosphereNotes,
      },
      subjects,
    },
    realism,
    consistency,
    references,
    shots,
    quality: {
      minOverall: brief.realismLevel === "maximum" ? 0.8 : brief.realismLevel === "high" ? 0.7 : 0.6,
      minTemporalConsistency: 0.65,
      minSubjectConsistency: identityBound ? 0.75 : 0.6,
      maxRepairAttempts: 2,
    },
    provider: {
      providerId: input.provider.id,
      options: input.provider.options ?? {},
    },
    post: {
      music: { enabled: false, brief: "", trackPath: null, duckUnderVoice: false },
      captions: { enabled: false, lines: [] },
      branding: {
        logoReferenceId: references.find((r) => r.role === "logo")?.referenceId ?? null,
        placement: "none",
        lastFrameHold: false,
      },
    },
    brief,
    directorMeta,
  };

  // Validate our own output too — a bug in an engine should fail loudly here,
  // not produce a subtly malformed request three layers downstream.
  return { spec: VideoGenerationSpec.parse(spec), notes };
}

/**
 * Picks a generation resolution that respects the aspect ratio and the
 * provider's ceiling, snapped to a multiple of 16 (every diffusion video model
 * in practice requires this, and silently rounding produces stretched output).
 */
/**
 * Picks the generation resolution.
 *
 * When the provider publishes validated sizes, choose from them: the closest
 * aspect match, largest first. Deriving a size instead risks violating the
 * model's spatial stride — a 16-aligned guess like 688x1216 is invalid for a
 * model requiring multiples of 32, and fails inside the VAE on the GPU.
 */
export function chooseGenerationSize(
  aspectRatio: AspectRatio,
  maxEdge: number,
  supported?: ReadonlyArray<{ width: number; height: number }>,
): { width: number; height: number } {
  if (!supported || supported.length === 0) {
    return generationResolution(aspectRatio, maxEdge);
  }
  const target = ASPECT_RATIO_VALUE[aspectRatio];
  return [...supported]
    .sort((a, b) => {
      const da = Math.abs(a.width / a.height - target);
      const db = Math.abs(b.width / b.height - target);
      if (Math.abs(da - db) > 0.001) return da - db;
      return b.width * b.height - a.width * a.height;
    })[0];
}

export function generationResolution(
  aspectRatio: AspectRatio,
  maxEdge: number,
): { width: number; height: number } {
  const ratio = ASPECT_RATIO_VALUE[aspectRatio];
  const long = snap16(maxEdge);
  const short = snap16(long * (ratio < 1 ? ratio : 1 / ratio));
  return ratio < 1 ? { width: short, height: long } : { width: long, height: short };
}

function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

function labelFor(key: string): string {
  return key
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
