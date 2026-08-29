import { checkTools } from "@/lib/compose/ffmpeg";
import { clamp } from "@/lib/core/result";
import { measureTemporalSignal, type TemporalSignal } from "../frame-analysis";
import type {
  AnalyzerContribution,
  EvaluationInput,
  QualityAnalyzer,
  QualityIssue,
} from "../types";

/**
 * Temporal stability — a REAL measurement, not a prior.
 *
 * Reads the per-frame difference signal off the actual pixels and derives
 * three things video models genuinely get wrong:
 *
 *   1. FROZEN OUTPUT — near-zero change across the clip. A common and totally
 *      silent failure: the file is valid, the duration is right, and nothing
 *      moves. Nothing else in the system catches this.
 *   2. FLICKER — very high average change, or change that swings wildly frame
 *      to frame. This is the strobing/popping artefact.
 *   3. DISCONTINUITIES — isolated spikes far above the clip's own baseline,
 *      i.e. the content jumps rather than moves.
 *
 * Thresholds are calibrated against synthetic fixtures (see
 * tests/temporal-analyzer.test.ts): frozen ≈ 0.2, gentle motion ≈ 0.6,
 * healthy motion ≈ 5, hard alternating flicker ≈ 96, on a 0..255 scale.
 */
export class TemporalAnalyzer implements QualityAnalyzer {
  readonly id = "temporal-signal";
  readonly label = "Temporal stability";
  readonly capabilities = {
    dimensions: ["temporalConsistency" as const, "motionPlausibility" as const],
    requiresGpu: false,
    requiresModel: null,
    description:
      "Measures per-frame change with FFmpeg to detect frozen output, flicker and hard discontinuities.",
  };

  async isAvailable(): Promise<boolean> {
    return (await checkTools()).ffmpeg;
  }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    const signal = await measureTemporalSignal(input.videoPath);

    if (!signal) {
      return {
        analyzerId: this.id,
        scores: [],
        issues: [],
        confidence: "low",
        notCheckedNotes: ["Temporal analysis could not read a frame-difference signal from the clip."],
      };
    }

    const issues: QualityIssue[] = [];
    const temporal = this.scoreTemporal(signal, input, issues);
    const motion = this.scoreMotion(signal, issues);

    return {
      analyzerId: this.id,
      scores: [
        {
          dimension: "temporalConsistency",
          score: temporal,
          measured: true,
          method: `frame-difference signal over ${signal.frameCount} frames (mean ${signal.meanDelta}, σ ${signal.stdDelta}, ${signal.spikeCount} spike(s))`,
        },
        {
          dimension: "motionPlausibility",
          score: motion,
          measured: true,
          method: `motion magnitude ${signal.meanDelta} with variability ${signal.variability}`,
        },
      ],
      issues,
      confidence: "high",
      notCheckedNotes: [],
    };
  }

  private scoreTemporal(
    signal: TemporalSignal,
    input: EvaluationInput,
    issues: QualityIssue[],
  ): number {
    let score = 1;

    // --- frozen ----------------------------------------------------------
    // Below 0.35 mean delta there is essentially no change between frames.
    if (signal.meanDelta < 0.35) {
      // A deliberately static shot is legitimate — but only if the camera was
      // also asked to hold still. The spec tells us which case this is.
      const intentionallyStill =
        input.context.cameraMoveIntensity !== undefined &&
        input.context.cameraMoveIntensity < 0.08 &&
        input.context.subjectMotion === "none";

      if (!intentionallyStill) {
        score -= 0.55;
        issues.push({
          code: "frozen_output",
          dimension: "temporalConsistency",
          severity: "critical",
          message: `The clip barely changes between frames (mean frame difference ${signal.meanDelta} of 255) — it is effectively a still image, not video.`,
          suggestion:
            "Increase motion in the prompt, raise the camera movement budget, or check that the provider is producing all requested frames.",
        });
      }
    }

    // --- flicker ---------------------------------------------------------
    // Sustained huge deltas mean the whole frame is changing every frame.
    if (signal.meanDelta > 45) {
      score -= 0.5;
      issues.push({
        code: "severe_flicker",
        dimension: "temporalConsistency",
        severity: "critical",
        message: `Extreme frame-to-frame change (mean ${signal.meanDelta} of 255) — the clip is strobing rather than moving.`,
        suggestion: "Reduce camera movement and shorten the shot; raise consistency strength.",
      });
    } else if (signal.meanDelta > 22) {
      score -= 0.25;
      issues.push({
        code: "high_frame_change",
        dimension: "temporalConsistency",
        severity: "warning",
        message: `Very high frame-to-frame change (mean ${signal.meanDelta} of 255), which usually reads as instability.`,
        suggestion: "Reduce camera movement intensity.",
      });
    }

    // --- unevenness ------------------------------------------------------
    // Motion that is present but wildly uneven reads as popping.
    if (signal.meanDelta >= 0.35 && signal.variability > 1.3) {
      score -= clamp((signal.variability - 1.3) * 0.25, 0, 0.3);
      issues.push({
        code: "uneven_motion",
        dimension: "temporalConsistency",
        severity: "warning",
        message: `Motion is uneven (variability ${signal.variability}) — the clip changes in bursts rather than continuously.`,
        suggestion: "Lower the camera move speed so the movement is distributed across the shot.",
      });
    }

    // --- discontinuities --------------------------------------------------
    if (signal.spikeCount > 0) {
      score -= clamp(signal.spikeCount * 0.06, 0, 0.25);

      // Severity needs BOTH frequency and magnitude. A statistical outlier of
      // 9/255 is a 4% change — visible to the maths, invisible to a viewer.
      // Only a jump large enough to read as a cut earns `critical`.
      const large = signal.maxDelta > 25;
      issues.push({
        code: "temporal_discontinuity",
        dimension: "temporalConsistency",
        severity: large && signal.spikeCount > 3 ? "critical" : "warning",
        message: `${signal.spikeCount} frame(s) jump sharply from their neighbours (largest ${signal.maxDelta} of 255).`,
        suggestion: "Regenerate with a different seed; isolated jumps rarely repeat.",
      });
    }

    return clamp(Number(score.toFixed(3)), 0, 1);
  }

  /** Movement that is physically plausible: present, but not violent. */
  private scoreMotion(signal: TemporalSignal, issues: QualityIssue[]): number {
    if (signal.meanDelta < 0.35) return 0.45; // nothing moves; already reported
    if (signal.meanDelta > 45) return 0.2;

    // A broad healthy band, tapering at both ends.
    let score: number;
    if (signal.meanDelta < 1) score = 0.72;
    else if (signal.meanDelta <= 12) score = 0.95;
    else if (signal.meanDelta <= 22) score = 0.8;
    else score = 0.55;

    if (signal.variability > 2) {
      score -= 0.15;
      issues.push({
        code: "erratic_motion",
        dimension: "motionPlausibility",
        severity: "warning",
        message: `Movement is erratic (variability ${signal.variability}) rather than physically smooth.`,
        suggestion: "Reduce camera movement intensity and speed.",
      });
    }

    return clamp(Number(score.toFixed(3)), 0, 1);
  }
}
