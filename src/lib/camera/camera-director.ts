import { clamp, round } from "@/lib/core/result";
import type { CameraDirective } from "@/lib/spec/spec";
import type {
  CameraMove,
  DepthOfField,
  RealismLevel,
  ShotPurpose,
  ShotSize,
  SocialArchetype,
  SubjectKind,
  VisualStyle,
} from "@/lib/spec/vocab";
import { CAMERA_PRESETS, DEFAULT_PRESET_ID, getCameraPreset, type CameraPreset } from "./presets";

export interface CameraSelectionInput {
  purpose: ShotPurpose;
  /** Subject kinds visible in this shot. */
  subjectKinds: SubjectKind[];
  archetype: SocialArchetype;
  style: VisualStyle;
  realismLevel: RealismLevel;
  /** Shot length in seconds. Short shots must not attempt long moves. */
  durationSec: number;
  /** Index of this shot within the video (0-based). */
  shotIndex: number;
  /** Presets already used, so a multi-shot video varies its camera language. */
  usedPresetIds: string[];
  /** Optional hard override from Advanced settings. */
  forcedPresetId?: string | null;
  /** Director's shot-size hint, if it had one. */
  preferredShotSize?: ShotSize | null;
  /** 0..1 — how much movement the user asked for. 0.35 is the calm default. */
  motionBudget?: number;
}

interface ScoredPreset {
  preset: CameraPreset;
  score: number;
  reasons: string[];
}

const REALISM_MOTION_CEILING: Record<RealismLevel, number> = {
  stylised: 0.9,
  standard: 0.7,
  high: 0.5,
  maximum: 0.38,
};

/**
 * Selects and parameterises the camera for a single shot.
 *
 * Scoring is transparent on purpose: every decision produces a `rationale`
 * string that the UI shows in the plan inspector, so a bad shot is debuggable
 * without reading code.
 */
export function selectCamera(input: CameraSelectionInput): CameraDirective {
  const preset = input.forcedPresetId
    ? (getCameraPreset(input.forcedPresetId) ?? getCameraPreset(DEFAULT_PRESET_ID)!)
    : pickPreset(input);

  return parameterise(preset, input);
}

function pickPreset(input: CameraSelectionInput): CameraPreset {
  const scored: ScoredPreset[] = CAMERA_PRESETS.map((preset) => {
    const reasons: string[] = [];
    let score = 0;

    if (preset.affinity.purposes.includes(input.purpose)) {
      score += 3;
      reasons.push(`suits a ${input.purpose.replace(/_/g, " ")} shot`);
    }

    const kindHits = input.subjectKinds.filter((k) => preset.affinity.subjectKinds.includes(k));
    if (kindHits.length > 0) {
      score += 1.5 * kindHits.length;
      reasons.push(`handles ${kindHits.join(", ")}`);
    }

    if (preset.affinity.archetypes.includes(input.archetype)) {
      score += 2.5;
      reasons.push(`matches ${input.archetype.replace(/_/g, " ")}`);
    }

    if (preset.affinity.styles.includes(input.style)) {
      score += 2;
      reasons.push(`fits ${input.style.replace(/_/g, " ")}`);
    }

    // A 3-second shot cannot support a slow 25-degree arc; penalise big moves.
    if (input.durationSec < 3.5 && preset.moveIntensity > 0.3) {
      score -= 2.5;
      reasons.push("penalised: move too large for a short shot");
    }

    // High realism prefers restrained, human-plausible camera work.
    const ceiling = REALISM_MOTION_CEILING[input.realismLevel];
    if (preset.moveIntensity > ceiling) {
      score -= (preset.moveIntensity - ceiling) * 6;
      reasons.push("penalised: exceeds the realism motion ceiling");
    }

    // Variety across a multi-shot piece — repeating the same preset reads as lazy.
    const repeats = input.usedPresetIds.filter((id) => id === preset.id).length;
    if (repeats > 0) {
      score -= repeats * 3;
      reasons.push("penalised: already used in this video");
    }

    // Openers benefit from context; payoffs benefit from stillness.
    if (input.shotIndex === 0 && preset.defaultShotSize === "macro") score -= 1.5;

    return { preset, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score > 0 ? best.preset : getCameraPreset(DEFAULT_PRESET_ID)!;
}

function parameterise(preset: CameraPreset, input: CameraSelectionInput): CameraDirective {
  const budget = clamp(input.motionBudget ?? 0.35, 0, 1);
  const ceiling = REALISM_MOTION_CEILING[input.realismLevel];

  // Motion budget scales around the preset's own value rather than replacing
  // it, so "premium_product" stays more mobile than "static_luxury" even at a
  // low budget.
  const budgetScale = 0.55 + budget * 0.9; // 0.55x .. 1.45x
  let moveIntensity = preset.moveIntensity * budgetScale;

  // Short shots physically cannot complete a large move without looking sped up.
  if (input.durationSec < 3) moveIntensity *= 0.6;
  else if (input.durationSec < 4.5) moveIntensity *= 0.8;

  moveIntensity = clamp(moveIntensity, 0.02, ceiling);

  // Speed is the move divided by the time available, lightly damped.
  const speed = clamp(
    preset.moveSpeed * (5 / Math.max(2, input.durationSec)) ** 0.5,
    0.05,
    input.realismLevel === "maximum" ? 0.45 : 0.75,
  );

  // Maximum realism nudges everything toward "a person really held this".
  const jitterScale = input.realismLevel === "maximum" ? 1.15 : input.realismLevel === "high" ? 1.05 : 1;
  const microJitter = clamp(preset.microJitter * jitterScale, 0, 1);

  const shotSize = input.preferredShotSize ?? preset.defaultShotSize;
  const depthOfField = adjustDof(preset.depthOfField, shotSize);
  const subjectDistanceM = distanceForShotSize(shotSize, preset.subjectDistanceM);

  // Drop a secondary move when the budget is tight — layering two moves on a
  // small budget produces mush.
  const secondaryMove: CameraMove | null =
    preset.secondaryMove && moveIntensity > 0.12 ? preset.secondaryMove : null;

  const rationale = buildRationale(preset, input, moveIntensity);

  return {
    presetId: preset.id,
    presetLabel: preset.label,
    device: preset.device,
    shotSize,
    angle: preset.angle,
    height: preset.height,
    primaryMove: moveIntensity < 0.06 ? "static" : preset.primaryMove,
    secondaryMove,
    moveIntensity: round(moveIntensity, 3),
    moveSpeed: round(speed, 3),
    stability: round(clamp(preset.stability, 0, 1), 3),
    microJitter: round(microJitter, 3),
    focalLengthMm: preset.focalLengthMm,
    depthOfField,
    focusBehavior: preset.focusBehavior,
    subjectDistanceM: round(subjectDistanceM, 3),
    parallax: round(clamp(preset.parallax * (0.7 + moveIntensity), 0, 1), 3),
    framingNotes: preset.framingNotes,
    rationale,
  };
}

function adjustDof(base: DepthOfField, shotSize: ShotSize): DepthOfField {
  const order: DepthOfField[] = ["deep", "moderate", "shallow", "very_shallow"];
  const tighter: ShotSize[] = ["macro", "extreme_close_up", "close_up"];
  const wider: ShotSize[] = ["wide", "establishing"];
  let i = order.indexOf(base);
  if (tighter.includes(shotSize)) i += 1;
  if (wider.includes(shotSize)) i -= 1;
  return order[clamp(i, 0, order.length - 1)];
}

/** Rough subject distances that keep framing language physically coherent. */
const SHOT_SIZE_DISTANCE: Record<ShotSize, number> = {
  macro: 0.15,
  extreme_close_up: 0.3,
  close_up: 0.5,
  medium_close_up: 0.9,
  medium: 1.6,
  wide: 3.5,
  establishing: 6,
};

function distanceForShotSize(shotSize: ShotSize, presetDistance: number): number {
  // Blend the canonical distance with the preset's own so macro rigs stay close.
  return SHOT_SIZE_DISTANCE[shotSize] * 0.7 + presetDistance * 0.3;
}

function buildRationale(preset: CameraPreset, input: CameraSelectionInput, intensity: number): string {
  const level =
    intensity < 0.1 ? "essentially static" : intensity < 0.25 ? "very subtle" : intensity < 0.4 ? "measured" : "active";
  return (
    `${preset.label} chosen for a ${input.purpose.replace(/_/g, " ")} shot in a ` +
    `${input.style.replace(/_/g, " ")} piece; movement kept ${level} ` +
    `(${input.realismLevel} realism caps intensity at ${REALISM_MOTION_CEILING[input.realismLevel]}).`
  );
}

