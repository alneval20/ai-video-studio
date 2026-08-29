import path from "node:path";
import fs from "node:fs/promises";
import { escapeDrawText, wrapText } from "@/lib/compose/drawtext";
import { checkTools, runFfmpeg } from "@/lib/compose/ffmpeg";
import { createLogger } from "@/lib/core/logger";
import { ensureDir } from "@/lib/storage/paths";
import type {
  GenerationContext,
  GenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ProviderHealth,
  VideoProvider,
} from "../types";

const log = createLogger("provider:mock");

/**
 * Development / mock provider.
 *
 * It does NOT generate AI video and never claims to. It produces a clearly
 * labelled placeholder clip — a slate showing the shot title, the compiled
 * prompt, the camera preset, the seed and the resolution — so the entire
 * pipeline can be exercised end to end without a GPU or an API key:
 *
 *   prompt -> director -> spec -> shot plan -> compiled prompts ->
 *   provider request -> job -> output handling -> quality -> composition
 *
 * Every result it returns has `isRealGeneration: false`, and the UI surfaces
 * that prominently.
 */
export class MockProvider implements VideoProvider {
  readonly capabilities: ProviderCapabilities = {
    id: "mock",
    label: "Development (mock)",
    description:
      "Renders labelled placeholder clips so the full pipeline runs with no GPU and no API key. Produces NO AI video.",
    kind: "mock",
    requiresGpu: false,
    requiresApiKey: false,
    producesRealVideo: false,

    // The mock accepts every usage so reference routing can be exercised and
    // inspected in the UI, even though nothing is actually conditioned.
    supportsInitFrame: true,
    supportedReferenceUsages: ["init_frame", "identity", "style", "layout", "descriptive_only"],
    supportsSeed: true,
    supportsNegativePrompt: true,

    maxGenerationEdge: 832,
    maxFps: 24,
    maxClipSeconds: 8,
    promptStyle: "cinematic_prose",
    // T5-class text encoders cap around 512 tokens; past that the model
    // silently truncates and the realism constraints at the tail are lost.
    maxPromptTokens: 512,
  };

  async health(): Promise<ProviderHealth> {
    const tools = await checkTools();
    return {
      available: true,
      detail: tools.ffmpeg
        ? "Ready. Renders labelled placeholder video with FFmpeg."
        : "Ready, but FFmpeg is missing — placeholders will be written as text manifests instead of video.",
      remedy: tools.ffmpeg ? undefined : tools.remedy,
      info: { producesRealVideo: false, ffmpeg: tools.ffmpeg, version: tools.version },
    };
  }

  async generate(request: GenerationRequest, ctx?: GenerationContext): Promise<GenerationResult> {
    const started = Date.now();
    await ensureDir(path.dirname(request.outputPath));

    const diagnostics: string[] = [
      "MOCK PROVIDER — this output is a placeholder, not generated video.",
      `Prompt: ${request.prompt.length} chars (~${Math.ceil(request.prompt.length / 4)} tokens).`,
      `Negative: ${request.negativePrompt ? `${request.negativePrompt.length} chars` : "none"}.`,
      `References: ${request.references.length === 0 ? "none" : request.references.map((r) => `${r.role}/${r.usage}@${r.weight}`).join(", ")}.`,
      `Camera: ${request.camera.presetLabel} — ${request.camera.primaryMove} @ intensity ${request.camera.moveIntensity}.`,
      `Seed ${request.seed}, ${request.width}x${request.height} @ ${request.fps}fps, ${request.durationSec}s.`,
    ];

    // Simulate a little latency so the async job UI is genuinely exercised.
    await this.simulateWork(request.durationSec, ctx);

    const tools = await checkTools();
    let wroteVideo = false;

    if (tools.ffmpeg) {
      wroteVideo = await this.renderSlate(request);
      if (!wroteVideo) {
        diagnostics.push("FFmpeg slate render failed; wrote a text manifest instead.");
      }
    } else {
      diagnostics.push("FFmpeg unavailable; wrote a text manifest instead of a video file.");
    }

    if (!wroteVideo) {
      await this.writeManifest(request);
    }

    const elapsedMs = Date.now() - started;
    log.info("Mock generation complete.", { shotId: request.shotId, wroteVideo, elapsedMs });

    return {
      requestId: request.requestId,
      shotId: request.shotId,
      status: "succeeded",
      outputPath: wroteVideo ? request.outputPath : `${request.outputPath}.txt`,
      posterPath: null,
      mimeType: wroteVideo ? "video/mp4" : "text/plain",
      durationSec: request.durationSec,
      width: request.width,
      height: request.height,
      fps: request.fps,
      provider: { id: this.capabilities.id, model: null },
      isRealGeneration: false,
      diagnostics,
      metrics: { elapsedMs },
    };
  }

  private async simulateWork(durationSec: number, ctx?: GenerationContext): Promise<void> {
    const steps = 5;
    const totalMs = Math.min(2000, 400 + durationSec * 120);
    for (let i = 1; i <= steps; i++) {
      if (ctx?.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, totalMs / steps));
      ctx?.onProgress?.(i / steps, i === steps ? "Writing placeholder" : "Simulating generation");
    }
  }

  /**
   * Renders a slate: solid background, the shot title, and the opening of the
   * compiled prompt, with an unmissable MOCK banner.
   */
  private async renderSlate(request: GenerationRequest): Promise<boolean> {
    const lines = [
      "MOCK - NOT AI VIDEO",
      request.shotId,
      `${request.width}x${request.height} @ ${request.fps}fps`,
      `${request.durationSec}s | seed ${request.seed}`,
      `camera: ${request.camera.presetLabel}`,
      ...wrapText(request.prompt.split("\n\n")[0] ?? request.prompt, 46).slice(0, 6),
    ];

    // drawtext needs escaping for colons, backslashes, quotes and percent signs.
    const drawtexts = lines.map((line, i) => {
      const y = Math.round(request.height * 0.18 + i * request.height * 0.055);
      // Sized so the banner fits the generation frame at any aspect ratio.
      const size = i === 0 ? Math.round(request.width / 20) : Math.round(request.width / 30);
      const colour = i === 0 ? "red" : i < 5 ? "white" : "gray";
      return (
        `drawtext=text='${escapeDrawText(line)}':fontcolor=${colour}:fontsize=${size}` +
        `:x=(w-text_w)/2:y=${y}`
      );
    });

    const filter = [
      // A slow horizontal gradient sweep, so the clip is visibly moving video
      // rather than a still — this exercises the composer honestly.
      `[0:v]hue=h='t*20':s=0.6[bg]`,
      `[bg]${drawtexts.join(",")}[out]`,
    ].join(";");

    const result = await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x1b1b22:s=${request.width}x${request.height}:r=${request.fps}:d=${request.durationSec}`,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        request.outputPath,
      ],
      120_000,
    );

    if (!result.ok) {
      log.warn("Slate render failed.", { command: result.command, stderr: result.stderrTail });
    }
    return result.ok;
  }

  /** Fallback when FFmpeg is missing: an inspectable text dump of the request. */
  private async writeManifest(request: GenerationRequest): Promise<void> {
    const body = [
      "AI VIDEO STUDIO — MOCK PROVIDER OUTPUT",
      "This file is a placeholder. No video was generated.",
      "",
      `shot:      ${request.shotId}`,
      `attempt:   ${request.attempt}`,
      `size:      ${request.width}x${request.height} @ ${request.fps}fps`,
      `duration:  ${request.durationSec}s`,
      `seed:      ${request.seed}`,
      `guidance:  ${JSON.stringify(request.guidance)}`,
      "",
      "--- CAMERA ---",
      JSON.stringify(request.camera, null, 2),
      "",
      "--- REFERENCES ---",
      request.references.length === 0
        ? "(none)"
        : request.references
            .map((r) => `${r.role} / ${r.usage} / weight ${r.weight} -> ${r.path}`)
            .join("\n"),
      "",
      "--- POSITIVE PROMPT ---",
      request.prompt,
      "",
      "--- NEGATIVE PROMPT ---",
      request.negativePrompt || "(none)",
      "",
    ].join("\n");

    await fs.writeFile(`${request.outputPath}.txt`, body, "utf8");
  }
}


