import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AMEDSPOR_ASSETS,
  createAmedsporI2vTestRequest,
  prepareAmedsporInitFrame,
} from "@/lib/campaigns/amedspor-i2v-test";
import { compositeAmedsporTest } from "@/lib/compose/amedspor-compositor";
import { checkTools, probeMedia } from "@/lib/compose/ffmpeg";
import { wanFrameCount } from "@/lib/providers/remote-worker/remote-worker-provider";
import { cleanupFixtures, movingClip } from "./helpers/fixtures";

let available = false;
let tempDir = "";

beforeAll(async () => {
  available = (await checkTools()).ffmpeg;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "amedspor-i2v-test-"));
});

afterAll(async () => {
  await cleanupFixtures();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Amedspor three-second production path", () => {
  it("prepares the real product reference as a native 720x1280 init frame", async () => {
    if (!available) return;
    const target = path.join(tempDir, "init.png");
    await prepareAmedsporInitFrame(target);
    const info = await probeMedia(target);
    expect(info.width).toBe(720);
    expect(info.height).toBe(1280);

    const request = createAmedsporI2vTestRequest(target, path.join(tempDir, "raw.mp4"));
    expect(request.references.filter((reference) => reference.usage === "init_frame")).toHaveLength(1);
    expect(request.references[0]?.path).toBe(target);
    expect(request.width).toBe(720);
    expect(request.height).toBe(1280);
    expect(request.fps).toBe(24);
    expect(wanFrameCount(request.durationSec, request.fps)).toBe(73);
    expect(request.prompt).not.toContain("%21");
    expect(request.prompt).not.toContain("Amedspor’un");
  }, 120_000);

  it("exports clean post layers to 1080x1920 30 fps H.264 without changing the official logo", async () => {
    if (!available) return;
    const before = await fs.readFile(AMEDSPOR_ASSETS.logo);
    const output = path.join(tempDir, "composited.mp4");

    await compositeAmedsporTest({
      videoPath: await movingClip(),
      logoPath: AMEDSPOR_ASSETS.logo,
      outputPath: output,
    });

    const info = await probeMedia(output);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.fps).toBe(30);
    expect(info.codec).toBe("h264");
    expect(await fs.readFile(AMEDSPOR_ASSETS.logo)).toEqual(before);
  }, 180_000);
});
