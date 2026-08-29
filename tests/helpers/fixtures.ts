import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFfmpeg, checkTools } from "@/lib/compose/ffmpeg";

/**
 * Synthetic video fixtures, rendered with the bundled FFmpeg.
 *
 * These exist so the quality analyzers are tested against real pixels rather
 * than mocks — a mocked frame-difference signal would prove nothing about
 * whether the thresholds actually discriminate.
 */

let fixtureDir: string | null = null;

export async function fixturesAvailable(): Promise<boolean> {
  return (await checkTools()).ffmpeg;
}

async function dir(): Promise<string> {
  if (!fixtureDir) {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "avs-fixtures-"));
  }
  return fixtureDir;
}

export async function cleanupFixtures(): Promise<void> {
  if (fixtureDir) {
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
    fixtureDir = null;
  }
}

async function render(name: string, lavfi: string, extra: string[] = []): Promise<string> {
  const target = path.join(await dir(), `${name}.mp4`);
  try {
    await fs.access(target);
    return target;
  } catch {
    /* not yet rendered */
  }
  const result = await runFfmpeg(
    ["-y", "-f", "lavfi", "-i", lavfi, ...extra, "-pix_fmt", "yuv420p", target],
    60_000,
  );
  if (!result.ok) throw new Error(`Fixture "${name}" failed to render: ${result.stderrTail}`);
  return target;
}

/** Continuous, healthy motion. */
export const movingClip = () => render("moving", "testsrc2=s=256x256:d=3:r=12");

/** A completely static frame held for the duration — the "frozen output" failure. */
export const frozenClip = () => render("frozen", "smptebars=s=256x256:d=3:r=12");

/** Hard alternating flash — the strobing failure. */
export const flickerClip = () =>
  render(
    "flicker",
    "color=c=blue:s=256x256:d=3:r=12,drawbox=x=0:y=0:w=256:h=256:color=white@0.6:t=fill:enable='lt(mod(n\\,2)\\,1)'",
  );

/** A still image fixture, for reference-similarity tests. */
export async function image(name: string, lavfi: string): Promise<string> {
  const target = path.join(await dir(), `${name}.png`);
  try {
    await fs.access(target);
    return target;
  } catch {
    /* not yet rendered */
  }
  const result = await runFfmpeg(["-y", "-f", "lavfi", "-i", lavfi, "-frames:v", "1", target], 30_000);
  if (!result.ok) throw new Error(`Image fixture "${name}" failed: ${result.stderrTail}`);
  return target;
}

/** A brown scene with a pale vertical object — stands in for a product shot. */
export const productImage = () =>
  image(
    "product",
    "color=c=0x3b2314:s=256x256,drawbox=x=90:y=60:w=76:h=140:color=0xd8c8a0:t=fill",
  );

/** A video whose frames resemble the product image. */
export const productClip = () =>
  render(
    "product-clip",
    "color=c=0x3b2314:s=256x256:d=2:r=12,drawbox=x=92:y=62:w=76:h=140:color=0xd8c8a0:t=fill",
  );

/** A video with no relationship to the product image. */
export const unrelatedClip = () =>
  render("unrelated", "color=c=0x1050a0:s=256x256:d=2:r=12,drawbox=x=10:y=10:w=200:h=40:color=red:t=fill");
