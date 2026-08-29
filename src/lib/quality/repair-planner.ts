import { clamp } from "@/lib/core/result";
import { seedForShot } from "@/lib/consistency/consistency-engine";
import type { Shot, VideoGenerationSpec } from "@/lib/spec/spec";
import type { QualityIssue, QualityReport } from "./types";

/**
 * The repair planner.
 *
 * Given a failed quality report, it decides how to change *this one shot* for
 * the next attempt. It never regenerates the whole project — shots are
 * independently addressable, and only the failing one is retried.
 *
 * Each strategy is a concrete, explainable mutation, so the UI can say
 * "attempt 2: camera movement reduced, seed changed" rather than "retrying".
 */

export interface RepairPlan {
  shouldRetry: boolean;
  /** The mutated shot to generate next. Identical id and index. */
  shot: Shot;
  /** What changed, for the job log and the UI. */
  changes: string[];
  /** Why we are not retrying, when `shouldRetry` is false. */
  reason?: string;
}

export function planRepair(
  spec: VideoGenerationSpec,
  shot: Shot,
  report: QualityReport,
  attempt: number,
): RepairPlan {
  if (attempt >= spec.quality.maxRepairAttempts) {
    return {
      shouldRetry: false,
      shot,
      changes: [],
      reason: `Reached the repair limit (${spec.quality.maxRepairAttempts} attempts) for this shot.`,
    };
  }

  // A missing or corrupt file is an infrastructure failure, not a creative one:
  // retry with a new seed and change nothing else.
  const fatal = report.issues.find((i) => i.severity === "critical" && isInfrastructural(i));
  if (fatal) {
    return {
      shouldRetry: true,
      shot: { ...shot, seed: seedForShot(spec.consistency, shot.index, attempt + 1) },
      changes: [`New seed after a provider failure (${fatal.code}).`],
    };
  }

  const changes: string[] = [];
  let next: Shot = { ...shot, seed: seedForShot(spec.consistency, shot.index, attempt + 1) };
  changes.push("New seed.");

  const codes = new Set(report.issues.map((i) => i.code));

  // A frozen clip is the one failure where *less* movement is exactly wrong.
  // Handle it before the generic temporal branch, which would reduce motion
  // further and guarantee the same result.
  if (codes.has("frozen_output")) {
    const camera = {
      ...next.camera,
      moveIntensity: clamp(Math.max(next.camera.moveIntensity * 1.8, 0.22), 0, 0.55),
      primaryMove: next.camera.primaryMove === "static" ? "push_in" : next.camera.primaryMove,
    };
    const motion = {
      ...next.motion,
      subjectMotion: next.motion.subjectMotion === "none" ? ("micro" as const) : next.motion.subjectMotion,
      notes: `${next.motion.notes} There is continuous visible movement throughout — nothing in the frame is completely frozen.`.trim(),
    };
    next = { ...next, camera, motion };
    changes.push(
      `Output was frozen; camera movement raised to ${camera.moveIntensity.toFixed(2)} and continuous motion required.`,
    );
    return { shouldRetry: true, shot: next, changes };
  }

  const failing = new Set(
    report.scores.filter((s) => s.score < 0.65).map((s) => s.dimension),
  );

  // Severe flicker needs a much harder cut than ordinary instability.
  if (codes.has("severe_flicker")) {
    const camera = {
      ...next.camera,
      moveIntensity: clamp(next.camera.moveIntensity * 0.35, 0.02, 1),
      moveSpeed: clamp(next.camera.moveSpeed * 0.5, 0.05, 1),
      secondaryMove: null,
    };
    const durationSec = Math.max(2.5, Number((next.durationSec * 0.7).toFixed(2)));
    next = { ...next, camera, durationSec };
    changes.push(
      `Severe flicker detected; movement cut to ${camera.moveIntensity.toFixed(2)} and the shot shortened to ${durationSec}s.`,
    );
    failing.delete("temporalConsistency");
  }

  // A generated clip with no visible relationship to the reference is not a
  // consistency problem — the conditioning did not take at all.
  if (codes.has("reference_mismatch")) {
    const positives = dedupe([
      "The supplied reference image defines exactly what the subject looks like; reproduce it faithfully.",
      ...next.realism.positives,
    ]);
    next = { ...next, realism: { ...next.realism, positives } };
    changes.push(
      "Reference adherence language strengthened — the previous attempt did not resemble the reference at all.",
    );
  }

  // Temporal instability: the single most reliable fix is less movement and a
  // shorter clip. Diffusion video degrades sharply with duration.
  if (failing.has("temporalConsistency")) {
    const camera = {
      ...next.camera,
      moveIntensity: clamp(next.camera.moveIntensity * 0.55, 0.02, 1),
      moveSpeed: clamp(next.camera.moveSpeed * 0.7, 0.05, 1),
      secondaryMove: null,
    };
    const durationSec = Math.max(2.5, Number((next.durationSec * 0.85).toFixed(2)));
    next = { ...next, camera, durationSec };
    changes.push(
      `Camera movement reduced to ${camera.moveIntensity.toFixed(2)} and the shot shortened to ${durationSec}s to stabilise it.`,
    );
  }

  // Identity drift: push reference adherence and re-emphasise the locks.
  if (failing.has("subjectConsistency") || failing.has("productConsistency")) {
    const positives = dedupe([
      "The subject's identity is fixed and must be identical in the first and last frame.",
      ...next.realism.positives,
    ]);
    const negatives = dedupe([
      "changing subject identity, drifting proportions, morphing between frames",
      ...next.realism.negatives,
    ]);
    next = { ...next, realism: { ...next.realism, positives, negatives } };
    changes.push("Identity-lock language strengthened in the prompt.");
  }

  // Anatomy problems: shrink the frame's exposure to the risky content.
  if (failing.has("humanAnatomy")) {
    const negatives = dedupe([
      "malformed hands, fused fingers, extra fingers, distorted limbs, warped face",
      ...next.realism.negatives,
    ]);
    const motion = { ...next.motion, subjectMotion: "micro" as const };
    next = { ...next, realism: { ...next.realism, negatives }, motion };
    changes.push("Subject motion reduced to micro-movement and anatomy negatives strengthened.");
  }

  if (failing.has("motionPlausibility")) {
    const camera = { ...next.camera, moveIntensity: clamp(next.camera.moveIntensity * 0.7, 0.02, 1) };
    next = { ...next, camera };
    changes.push("Camera movement dialled back for physical plausibility.");
  }

  return { shouldRetry: true, shot: next, changes };
}

function isInfrastructural(issue: QualityIssue): boolean {
  return ["missing_output", "empty_output", "unreadable_output"].includes(issue.code);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.map((i) => i.trim()).filter(Boolean)));
}
