import { selectCamera } from "@/lib/camera/camera-director";
import { ID } from "@/lib/core/ids";
import { clamp, round } from "@/lib/core/result";
import { buildRealismDirective } from "@/lib/realism/realism-engine";
import type { RealismDomain } from "@/lib/spec/spec";
import type { Shot, Transition } from "@/lib/spec/spec";
import type { DirectorBrief } from "@/lib/spec/brief";
import type {
  ShotPurpose,
  ShotSize,
  Strictness,
  SubjectKind,
} from "@/lib/spec/vocab";
import type { SocialArchetypeProfile } from "@/lib/social/aesthetics";
import { planMotion } from "./motion";

/**
 * Minimum time a generated shot needs to read as a shot rather than a flash.
 * Below ~2.5s a viewer cannot parse the content, and most open-source video
 * models produce their worst artefacts in very short clips.
 */
export const MIN_SHOT_SEC = 2.5;
export const MAX_SHOT_SEC = 8;

export interface ShotPlanInput {
  brief: DirectorBrief;
  archetype: SocialArchetypeProfile;
  totalDurationSec: number;
  /** Hard ceiling from configuration. */
  maxShots: number;
  /** Explicit user override from the Advanced panel. */
  forcedShotCount?: number | null;
  forcedCameraPresetId?: string | null;
  motionBudget: number;
  /** Realism overrides from the brand profile. */
  realismOverrides?: Partial<Record<RealismDomain, Strictness>>;
  extraNegatives?: string[];
  hasIdentityReference: boolean;
  /** Deterministic seed assignment happens later; the planner leaves 0. */
}

export interface ShotPlanResult {
  shots: Shot[];
  /** Explanations for decisions the UI shows in the plan inspector. */
  notes: string[];
}

/**
 * Decides how many shots the idea actually needs.
 *
 * The brief is explicit that short authentic social videos usually work better
 * with fewer, stronger shots — so this deliberately biases downward and will
 * override a director that asks for six cuts in eight seconds.
 */
export function resolveShotCount(input: ShotPlanInput): { count: number; note: string } {
  if (input.forcedShotCount && input.forcedShotCount > 0) {
    const count = clamp(Math.round(input.forcedShotCount), 1, input.maxShots);
    return { count, note: `Shot count fixed to ${count} by the user.` };
  }

  const requested = clamp(input.brief.suggestedShotCount, 1, input.maxShots);
  // Never cut below the minimum readable shot length.
  const byDuration = Math.max(1, Math.floor(input.totalDurationSec / MIN_SHOT_SEC));
  const byBeats = Math.max(1, input.brief.beats.length);

  let count = Math.min(requested, byDuration, byBeats, input.maxShots);

  // UGC-style content reads as more authentic with fewer cuts.
  if (input.archetype.id === "influencer_ugc" || input.archetype.id === "creator_pov") {
    count = Math.min(count, 2);
  }
  if (input.archetype.id === "ambience_loop") count = 1;

  // Very short videos are almost always better as one continuous take.
  if (input.totalDurationSec <= 6) count = Math.min(count, 2);
  if (input.totalDurationSec <= 4) count = 1;

  const note =
    count < requested
      ? `Director asked for ${requested} shots; reduced to ${count} — ${reduceReason(input, count)}.`
      : `${count} shot${count === 1 ? "" : "s"} planned.`;

  return { count: Math.max(1, count), note };
}

function reduceReason(input: ShotPlanInput, count: number): string {
  if (input.totalDurationSec <= 4) return "a video this short works better as a single unbroken take";
  if (input.totalDurationSec / count < MIN_SHOT_SEC + 0.5) {
    return `each shot would fall below ${MIN_SHOT_SEC}s and read as a flash cut`;
  }
  if (input.archetype.id === "influencer_ugc" || input.archetype.id === "creator_pov") {
    return "authentic creator footage reads as staged when it cuts too often";
  }
  return "the idea does not carry enough distinct beats";
}

/** Distributes total runtime across shots using the beats' relative weights. */
export function allocateDurations(totalSec: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [round(clamp(totalSec, MIN_SHOT_SEC, MAX_SHOT_SEC), 2)];

  const sum = weights.reduce((a, b) => a + b, 0) || n;
  let durations = weights.map((w) => (w / sum) * totalSec);

  // Clamp, then redistribute the error so the total still lands on target.
  durations = durations.map((d) => clamp(d, MIN_SHOT_SEC, MAX_SHOT_SEC));
  const drift = totalSec - durations.reduce((a, b) => a + b, 0);
  if (Math.abs(drift) > 0.05) {
    // Give the slack to whichever shots still have headroom.
    const adjustable = durations
      .map((d, i) => ({ i, headroom: drift > 0 ? MAX_SHOT_SEC - d : d - MIN_SHOT_SEC }))
      .filter((x) => x.headroom > 0.01);
    const totalHeadroom = adjustable.reduce((a, b) => a + b.headroom, 0);
    if (totalHeadroom > 0) {
      for (const { i, headroom } of adjustable) {
        durations[i] += drift * (headroom / totalHeadroom);
      }
    }
  }

  return durations.map((d) => round(clamp(d, MIN_SHOT_SEC, MAX_SHOT_SEC), 2));
}

/**
 * Fallback narrative arc when the director supplies fewer beats than shots.
 * Ordered from context to payoff.
 */
const DEFAULT_ARC: ShotPurpose[][] = [
  ["product_hero"],
  ["establishing", "product_hero"],
  ["establishing", "interaction", "product_hero"],
  ["establishing", "detail", "interaction", "payoff"],
  ["establishing", "atmosphere", "detail", "interaction", "payoff"],
  ["establishing", "atmosphere", "detail", "interaction", "reaction", "payoff"],
];

export function planShots(input: ShotPlanInput): ShotPlanResult {
  const notes: string[] = [];
  const { count, note } = resolveShotCount(input);
  notes.push(note);

  const subjectByKey = new Map(input.brief.subjects.map((s) => [s.key, s]));
  const heroKey = (input.brief.subjects.find((s) => s.hero) ?? input.brief.subjects[0]).key;

  // Take the highest-weighted beats, keeping the director's order.
  const beats = [...input.brief.beats]
    .map((b, i) => ({ beat: b, i }))
    .sort((a, b) => b.beat.weight - a.beat.weight)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.beat);

  // If we still have fewer beats than shots, extend using the default arc.
  const arc = DEFAULT_ARC[Math.min(count, DEFAULT_ARC.length) - 1];
  while (beats.length < count) {
    const purpose = arc[beats.length] ?? "detail";
    beats.push({
      purpose,
      action: syntheticAction(purpose, subjectByKey.get(heroKey)?.description ?? "the subject"),
      featured: [heroKey],
      weight: 1,
      suggestedShotSize: undefined,
    });
    notes.push(`Added a synthetic "${purpose.replace(/_/g, " ")}" beat to fill the runtime.`);
  }

  const durations = allocateDurations(input.totalDurationSec, beats.map((b) => b.weight));
  const usedPresetIds: string[] = [];
  const multiShot = count > 1;

  const shots: Shot[] = beats.map((beat, index) => {
    const featured = beat.featured.length > 0 ? beat.featured : [heroKey];
    const subjectKinds = kindsFor(featured, subjectByKey, beat.purpose);
    const durationSec = durations[index] ?? MIN_SHOT_SEC;

    const camera = selectCamera({
      purpose: beat.purpose,
      subjectKinds,
      archetype: input.archetype.id,
      style: input.brief.visualStyle,
      realismLevel: input.brief.realismLevel,
      durationSec,
      shotIndex: index,
      usedPresetIds: [...usedPresetIds],
      forcedPresetId: input.forcedCameraPresetId ?? null,
      preferredShotSize: beat.suggestedShotSize ?? defaultShotSize(beat.purpose),
      motionBudget: input.motionBudget,
    });
    usedPresetIds.push(camera.presetId);

    const motion = planMotion({
      purpose: beat.purpose,
      subjectKinds,
      camera,
      backgroundActivity: input.brief.environment.backgroundActivity,
      timeOfDay: input.brief.environment.timeOfDay,
      durationSec,
      action: beat.action,
    });

    const realism = buildRealismDirective({
      level: input.brief.realismLevel,
      subjectKinds,
      hasMotion: camera.moveIntensity > 0.12 || motion.subjectMotion !== "micro",
      hasIdentityReference: input.hasIdentityReference,
      multiShot,
      overrides: input.realismOverrides,
      extraNegatives: [...(input.extraNegatives ?? []), ...input.brief.userAvoidances],
    });

    return {
      id: ID.shot(),
      index,
      purpose: beat.purpose,
      title: shotTitle(beat.purpose, index),
      action: beat.action,
      featuredSubjectKeys: featured,
      durationSec,
      camera,
      motion,
      realism,
      referenceIds: [],
      transitionIn: transitionFor(index, beat.purpose, input),
      seed: 0, // assigned by the consistency contract during spec assembly
    } satisfies Shot;
  });

  if (multiShot) {
    notes.push(
      `Camera language varies across shots: ${shots.map((s) => s.camera.presetLabel).join(" → ")}.`,
    );
  }

  return { shots, notes };
}

function kindsFor(
  featured: string[],
  subjects: Map<string, { kind: SubjectKind }>,
  purpose: ShotPurpose,
): SubjectKind[] {
  const kinds = featured.map((k) => subjects.get(k)?.kind).filter((k): k is SubjectKind => Boolean(k));
  if (purpose === "establishing" && !kinds.includes("environment")) kinds.push("environment");
  return kinds.length > 0 ? Array.from(new Set(kinds)) : ["product"];
}

function defaultShotSize(purpose: ShotPurpose): ShotSize | null {
  switch (purpose) {
    case "establishing":
      return "wide";
    case "detail":
      return "macro";
    case "product_hero":
      return "close_up";
    case "reaction":
      return "medium_close_up";
    case "interaction":
      return "medium";
    case "atmosphere":
      return "wide";
    case "reveal":
      return "medium_close_up";
    case "payoff":
      return "close_up";
    default:
      return null;
  }
}

function shotTitle(purpose: ShotPurpose, index: number): string {
  const label = purpose
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return `Shot ${index + 1} — ${label}`;
}

function transitionFor(index: number, purpose: ShotPurpose, input: ShotPlanInput): Transition {
  if (index === 0) {
    return input.brief.visualStyle === "cinematic_commercial" || input.brief.visualStyle === "luxury_product"
      ? "fade_from_black"
      : "cut";
  }
  // Detail shots inside a commercial piece look good as match cuts.
  if (purpose === "detail" && input.brief.visualStyle !== "authentic_ugc") return "match_cut";
  return "cut";
}

function syntheticAction(purpose: ShotPurpose, heroDescription: string): string {
  switch (purpose) {
    case "establishing":
      return `The space is revealed with ${heroDescription} sitting naturally within it.`;
    case "detail":
      return `An extreme close view of ${heroDescription}, holding still on its surface texture.`;
    case "atmosphere":
      return `Ambient details of the space settle around ${heroDescription}.`;
    case "payoff":
      return `${heroDescription} rests in its final, most appealing state.`;
    case "product_hero":
      return `${heroDescription} is presented cleanly as the focus of the frame.`;
    default:
      return `${heroDescription} remains the centre of attention.`;
  }
}
