import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";

const run = promisify(execFile);
/** Same as `run`, but typed for `encoding: "buffer"` so stdout is a Buffer. */
const execFileBuffer = promisify(execFile) as unknown as (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: "buffer" },
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const log = createLogger("ffmpeg");

/**
 * Thin, honest wrapper around ffmpeg/ffprobe.
 *
 * FFmpeg is optional. When it is missing the composer and the technical quality
 * evaluator degrade explicitly — they report what they could not check and what
 * command they would have run — rather than silently returning made-up numbers.
 */

export interface ToolAvailability {
  ffmpeg: boolean;
  ffprobe: boolean;
  version: string | null;
  /** Which binaries are in use: the system's, or the bundled fallback. */
  source: "system" | "bundled" | "mixed" | "none";
  remedy?: string;
}

let cachedAvailability: ToolAvailability | null = null;
/** Resolved absolute paths, so callers never re-do the lookup. */
let resolvedPaths: { ffmpeg: string | null; ffprobe: string | null } = {
  ffmpeg: null,
  ffprobe: null,
};

/**
 * Prebuilt binaries shipped with the project.
 *
 * Requiring a system FFmpeg install would make the composer a "works on my
 * machine" feature; bundling a fallback means composition works on a fresh
 * clone. A system install still wins when present — it is usually newer and
 * may have hardware acceleration the static build lacks.
 */
async function bundledPaths(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  // CJS/ESM interop differs between these two packages and between bundled and
  // external resolution, so read both the namespace and its `default`.
  const ffmpeg = await import("ffmpeg-static")
    .then((m) => {
      const mod = m as unknown as { default?: unknown } | string;
      const value = typeof mod === "string" ? mod : mod.default;
      return typeof value === "string" ? value : null;
    })
    .catch(() => null);

  const ffprobe = await import("ffprobe-static")
    .then((m) => {
      const mod = m as unknown as { path?: string; default?: { path?: string } };
      return mod.path ?? mod.default?.path ?? null;
    })
    .catch(() => null);

  return { ffmpeg, ffprobe };
}

export async function checkTools(force = false): Promise<ToolAvailability> {
  if (cachedAvailability && !force) return cachedAvailability;
  const env = getEnv();

  const system = {
    ffmpeg: await probeBinary(env.FFMPEG_PATH),
    ffprobe: await probeBinary(env.FFPROBE_PATH),
  };

  const bundled = await bundledPaths();
  const bundledOk = {
    ffmpeg: bundled.ffmpeg
      ? await probeBinary(bundled.ffmpeg)
      : { ok: false, version: null, transient: false },
    ffprobe: bundled.ffprobe
      ? await probeBinary(bundled.ffprobe)
      : { ok: false, version: null, transient: false },
  };

  const ffmpegPath = system.ffmpeg.ok ? env.FFMPEG_PATH : bundledOk.ffmpeg.ok ? bundled.ffmpeg : null;
  const ffprobePath = system.ffprobe.ok
    ? env.FFPROBE_PATH
    : bundledOk.ffprobe.ok
      ? bundled.ffprobe
      : null;

  resolvedPaths = { ffmpeg: ffmpegPath, ffprobe: ffprobePath };

  const usingSystem = system.ffmpeg.ok && system.ffprobe.ok;
  const usingBundled = !system.ffmpeg.ok && !system.ffprobe.ok && Boolean(ffmpegPath && ffprobePath);

  const availability: ToolAvailability = {
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    version: system.ffmpeg.ok ? system.ffmpeg.version : bundledOk.ffmpeg.version,
    source: usingSystem ? "system" : usingBundled ? "bundled" : ffmpegPath ? "mixed" : "none",
    remedy:
      ffmpegPath && ffprobePath
        ? undefined
        : "Install FFmpeg — on macOS: `brew install ffmpeg`. (The bundled fallback failed to run.)",
  };

  // Only memoise a definite answer. Caching a probe that merely timed out
  // would disable FFmpeg for the whole process on one unlucky spawn.
  const undecided =
    system.ffmpeg.transient ||
    system.ffprobe.transient ||
    bundledOk.ffmpeg.transient ||
    bundledOk.ffprobe.transient;
  if ((ffmpegPath && ffprobePath) || !undecided) cachedAvailability = availability;
  return availability;
}

/** Absolute path to whichever ffmpeg/ffprobe won resolution. */
export async function toolPath(tool: "ffmpeg" | "ffprobe"): Promise<string | null> {
  await checkTools();
  return resolvedPaths[tool];
}

interface ProbeResult {
  ok: boolean;
  version: string | null;
  /** True when the probe failed for a reason that says nothing about the tool. */
  transient: boolean;
}

async function probeBinary(bin: string): Promise<ProbeResult> {
  try {
    // 5s was too tight: a cold spawn under parallel load times out, and the
    // result used to be cached as "missing" for the rest of the process.
    const { stdout } = await run(bin, ["-version"], { timeout: 30_000 });
    return { ok: true, version: stdout.split("\n")[0]?.trim() ?? null, transient: false };
  } catch (error) {
    // ENOENT is a real answer: the binary is not there. A timeout or a failure
    // to fork under load is not an answer at all and must not be remembered.
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, version: null, transient: code !== "ENOENT" };
  }
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number | null;
  codec: string | null;
  bitrateKbps: number | null;
  sizeBytes: number;
}

/** Reads real media properties. Throws TOOL_MISSING when ffprobe is unavailable. */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const tools = await checkTools();
  const ffprobe = await toolPath("ffprobe");
  if (!tools.ffprobe || !ffprobe) {
    throw new StudioError("TOOL_MISSING", "ffprobe is not available, so media cannot be inspected.", {
      remedy: tools.remedy,
    });
  }

  const { stdout } = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,nb_frames,codec_name,bit_rate",
      "-show_entries",
      "format=duration,size,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_frames?: string;
      codec_name?: string;
      bit_rate?: string;
    }>;
    format?: { duration?: string; size?: string; bit_rate?: string };
  };

  const stream = parsed.streams?.[0] ?? {};
  const format = parsed.format ?? {};

  return {
    durationSec: Number(format.duration ?? 0),
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    fps: parseFrameRate(stream.avg_frame_rate),
    frameCount: stream.nb_frames ? Number(stream.nb_frames) : null,
    codec: stream.codec_name ?? null,
    bitrateKbps: toKbps(stream.bit_rate ?? format.bit_rate),
    sizeBytes: Number(format.size ?? 0),
  };
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [num, den] = raw.split("/").map(Number);
  if (!num || !den) return Number(raw) || 0;
  return Number((num / den).toFixed(3));
}

function toKbps(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
}

export interface FfmpegRunResult {
  ok: boolean;
  command: string;
  stderrTail: string;
}

/** Runs ffmpeg, returning the command line so failures are reproducible by hand. */
export async function runFfmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<FfmpegRunResult> {
  const ffmpeg = await toolPath("ffmpeg");
  const command = `${ffmpeg ?? "ffmpeg"} ${args.join(" ")}`;
  log.debug("Running ffmpeg", { command });

  if (!ffmpeg) {
    return { ok: false, command, stderrTail: "No ffmpeg binary is available." };
  }

  try {
    const { stderr } = await run(ffmpeg, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, command, stderrTail: tail(stderr) };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
    return { ok: false, command, stderrTail: tail(stderr) };
  }
}

function tail(text: string, lines = 12): string {
  return text.split("\n").slice(-lines).join("\n").trim();
}

/**
 * Runs ffmpeg and captures stdout as binary.
 *
 * Used by the quality analyzers to pull frames and raw pixel signatures
 * straight out of the pipe, with no temp files to clean up.
 */
export async function runFfmpegCapture(
  args: string[],
  timeoutMs = 60_000,
): Promise<Buffer | null> {
  const ffmpeg = await toolPath("ffmpeg");
  if (!ffmpeg) return null;

  try {
    const { stdout } = await execFileBuffer(ffmpeg, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout.length > 0 ? stdout : null;
  } catch (error) {
    log.debug("ffmpeg capture failed", { error: (error as Error).message });
    return null;
  }
}

/**
 * Runs ffmpeg and returns stdout and stderr concatenated as text.
 *
 * Both streams are needed: the `metadata=print` filter writes to **stdout**
 * when given `file=-`, while ffmpeg's own diagnostics go to stderr. Reading
 * only one silently loses the measurements.
 */
export async function runFfmpegText(args: string[], timeoutMs = 120_000): Promise<string | null> {
  const ffmpeg = await toolPath("ffmpeg");
  if (!ffmpeg) return null;

  try {
    const { stdout, stderr } = await run(ffmpeg, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    // A non-zero exit is not necessarily fatal here; whatever was printed
    // before the failure is still worth parsing.
    const e = error as { stdout?: string; stderr?: string };
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
    return combined.length > 0 ? combined : null;
  }
}

/** Extracts a still frame — used for job thumbnails and future CV evaluation. */
export async function extractFrame(
  videoPath: string,
  outputPath: string,
  atSec = 0.5,
): Promise<boolean> {
  const tools = await checkTools();
  if (!tools.ffmpeg) return false;
  const result = await runFfmpeg([
    "-y",
    "-ss",
    atSec.toFixed(2),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outputPath,
  ], 60_000);
  return result.ok;
}
