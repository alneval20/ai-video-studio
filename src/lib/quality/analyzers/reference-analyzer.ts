import { checkTools } from "@/lib/compose/ffmpeg";
import { clamp } from "@/lib/core/result";
import {
  frameSignature,
  imageSignature,
  sampleTimestamps,
  signatureSimilarity,
} from "../frame-analysis";
import type {
  AnalyzerContribution,
  EvaluationInput,
  QualityAnalyzer,
  QualityIssue,
} from "../types";

/**
 * Reference adherence and within-clip identity drift — both REAL measurements.
 *
 * Two independent things are measured from the same signature primitive:
 *
 *   1. REFERENCE SIMILARITY — how close the generated frames are to the
 *      supplied identity reference. Catches "the model generated a completely
 *      different product".
 *   2. SUBJECT DRIFT — how much the frames diverge from *each other* over the
 *      clip, beyond what the requested camera movement accounts for. Catches
 *      "it started as the right cup and slowly became something else", which
 *      is the characteristic failure of longer video generations.
 *
 * HONEST LIMITS: this is a 16x16 downscaled colour/layout fingerprint. It sees
 * gross shape, palette and composition. It CANNOT read a logo, count fingers,
 * or judge whether a texture looks edible. Those need the vision analyzer.
 * The `method` strings say so, and the scores are reported at medium
 * confidence, not high.
 */
export class ReferenceAnalyzer implements QualityAnalyzer {
  readonly id = "signature-similarity";
  readonly label = "Reference & drift (perceptual signature)";
  readonly capabilities = {
    dimensions: [
      "referenceSimilarity" as const,
      "subjectConsistency" as const,
      "productConsistency" as const,
    ],
    requiresGpu: false,
    requiresModel: null,
    description:
      "Compares a downscaled colour/layout fingerprint of sampled frames against the reference image and against each other. Sees gross shape and palette, not fine detail.",
  };

  async isAvailable(input: EvaluationInput): Promise<boolean> {
    // Drift can be measured with no reference at all, so ffmpeg is the only
    // hard requirement.
    return (await checkTools()).ffmpeg && input.expected.durationSec > 0;
  }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    const issues: QualityIssue[] = [];
    const notCheckedNotes: string[] = [];

    const timestamps = sampleTimestamps(input.expected.durationSec, 5);
    const frames = (
      await Promise.all(timestamps.map((t) => frameSignature(input.videoPath, t)))
    ).filter((s): s is number[] => s !== null);

    if (frames.length < 2) {
      return {
        analyzerId: this.id,
        scores: [],
        issues: [],
        confidence: "low",
        notCheckedNotes: ["Could not sample enough frames to compare."],
      };
    }

    const scores: AnalyzerContribution["scores"] = [];

    // --- drift within the clip -------------------------------------------
    const drift = this.measureDrift(frames);
    const driftScore = this.scoreDrift(drift, input, issues);

    scores.push({
      dimension: "subjectConsistency",
      score: driftScore,
      measured: true,
      method: `first-to-last frame signature similarity ${drift.firstToLast} across ${frames.length} samples`,
    });

    if (input.context.hasProduct) {
      scores.push({
        dimension: "productConsistency",
        score: driftScore,
        measured: true,
        method: `frame-to-frame signature stability (gross shape and palette only, not branding detail)`,
      });
      notCheckedNotes.push(
        "Product branding legibility was not assessed — the signature comparison cannot resolve lettering.",
      );
    }

    // --- similarity to the reference -------------------------------------
    if (input.context.referencePaths.length === 0) {
      notCheckedNotes.push(
        "No identity reference was attached, so reference similarity could not be measured.",
      );
    } else {
      const similarity = await this.measureReferenceSimilarity(
        input.context.referencePaths,
        frames,
      );

      if (similarity === null) {
        notCheckedNotes.push("Reference images could not be read for comparison.");
      } else {
        scores.push({
          dimension: "referenceSimilarity",
          score: this.scoreSimilarity(similarity, issues),
          measured: true,
          method: `mean colour/layout correlation ${similarity.mean} against ${input.context.referencePaths.length} reference image(s)`,
        });
      }
    }

    return {
      analyzerId: this.id,
      scores,
      issues,
      // Medium, not high: the signal is real but coarse.
      confidence: "medium",
      notCheckedNotes,
    };
  }

  // ------------------------------------------------------------------ drift

  private measureDrift(frames: number[][]): { firstToLast: number; minAdjacent: number } {
    const firstToLast = signatureSimilarity(frames[0], frames[frames.length - 1]);

    let minAdjacent = 1;
    for (let i = 1; i < frames.length; i++) {
      minAdjacent = Math.min(minAdjacent, signatureSimilarity(frames[i - 1], frames[i]));
    }

    return { firstToLast, minAdjacent };
  }

  private scoreDrift(
    drift: { firstToLast: number; minAdjacent: number },
    input: EvaluationInput,
    issues: QualityIssue[],
  ): number {
    // A shot that was *asked* to move a lot will legitimately look different at
    // the end. Scale the expectation by the requested camera movement so a
    // pull-out is not penalised for revealing new scenery.
    const movementAllowance = clamp(input.context.cameraMoveIntensity, 0, 1) * 0.35;
    const expectedFloor = clamp(0.82 - movementAllowance, 0.4, 0.9);

    if (drift.firstToLast >= expectedFloor) {
      return clamp(Number((0.75 + drift.firstToLast * 0.25).toFixed(3)), 0, 1);
    }

    const shortfall = expectedFloor - drift.firstToLast;
    const score = clamp(0.75 - shortfall * 1.6, 0.05, 1);

    issues.push({
      code: "subject_drift",
      dimension: "subjectConsistency",
      severity: shortfall > 0.25 ? "critical" : "warning",
      message: `The frame changes more over the clip than the requested camera movement accounts for (first-to-last similarity ${drift.firstToLast}, expected at least ${expectedFloor.toFixed(2)}) — the subject is likely drifting.`,
      suggestion:
        "Raise consistency strength, shorten the shot, or attach an identity reference image.",
    });

    return Number(score.toFixed(3));
  }

  // ------------------------------------------------------------- similarity

  private async measureReferenceSimilarity(
    referencePaths: string[],
    frames: number[][],
  ): Promise<{ mean: number; best: number } | null> {
    const refSignatures = (
      await Promise.all(referencePaths.map((p) => imageSignature(p)))
    ).filter((s): s is number[] => s !== null);

    if (refSignatures.length === 0) return null;

    // For each frame, take its best match among the references — with several
    // references, a frame only needs to resemble the relevant one.
    const perFrame = frames.map((frame) =>
      Math.max(...refSignatures.map((ref) => signatureSimilarity(ref, frame))),
    );

    return {
      mean: Number((perFrame.reduce((a, b) => a + b, 0) / perFrame.length).toFixed(4)),
      best: Number(Math.max(...perFrame).toFixed(4)),
    };
  }

  private scoreSimilarity(
    similarity: { mean: number; best: number },
    issues: QualityIssue[],
  ): number {
    // Calibration note: a generated scene *containing* the reference product
    // will not correlate as strongly as two crops of the same photo, because
    // the frame includes an environment the reference does not. Around 0.3 is
    // a plausible match; below ~0.12 there is no visible relationship.
    if (similarity.mean < 0.12) {
      issues.push({
        code: "reference_mismatch",
        dimension: "referenceSimilarity",
        severity: "critical",
        message: `The generated frames bear little colour or layout resemblance to the reference image (correlation ${similarity.mean}).`,
        suggestion:
          "Raise reference strength, or switch to an image-to-video provider that can condition on the reference directly.",
      });
      return clamp(similarity.mean * 2, 0.05, 0.35);
    }

    if (similarity.mean < 0.25) {
      issues.push({
        code: "weak_reference_adherence",
        dimension: "referenceSimilarity",
        severity: "warning",
        message: `Only a weak resemblance to the reference image (correlation ${similarity.mean}).`,
        suggestion: "Raise reference strength or use an image-to-video model.",
      });
    }

    // Map the useful 0.12–0.75 band onto 0.35–1.0.
    return clamp(Number((0.35 + ((similarity.mean - 0.12) / 0.63) * 0.65).toFixed(3)), 0, 1);
  }
}
