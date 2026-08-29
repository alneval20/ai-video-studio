import path from "node:path";
import { createLogger } from "@/lib/core/logger";
import type { VideoGenerationSpec } from "@/lib/spec/spec";
import { ensureDir, fileExists } from "@/lib/storage/paths";
import { escapeDrawText } from "./drawtext";
import { checkTools, extractFrame, runFfmpeg } from "./ffmpeg";

const log = createLogger("composer");

/**
 * The final composition layer.
 *
 * Its job is strictly post-production — concatenate the generated clips, fit
 * them to the delivery frame, apply transitions, overlays, branding and audio,
 * and encode. It is NOT a visual generation engine: it never invents imagery,
 * and if there are no generated clips there is nothing for it to do.
 *
 * FFmpeg is optional. Without it the composer returns a plan containing the
 * exact command it would have run, so nothing is silently faked.
 */

export interface ComposeInput {
  spec: VideoGenerationSpec;
  /** Absolute paths to the accepted clip for each shot, in order. */
  clipPaths: string[];
  outputPath: string;
  /** Absolute path to a logo image, if branding is enabled. */
  logoPath?: string | null;
  /** Absolute path to a music track, if any. */
  musicPath?: string | null;
}

export interface ComposeResult {
  status: "composed" | "skipped" | "failed";
  outputPath: string | null;
  posterPath: string | null;
  /** The exact ffmpeg invocation, for reproduction and debugging. */
  command: string | null;
  notes: string[];
  error?: string;
}

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const notes: string[] = [];
  const { spec } = input;
  const { width, height, fps } = spec.delivery.export;

  const usable: string[] = [];
  for (const clip of input.clipPaths) {
    if (await fileExists(clip)) usable.push(clip);
    else notes.push(`Skipped a missing clip: ${path.basename(clip)}.`);
  }

  if (usable.length === 0) {
    return {
      status: "skipped",
      outputPath: null,
      posterPath: null,
      command: null,
      notes: [...notes, "No usable clips were produced, so there was nothing to compose."],
    };
  }

  const { args, command: _plannedArgs } = buildFfmpegArgs({ ...input, clipPaths: usable }, notes);

  const tools = await checkTools();
  if (!tools.ffmpeg) {
    return {
      status: "skipped",
      outputPath: null,
      posterPath: null,
      command: `ffmpeg ${args.join(" ")}`,
      notes: [
        ...notes,
        "FFmpeg is not installed, so the clips were left unjoined. Install it with `brew install ffmpeg` and re-run composition — the exact command is recorded above.",
      ],
    };
  }

  await ensureDir(path.dirname(input.outputPath));
  const result = await runFfmpeg(args, 15 * 60_000);

  if (!result.ok) {
    log.error("Composition failed.", { command: result.command });
    return {
      status: "failed",
      outputPath: null,
      posterPath: null,
      command: result.command,
      notes,
      error: result.stderrTail || "ffmpeg exited with an error.",
    };
  }

  const posterPath = `${input.outputPath.replace(/\.mp4$/, "")}-poster.jpg`;
  const posterOk = await extractFrame(input.outputPath, posterPath, 0.6);

  notes.push(
    `Composed ${usable.length} clip${usable.length === 1 ? "" : "s"} into ${width}x${height} @ ${fps}fps.`,
  );

  return {
    status: "composed",
    outputPath: input.outputPath,
    posterPath: posterOk ? posterPath : null,
    command: result.command,
    notes,
  };
}

/**
 * Builds the filter graph.
 *
 * Each clip is scaled to *cover* the delivery frame and centre-cropped, so a
 * 9:16 export from a 16:9 generation never letterboxes or stretches — the
 * single most common way social exports look amateur.
 */
function buildFfmpegArgs(input: ComposeInput, notes: string[]): { args: string[]; command: string } {
  const { spec, clipPaths } = input;
  const { width, height, fps } = spec.delivery.export;

  const args: string[] = ["-y"];
  for (const clip of clipPaths) args.push("-i", clip);

  const logoIndex = input.logoPath ? clipPaths.length : -1;
  if (input.logoPath) args.push("-i", input.logoPath);

  const musicIndex = input.musicPath ? clipPaths.length + (input.logoPath ? 1 : 0) : -1;
  if (input.musicPath) args.push("-i", input.musicPath);

  const filters: string[] = [];

  // 1. Normalise every clip to the export frame.
  clipPaths.forEach((_, i) => {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  });

  // 2. Join them.
  let last: string;
  if (clipPaths.length === 1) {
    last = "v0";
  } else {
    const inputs = clipPaths.map((_, i) => `[v${i}]`).join("");
    filters.push(`${inputs}concat=n=${clipPaths.length}:v=1:a=0[joined]`);
    last = "joined";
  }

  // 3. Opening/closing fades where the style calls for them.
  const firstShot = spec.shots[0];
  const totalDuration = spec.delivery.totalDurationSec;
  if (firstShot?.transitionIn === "fade_from_black") {
    filters.push(`[${last}]fade=t=in:st=0:d=0.4[faded_in]`);
    last = "faded_in";
    notes.push("Added a 0.4s fade from black to open.");
  }
  if (totalDuration > 3) {
    const start = Math.max(0, totalDuration - 0.4).toFixed(2);
    filters.push(`[${last}]fade=t=out:st=${start}:d=0.4[faded_out]`);
    last = "faded_out";
  }

  // 4. Captions.
  const captions = spec.post.captions.enabled ? spec.post.captions.lines : [];
  captions.forEach((line, i) => {
    const start = line.atSec.toFixed(2);
    const end = (line.atSec + line.holdSec).toFixed(2);
    const size = Math.round(width / 22);
    filters.push(
      `[${last}]drawtext=text='${escapeDrawText(line.text)}':fontcolor=white:fontsize=${size}` +
        `:borderw=${Math.max(2, Math.round(size / 14))}:bordercolor=black@0.6` +
        `:x=(w-text_w)/2:y=h*0.78:enable='between(t,${start},${end})'[cap${i}]`,
    );
    last = `cap${i}`;
  });
  if (captions.length > 0) notes.push(`Burned in ${captions.length} caption line(s).`);

  // 5. Branding overlay.
  if (logoIndex >= 0 && spec.post.branding.placement !== "none") {
    const logoWidth = Math.round(width * 0.22);
    filters.push(`[${logoIndex}:v]scale=${logoWidth}:-1[logo]`);
    filters.push(`[${last}][logo]overlay=${logoPosition(spec.post.branding.placement)}[branded]`);
    last = "branded";
    notes.push(`Overlaid the brand logo (${spec.post.branding.placement.replace(/_/g, " ")}).`);
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${last}]`);

  // 6. Audio.
  if (musicIndex >= 0) {
    args.push("-map", `${musicIndex}:a`, "-shortest", "-c:a", "aac", "-b:a", "192k");
    notes.push("Attached the music track.");
  } else {
    args.push("-an");
    notes.push("No audio track — the export is silent.");
  }

  // 7. Encode for social delivery.
  args.push(
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-r",
    String(fps),
    "-movflags",
    "+faststart",
    input.outputPath,
  );

  return { args, command: `ffmpeg ${args.join(" ")}` };
}

function logoPosition(placement: string): string {
  switch (placement) {
    case "top_left":
      return "W*0.05:H*0.05";
    case "bottom_right":
      return "W-w-W*0.05:H-h-H*0.08";
    case "bottom_center":
    default:
      return "(W-w)/2:H-h-H*0.08";
  }
}

