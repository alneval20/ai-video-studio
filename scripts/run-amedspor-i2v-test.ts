/** Run the real, three-second native-vertical Wan 2.2 I2V proof. */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  AMEDSPOR_ASSETS,
  AMEDSPOR_TEST_HEIGHT,
  AMEDSPOR_TEST_WIDTH,
  createAmedsporI2vTestRequest,
  prepareAmedsporInitFrame,
} from "@/lib/campaigns/amedspor-i2v-test";
import { compositeAmedsporTest } from "@/lib/compose/amedspor-compositor";
import { probeMedia } from "@/lib/compose/ffmpeg";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { getProvider } from "@/lib/providers/registry";
import { wanFrameCount, WAN_I2V_FPS } from "@/lib/providers/remote-worker/remote-worker-provider";
import { getEvaluator, measureTemporalSignal } from "@/lib/quality";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const outputDir = path.join(getEnv().outputDir, "amedspor-i2v-test");
  const initFramePath = path.join(outputDir, "init-frame-720x1280.png");
  const rawPath = path.join(outputDir, "raw-wan22-i2v.mp4");
  const finalPath = path.join(outputDir, "composited-1080x1920.mp4");
  await fs.mkdir(outputDir, { recursive: true });

  await prepareAmedsporInitFrame(initFramePath);

  const provider = getProvider("remote-worker");
  if (!provider.capabilities.producesRealVideo) {
    throw new StudioError("PROVIDER_NOT_CONFIGURED", "The test refuses mock or simulated output.");
  }

  const health = await provider.health();
  if (!health.available) {
    throw new StudioError("GPU_REQUIRED", health.detail, { remedy: health.remedy });
  }

  const request = createAmedsporI2vTestRequest(initFramePath, rawPath);
  const result = await provider.generate(request, {
    onProgress: (fraction: number, stage?: string) => {
      console.log(`[wan] ${Math.round(fraction * 100)}%${stage ? ` — ${stage}` : ""}`);
    },
  });
  if (!result.isRealGeneration || !result.outputPath) {
    throw new StudioError("PROVIDER_FAILED", "The provider did not return genuine generated footage.");
  }

  const raw = await probeMedia(rawPath);
  const expectedFrames = wanFrameCount(request.durationSec, request.fps);
  if (
    raw.width !== AMEDSPOR_TEST_WIDTH ||
    raw.height !== AMEDSPOR_TEST_HEIGHT ||
    raw.fps !== WAN_I2V_FPS ||
    raw.codec !== "h264" ||
    (raw.frameCount !== null && raw.frameCount !== expectedFrames)
  ) {
    throw new StudioError(
      "QUALITY_REJECTED",
      `Raw artifact violates the Wan profile: ${raw.width}x${raw.height}, ${raw.fps} fps, ${raw.frameCount ?? "?"} frames, ${raw.codec ?? "unknown codec"}.`,
    );
  }

  const temporal = await measureTemporalSignal(rawPath);
  if (!temporal || temporal.meanDelta < 0.35) {
    throw new StudioError(
      "QUALITY_REJECTED",
      "The artifact is effectively frozen and therefore does not prove true temporal video.",
    );
  }

  const report = await getEvaluator().evaluate({
    shotId: request.shotId,
    attempt: 0,
    videoPath: rawPath,
    expected: {
      durationSec: raw.durationSec,
      width: request.width,
      height: request.height,
      fps: request.fps,
    },
    context: {
      realismLevel: "maximum",
      strictDomains: [
        "liquid_physics",
        "product_geometry",
        "material_texture",
        "lighting_physics",
        "camera_optics",
        "motion_physics",
        "temporal_stability",
      ],
      hasHuman: false,
      hasHands: false,
      hasProduct: true,
      hasLiquid: true,
      hasBranding: true,
      referencePaths: [initFramePath],
      consistencyStrength: request.guidance.consistencyStrength,
      isRealGeneration: true,
      cameraMoveIntensity: request.camera.moveIntensity,
      subjectMotion: request.motion.subjectMotion,
      shotDescription: request.prompt,
      preserveNotes: [
        "exact cup and dessert geometry",
        "photoreal glass, ice, liquid and condensation",
        "real cafe materials and physically consistent reflections",
      ],
    },
    targets: {
      minOverall: 0.72,
      minTemporalConsistency: 0.68,
      minSubjectConsistency: 0.72,
    },
  });

  if (!report.passed) {
    throw new StudioError("QUALITY_REJECTED", "The raw I2V clip failed the measured quality gate.", {
      details: JSON.stringify({ scores: report.scores, issues: report.issues }, null, 2),
    });
  }

  await compositeAmedsporTest({
    videoPath: rawPath,
    logoPath: AMEDSPOR_ASSETS.logo,
    outputPath: finalPath,
  });
  const final = await probeMedia(finalPath);
  if (final.width !== 1080 || final.height !== 1920 || final.fps !== 30 || final.codec !== "h264") {
    throw new StudioError(
      "COMPOSE_FAILED",
      `Final export is ${final.width}x${final.height} @ ${final.fps} fps (${final.codec}), not 1080x1920 @ 30 fps H.264.`,
    );
  }

  console.log(
    JSON.stringify(
      {
        provider: provider.capabilities.id,
        model: result.provider.model,
        raw,
        temporal,
        quality: report,
        outputs: { initFramePath, rawPath, finalPath },
        note: "Automated checks measure motion, stability, coarse reference preservation and encoding. Final photorealism still requires human review of the rendered clip.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
