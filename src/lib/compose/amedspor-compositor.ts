import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioError } from "@/lib/core/errors";
import { probeMedia, runFfmpeg } from "./ffmpeg";

export interface AmedsporCompositeInput {
  videoPath: string;
  logoPath: string;
  outputPath: string;
}

const COPY = {
  line1: "Amedspor’un maç günlerinde",
  line2Lead: "Tüm ürünlerde",
  discount: "%21",
  line2Tail: "indirim",
} as const;

function filterPath(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

/**
 * Adds only clean post-production layers. The source frames are never panned,
 * zoomed or otherwise used to simulate motion.
 */
export async function compositeAmedsporTest(input: AmedsporCompositeInput): Promise<void> {
  await Promise.all([fs.access(input.videoPath), fs.access(input.logoPath)]);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });

  const source = await probeMedia(input.videoPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "amedspor-copy-"));
  const line1File = path.join(tempDir, "line1.txt");
  const line2LeadFile = path.join(tempDir, "line2-lead.txt");
  const discountFile = path.join(tempDir, "discount.txt");
  const line2TailFile = path.join(tempDir, "line2-tail.txt");
  const font = path.resolve("node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");

  await Promise.all([
    fs.writeFile(line1File, COPY.line1, "utf8"),
    fs.writeFile(line2LeadFile, COPY.line2Lead, "utf8"),
    fs.writeFile(discountFile, COPY.discount, "utf8"),
    fs.writeFile(line2TailFile, COPY.line2Tail, "utf8"),
    fs.access(font),
  ]);

  const show = "enable='gte(t,1.15)'";
  const fontArg = `fontfile='${filterPath(font)}'`;
  const text = (file: string, size: number, x: number, y: number, color = "white") =>
    `drawtext=${fontArg}:textfile='${filterPath(file)}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:${show}`;

  // Layout is pinned to the Instagram Reels safe area. The app draws its own
  // caption and action rail over roughly the bottom 320px and the right 120px,
  // so every element of the campaign lock-up — and %21 above all, since it is
  // the emphasis the campaign is built on — has to sit clear of y=1600.
  const baseFilters = [
    "[0:v]scale=1080:1920:flags=lanczos,fps=30,setsar=1",
    // Two stacked scrims approximate a gradient: the footage stays readable at
    // the top of the block while %21 gets enough density to hold contrast
    // against a pale cup behind it.
    `drawbox=x=0:y=1010:w=1080:h=160:color=black@0.34:t=fill:${show}`,
    `drawbox=x=0:y=1170:w=1080:h=560:color=black@0.68:t=fill:${show}`,
    `drawbox=x=60:y=80:w=260:h=260:color=white@0.92:t=fill:${show}`,
    text(line1File, 52, 78, 1130),
    text(line2LeadFile, 68, 78, 1215),
    text(discountFile, 238, 68, 1300, "0xF4F2E9"),
    text(line2TailFile, 88, 520, 1460),
    `drawbox=x=78:y=1600:w=870:h=10:color=0xB31F2C@0.95:t=fill:${show}`,
  ].join(",");
  const filters = [
    `${baseFilters}[base]`,
    "[1:v]scale=210:210:force_original_aspect_ratio=decrease,format=rgba[logo]",
    `[base][logo]overlay=85:105:${show}[v]`,
  ].join(";");

  const result = await runFfmpeg(
    [
      "-y",
      "-i",
      input.videoPath,
      "-loop",
      "1",
      "-i",
      input.logoPath,
      "-filter_complex",
      filters,
      "-map",
      "[v]",
      "-t",
      source.durationSec.toFixed(4),
      "-an",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-preset",
      "slow",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      input.outputPath,
    ],
    10 * 60_000,
  );

  await Promise.all([
    fs.unlink(line1File).catch(() => undefined),
    fs.unlink(line2LeadFile).catch(() => undefined),
    fs.unlink(discountFile).catch(() => undefined),
    fs.unlink(line2TailFile).catch(() => undefined),
  ]);
  await fs.rmdir(tempDir).catch(() => undefined);

  if (!result.ok) {
    throw new StudioError("COMPOSE_FAILED", "Amedspor post-production composite failed.", {
      details: result.stderrTail,
      remedy: result.command,
    });
  }
}

export const AMEDSPOR_COMPOSITE_COPY = COPY;
