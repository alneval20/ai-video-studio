import { runFfmpegCapture, runFfmpegText } from "@/lib/compose/ffmpeg";
import { createLogger } from "@/lib/core/logger";

const log = createLogger("quality:frames");

/**
 * Measurement primitives built on FFmpeg.
 *
 * Everything here produces a REAL number read off the actual pixels. No GPU,
 * no model, no API key. These are what let the quality engine stop guessing
 * about temporal stability and reference adherence.
 */

// --------------------------------------------------------------------------
// Temporal signal
// --------------------------------------------------------------------------

export interface TemporalSignal {
  /** Per-frame mean absolute difference from the previous frame, 0..255. */
  perFrame: number[];
  /** Average frame-to-frame change. Near zero means the video is frozen. */
  meanDelta: number;
  /** Standard deviation of the deltas. */
  stdDelta: number;
  /** std / mean — how uneven the motion is. High means jerky or popping. */
  variability: number;
  /** Frames whose delta exceeds mean + 3σ: hard discontinuities. */
  spikeCount: number;
  /** Largest single frame-to-frame jump. */
  maxDelta: number;
  frameCount: number;
}

/**
 * Measures frame-to-frame change across the clip.
 *
 * `tblend=all_mode=difference` produces a frame that is the absolute
 * difference between each pair of consecutive frames; `signalstats` then
 * reports its mean luma. So each YAVG is literally "how much did this frame
 * change from the last one", on a 0..255 scale.
 *
 * Empirically (validated against synthetic fixtures): a frozen clip sits near
 * 0.2, gentle motion around 0.6, healthy motion around 5, and a hard
 * every-other-frame flicker around 96.
 */
export async function measureTemporalSignal(videoPath: string): Promise<TemporalSignal | null> {
  const output = await runFfmpegText([
    "-v",
    "error",
    "-i",
    videoPath,
    "-vf",
    "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
    "-f",
    "null",
    "-",
  ]);

  if (output === null) return null;

  const perFrame = Array.from(output.matchAll(/YAVG=([0-9.]+)/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));

  if (perFrame.length < 2) {
    log.debug("Temporal analysis produced too few samples.", { samples: perFrame.length });
    return null;
  }

  const n = perFrame.length;
  const meanDelta = perFrame.reduce((a, b) => a + b, 0) / n;
  const variance = perFrame.reduce((sum, x) => sum + (x - meanDelta) ** 2, 0) / n;
  const stdDelta = Math.sqrt(variance);
  const threshold = meanDelta + 3 * stdDelta;

  return {
    perFrame,
    meanDelta: round(meanDelta),
    stdDelta: round(stdDelta),
    variability: round(meanDelta > 0.01 ? stdDelta / meanDelta : 0),
    spikeCount: perFrame.filter((d) => d > threshold && d > 1).length,
    maxDelta: round(Math.max(...perFrame)),
    frameCount: n,
  };
}

// --------------------------------------------------------------------------
// Perceptual signatures
// --------------------------------------------------------------------------

/** Grid size for the downscaled colour signature. 16x16 RGB = 768 samples. */
const SIGNATURE_EDGE = 16;

/**
 * Reduces an image (or one video frame) to a small RGB grid.
 *
 * This is a coarse colour/layout fingerprint. It reliably distinguishes "the
 * same object in the same place" from "something else entirely". It does NOT
 * see fine detail — it cannot tell a correct logo from a garbled one. The
 * evaluator that uses it says so explicitly.
 */
export async function imageSignature(imagePath: string): Promise<number[] | null> {
  const raw = await runFfmpegCapture([
    "-v",
    "error",
    "-i",
    imagePath,
    "-vf",
    `scale=${SIGNATURE_EDGE}:${SIGNATURE_EDGE}:force_original_aspect_ratio=disable,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  return toSignature(raw);
}

/** Same, for a single frame of a video at `atSec`. */
export async function frameSignature(
  videoPath: string,
  atSec: number,
): Promise<number[] | null> {
  const raw = await runFfmpegCapture([
    "-v",
    "error",
    "-ss",
    atSec.toFixed(3),
    "-i",
    videoPath,
    "-vf",
    `scale=${SIGNATURE_EDGE}:${SIGNATURE_EDGE}:force_original_aspect_ratio=disable,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  return toSignature(raw);
}

function toSignature(raw: Buffer | null): number[] | null {
  const expected = SIGNATURE_EDGE * SIGNATURE_EDGE * 3;
  if (!raw || raw.length < expected) return null;
  return Array.from(raw.subarray(0, expected));
}

/**
 * Normalised cross-correlation of two signatures, mapped to 0..1.
 *
 * Mean-centring makes it tolerant of overall brightness differences (a darker
 * grade of the same scene still matches) while staying sensitive to changes in
 * colour distribution and layout.
 */
export function signatureSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;

  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }

  const den = Math.sqrt(devA) * Math.sqrt(devB);
  if (den === 0) return 0;

  // Correlation is -1..1; a negative correlation is "no resemblance", not
  // "inverted resemblance", so the floor is 0.
  return round(Math.max(0, num / den), 4);
}

// --------------------------------------------------------------------------
// Frame extraction (for vision models)
// --------------------------------------------------------------------------

export interface SampledFrame {
  atSec: number;
  /** PNG bytes, base64-encoded, ready for a vision API. */
  base64: string;
}

/** Evenly spaced timestamps, avoiding the very first and last frames. */
export function sampleTimestamps(durationSec: number, count: number): number[] {
  if (count <= 1) return [durationSec / 2];
  const usable = Math.max(0.2, durationSec - 0.3);
  return Array.from({ length: count }, (_, i) =>
    Number((0.15 + (usable * i) / (count - 1)).toFixed(3)),
  );
}

/** Extracts frames as downscaled PNGs. `maxEdge` keeps vision payloads small. */
export async function sampleFrames(
  videoPath: string,
  timestamps: number[],
  maxEdge = 512,
): Promise<SampledFrame[]> {
  const frames: SampledFrame[] = [];

  for (const atSec of timestamps) {
    const raw = await runFfmpegCapture([
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      videoPath,
      "-vf",
      `scale='min(${maxEdge},iw)':-2`,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "-",
    ]);
    if (raw) frames.push({ atSec, base64: raw.toString("base64") });
  }

  return frames;
}

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
