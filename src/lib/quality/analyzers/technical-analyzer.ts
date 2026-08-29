import fs from "node:fs/promises";
import { checkTools, probeMedia, type MediaInfo } from "@/lib/compose/ffmpeg";
import { clamp } from "@/lib/core/result";
import type {
  AnalyzerContribution,
  EvaluationInput,
  QualityAnalyzer,
  QualityIssue,
} from "../types";

/**
 * Technical integrity — file-level facts, all genuinely measured.
 *
 * Verifies the clip exists, decodes, and matches what was requested in
 * duration, resolution, frame rate and bitrate. These are the failures that
 * make everything downstream meaningless, so they run first and can veto.
 */
export class TechnicalAnalyzer implements QualityAnalyzer {
  readonly id = "technical";
  readonly label = "Technical integrity";
  readonly capabilities = {
    dimensions: ["technicalIntegrity" as const],
    requiresGpu: false,
    requiresModel: null,
    description:
      "Verifies with ffprobe that the file decodes and matches the requested duration, resolution, frame rate and bitrate.",
  };

  async isAvailable(): Promise<boolean> {
    return true; // file existence is checkable even with no ffmpeg
  }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    const issues: QualityIssue[] = [];
    const notCheckedNotes: string[] = [];

    const sizeBytes = await fileSize(input.videoPath);

    if (sizeBytes === null) {
      issues.push({
        code: "missing_output",
        dimension: "technicalIntegrity",
        severity: "critical",
        message: "The provider reported success but no output file exists.",
        suggestion: "Retry the shot; if it recurs, check the provider's output-path handling.",
      });
      return this.contribution(0, true, "file does not exist", issues, notCheckedNotes);
    }

    if (sizeBytes < 1024) {
      issues.push({
        code: "empty_output",
        dimension: "technicalIntegrity",
        severity: "critical",
        message: `The output file is only ${sizeBytes} bytes and cannot contain video.`,
        suggestion: "Retry the shot.",
      });
      return this.contribution(0, true, "file is empty", issues, notCheckedNotes);
    }

    const tools = await checkTools();
    if (!tools.ffprobe) {
      notCheckedNotes.push(
        "ffprobe is unavailable, so duration, resolution and frame rate could not be verified.",
      );
      return this.contribution(0.6, false, "file exists; not decoded", issues, notCheckedNotes);
    }

    let info: MediaInfo;
    try {
      info = await probeMedia(input.videoPath);
    } catch (error) {
      issues.push({
        code: "unreadable_output",
        dimension: "technicalIntegrity",
        severity: "critical",
        message: `ffprobe could not decode the output: ${(error as Error).message}`,
        suggestion: "Retry the shot; the file is likely truncated or corrupt.",
      });
      return this.contribution(0.1, true, "file does not decode", issues, notCheckedNotes);
    }

    const score = this.scoreAgainstRequest(info, input, issues);
    return this.contribution(
      score,
      true,
      `ffprobe: ${info.width}x${info.height} @ ${info.fps}fps, ${info.durationSec.toFixed(2)}s, ${info.codec ?? "unknown codec"}`,
      issues,
      notCheckedNotes,
    );
  }

  private scoreAgainstRequest(
    info: MediaInfo,
    input: EvaluationInput,
    issues: QualityIssue[],
  ): number {
    let score = 1;

    const durationDrift = Math.abs(info.durationSec - input.expected.durationSec);
    if (durationDrift > 0.75) {
      score -= clamp(durationDrift / input.expected.durationSec, 0, 0.4);
      issues.push({
        code: "duration_mismatch",
        dimension: "technicalIntegrity",
        severity: durationDrift > input.expected.durationSec * 0.4 ? "critical" : "warning",
        message: `Clip is ${info.durationSec.toFixed(2)}s but ${input.expected.durationSec.toFixed(2)}s was requested.`,
        suggestion: "Check the provider's frame-count mapping (frames = duration x fps).",
      });
    }

    if (info.width !== input.expected.width || info.height !== input.expected.height) {
      score -= 0.15;
      issues.push({
        code: "resolution_mismatch",
        dimension: "technicalIntegrity",
        severity: "warning",
        message: `Clip is ${info.width}x${info.height} but ${input.expected.width}x${input.expected.height} was requested.`,
        suggestion: "The composer will rescale, but generating at the target ratio avoids distortion.",
      });
    }

    if (info.fps > 0 && Math.abs(info.fps - input.expected.fps) > 1.5) {
      score -= 0.1;
      issues.push({
        code: "fps_mismatch",
        dimension: "technicalIntegrity",
        severity: "info",
        message: `Clip is ${info.fps}fps but ${input.expected.fps}fps was requested.`,
        suggestion: "Frame interpolation during composition can bridge the difference.",
      });
    }

    const pixels = info.width * info.height;
    if (info.bitrateKbps !== null && pixels > 0) {
      const kbpsPerMegapixel = info.bitrateKbps / (pixels / 1_000_000);
      if (kbpsPerMegapixel < 400) {
        score -= 0.12;
        issues.push({
          code: "low_bitrate",
          dimension: "technicalIntegrity",
          severity: "warning",
          message: `Bitrate is ${info.bitrateKbps}kbps for a ${info.width}x${info.height} clip — fine detail is likely destroyed by compression.`,
          suggestion: "Raise the provider's output bitrate or use a higher-quality encode preset.",
        });
      }
    }

    return clamp(Number(score.toFixed(3)), 0, 1);
  }

  private contribution(
    score: number,
    measured: boolean,
    method: string,
    issues: QualityIssue[],
    notCheckedNotes: string[],
  ): AnalyzerContribution {
    return {
      analyzerId: this.id,
      scores: [{ dimension: "technicalIntegrity", score, measured, method }],
      issues,
      confidence: measured ? "high" : "low",
      notCheckedNotes,
    };
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return null;
  }
}
