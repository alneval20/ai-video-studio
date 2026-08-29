import fs from "node:fs/promises";
import path from "node:path";
import { linkedSignal, sleep } from "@/lib/core/abort";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
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

const log = createLogger("provider:remote-worker");

export const WAN_I2V_MODEL_ID = "Wan-AI/Wan2.2-I2V-A14B-Diffusers";
export const WAN_I2V_PROFILE = "wan2.2-i2v-a14b-720p";
export const WAN_I2V_FPS = 24;
export const WAN_I2V_VERTICAL_SIZES = [
  { width: 720, height: 1280 },
  { width: 480, height: 832 },
] as const;

/** Wan's temporal VAE requires a 4n+1 frame count. */
export function wanFrameCount(durationSec: number, fps = WAN_I2V_FPS): number {
  const nominal = Math.max(1, Math.round(durationSec * fps));
  return Math.max(1, Math.round((nominal - 1) / 4) * 4 + 1);
}

/**
 * Adapter for the project's own Python GPU worker (see ./worker).
 *
 * This is the path for direct Diffusers/PyTorch inference rather than a
 * ComfyUI graph: more control over the pipeline, model lifecycle, and
 * pre/post-processing, at the cost of writing the pipeline yourself.
 *
 * The worker is vendor-neutral by design — the same container runs on a LAN
 * box, RunPod, Vast.ai, Lambda, or any other NVIDIA host. This adapter only
 * speaks its HTTP contract (documented in worker/README.md); it knows nothing
 * about where the GPU lives.
 *
 * REQUIRES: the worker running on an NVIDIA GPU with a video model downloaded.
 * Until then `health()` reports exactly what is missing.
 */
export class RemoteWorkerProvider implements VideoProvider {
  readonly capabilities: ProviderCapabilities = {
    id: "remote-worker",
    label: "Remote GPU worker (Python)",
    description:
      "Drives this project's Python worker for direct Diffusers/PyTorch inference on any NVIDIA GPU host.",
    kind: "remote",
    requiresGpu: true,
    requiresApiKey: false,
    producesRealVideo: true,

    supportsInitFrame: true,
    // Wan I2V accepts one conditioning image. Claiming identity/style slots
    // would be dishonest: those images were previously uploaded but ignored.
    supportedReferenceUsages: ["init_frame", "descriptive_only"],
    supportsSeed: true,
    supportsNegativePrompt: true,

    maxGenerationEdge: 1280,
    maxFps: 24,
    maxClipSeconds: 5,
    promptStyle: "structured_blocks",
    // T5-class text encoders cap around 512 tokens; past that the model
    // silently truncates and the realism constraints at the tail are lost.
    maxPromptTokens: 512,
  };

  private get baseUrl(): string {
    return getEnv().REMOTE_WORKER_URL.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = getEnv().REMOTE_WORKER_TOKEN;
    return {
      ...extra,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        return {
          available: false,
          detail: `The worker responded with HTTP ${res.status}.`,
          remedy: res.status === 401 ? "Check REMOTE_WORKER_TOKEN." : "Check the worker logs.",
        };
      }

      const body = (await res.json()) as {
        status?: string;
        device?: string;
        model_loaded?: boolean;
        model_id?: string | null;
        model_profile?: string | null;
        detail?: string;
      };

      if (body.device !== "cuda") {
        return {
          available: false,
          detail: `The worker is running on "${body.device ?? "unknown"}", not CUDA — it cannot generate video.`,
          remedy:
            "Deploy the worker to an NVIDIA GPU host (LAN machine, RunPod, Vast.ai) and set REMOTE_WORKER_URL to it.",
          info: body,
        };
      }
      if (!body.model_loaded) {
        return {
          available: false,
          detail: "The worker is up on a GPU but no video model is loaded.",
          remedy:
            "Set VIDEO_MODEL_ID in the worker environment and let it download the weights (see worker/README.md).",
          info: body,
        };
      }
      if (body.model_id !== WAN_I2V_MODEL_ID || body.model_profile !== WAN_I2V_PROFILE) {
        return {
          available: false,
          detail: `The worker loaded ${body.model_id ?? "an unknown model"}, not the required ${WAN_I2V_MODEL_ID} profile.`,
          remedy: `Set VIDEO_MODEL_ID=${WAN_I2V_MODEL_ID} and VIDEO_MODEL_PROFILE=${WAN_I2V_PROFILE}, then restart the worker.`,
          info: body,
        };
      }

      return {
        available: true,
        detail: `Worker ready on ${body.device} with ${body.model_id ?? "a model"} loaded.`,
        info: body,
      };
    } catch {
      return {
        available: false,
        detail: `No worker responded at ${this.baseUrl}.`,
        remedy: "Start the Python worker (see worker/README.md) and set REMOTE_WORKER_URL.",
      };
    }
  }

  async generate(request: GenerationRequest, ctx?: GenerationContext): Promise<GenerationResult> {
    const started = Date.now();
    const health = await this.health();
    if (!health.available) {
      throw new StudioError("GPU_REQUIRED", health.detail, { remedy: health.remedy });
    }

    const jobId = await this.submit(request, ctx?.signal);
    log.info("Submitted worker job.", { jobId, shotId: request.shotId });

    let result: WorkerJobResult;
    try {
      result = await this.poll(jobId, ctx);
    } catch (error) {
      // Abandoning the poll would leave the GPU working on a job nobody wants.
      if (ctx?.signal?.aborted) await this.cancelRemote(jobId);
      throw error;
    }

    await ensureDir(path.dirname(request.outputPath));
    const bytes = await this.fetchArtifact(jobId, ctx?.signal);
    await fs.writeFile(request.outputPath, bytes);

    return {
      requestId: request.requestId,
      shotId: request.shotId,
      status: "succeeded",
      outputPath: request.outputPath,
      posterPath: null,
      mimeType: "video/mp4",
      durationSec: result.duration_sec ?? request.durationSec,
      width: result.width ?? request.width,
      height: result.height ?? request.height,
      fps: result.fps ?? request.fps,
      provider: { id: this.capabilities.id, model: result.model_id ?? null },
      isRealGeneration: true,
      diagnostics: [
        `Worker job ${jobId}`,
        result.model_id ? `Model: ${result.model_id}` : "",
        result.model_profile ? `Profile: ${result.model_profile}` : "",
        result.num_frames ? `Frames: ${result.num_frames}` : "",
        result.codec ? `Codec: ${result.codec}` : "",
        result.device ? `Device: ${result.device}` : "",
      ].filter(Boolean),
      metrics: { elapsedMs: Date.now() - started, queueMs: result.queue_ms },
    };
  }

  /** Mirrors the JSON contract in worker/app/schemas.py. */
  private async submit(request: GenerationRequest, signal?: AbortSignal): Promise<string> {
    assertWanRequest(request);
    const initFrame = request.references.find((reference) => reference.usage === "init_frame");
    if (!initFrame) {
      throw new StudioError("INVALID_INPUT", "Wan 2.2 I2V requires exactly one init_frame image.");
    }

    const payload = {
      request_id: request.requestId,
      shot_id: request.shotId,
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      fps: request.fps,
      duration_sec: request.durationSec,
      num_frames: wanFrameCount(request.durationSec, request.fps),
      seed: request.seed,
      guidance: {
        prompt_adherence: request.guidance.promptAdherence,
        reference_adherence: request.guidance.referenceAdherence,
        consistency_strength: request.guidance.consistencyStrength,
      },
      camera: request.camera,
      motion: request.motion,
      // Images are sent as base64 so the worker needs no shared filesystem —
      // that is what lets it run on a rented GPU in another datacentre.
      references: [] as Array<Record<string, unknown>>,
      provider_options: {
        ...request.providerOptions,
        model_profile: WAN_I2V_PROFILE,
        num_inference_steps: 40,
        guidance_scale: 5,
        guidance_scale_2: 5,
      },
    };

    let data: Buffer;
    try {
      data = await fs.readFile(initFrame.path);
    } catch (error) {
      throw new StudioError("REFERENCE_INVALID", `Could not read init frame ${initFrame.path}.`, {
        details: (error as Error).message,
      });
    }
    payload.references.push({
      id: initFrame.id,
      role: initFrame.role,
      usage: initFrame.usage,
      weight: initFrame.weight,
      mime_type: initFrame.mimeType,
      image_base64: data.toString("base64"),
    });

    const res = await fetch(`${this.baseUrl}/jobs`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
      signal: linkedSignal(120_000, signal),
    });

    if (!res.ok) {
      throw new StudioError("PROVIDER_FAILED", `The worker rejected the job (HTTP ${res.status}).`, {
        details: (await res.text()).slice(0, 2000),
      });
    }

    const body = (await res.json()) as { job_id?: string };
    if (!body.job_id) throw new StudioError("PROVIDER_FAILED", "The worker returned no job id.");
    return body.job_id;
  }

  private async poll(jobId: string, ctx?: GenerationContext): Promise<WorkerJobResult> {
    const deadline = Date.now() + 30 * 60_000;

    while (Date.now() < deadline) {
      if (ctx?.signal?.aborted) throw new StudioError("PROVIDER_FAILED", "Generation was cancelled.");
      await sleep(2500, ctx?.signal);

      const res = await fetch(`${this.baseUrl}/jobs/${jobId}`, {
        headers: this.headers(),
        signal: linkedSignal(15_000, ctx?.signal),
      });
      if (!res.ok) continue;

      const body = (await res.json()) as WorkerJobResult;
      if (typeof body.progress === "number") ctx?.onProgress?.(body.progress, body.stage);

      if (body.status === "succeeded") return body;
      if (body.status === "failed" || body.status === "cancelled") {
        throw mapWorkerError(body);
      }
    }

    throw new StudioError("PROVIDER_FAILED", "Timed out waiting for the GPU worker (30 minutes).");
  }

  /** Best-effort remote cancel; failure here must not mask the original error. */
  private async cancelRemote(jobId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      log.info("Asked the worker to cancel.", { jobId });
    } catch {
      log.warn("Could not reach the worker to cancel the job.", { jobId });
    }
  }

  private async fetchArtifact(jobId: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/jobs/${jobId}/artifact`, {
      headers: this.headers(),
      signal: linkedSignal(180_000, signal),
    });
    if (!res.ok) {
      throw new StudioError("PROVIDER_FAILED", `Could not download the artifact (HTTP ${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Mirrors `JobState` in worker/app/schemas.py. */
interface WorkerJobResult {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress?: number;
  stage?: string;
  error?: string | null;
  /** Mirrors `ErrorCode` in worker/app/schemas.py. */
  error_code?: WorkerErrorCode | null;
  retryable?: boolean;
  duration_sec?: number;
  width?: number;
  height?: number;
  fps?: number;
  num_frames?: number;
  codec?: string;
  model_id?: string;
  model_profile?: string;
  device?: string;
  queue_ms?: number;
}

function assertWanRequest(request: GenerationRequest): void {
  const dimensionsAreSupported = WAN_I2V_VERTICAL_SIZES.some(
    (size) => size.width === request.width && size.height === request.height,
  );
  if (!dimensionsAreSupported) {
    throw new StudioError(
      "INVALID_INPUT",
      `Wan 2.2 I2V vertical generation must be 720x1280 or 480x832; received ${request.width}x${request.height}.`,
    );
  }
  if (request.fps !== WAN_I2V_FPS) {
    throw new StudioError("INVALID_INPUT", `Wan 2.2 I2V is configured at ${WAN_I2V_FPS} fps; received ${request.fps}.`);
  }

  const conditioned = request.references.filter((reference) => reference.usage !== "descriptive_only");
  if (conditioned.length !== 1 || conditioned[0]?.usage !== "init_frame") {
    throw new StudioError(
      "INVALID_INPUT",
      "Wan 2.2 I2V accepts exactly one conditioned reference and it must use init_frame.",
    );
  }
}

export type WorkerErrorCode =
  | "oom"
  | "timeout"
  | "cancelled"
  | "model_unavailable"
  | "invalid_request"
  | "internal";

/** Turns a worker error code into a studio error with an actionable remedy. */
function mapWorkerError(result: WorkerJobResult): StudioError {
  const message = result.error ?? "The worker reported a failure.";
  switch (result.error_code) {
    case "oom":
      return new StudioError("PROVIDER_FAILED", `GPU out of memory: ${message}`, {
        remedy:
          "Lower the generation resolution or shot duration, or set WORKER_CPU_OFFLOAD=true on the worker.",
      });
    case "timeout":
      return new StudioError("PROVIDER_FAILED", `The worker timed out: ${message}`, {
        remedy: "Shorten the shot, or raise WORKER_JOB_TIMEOUT_SEC on the worker.",
      });
    case "cancelled":
      return new StudioError("PROVIDER_FAILED", "Generation was cancelled.");
    case "model_unavailable":
      return new StudioError("GPU_REQUIRED", message, {
        remedy: "Check VIDEO_MODEL_ID and that the worker is on a CUDA host.",
      });
    case "invalid_request":
      return new StudioError("INVALID_INPUT", message);
    default:
      return new StudioError("PROVIDER_FAILED", message, {
        remedy: "Check the worker logs — this is usually VRAM exhaustion or a missing model file.",
      });
  }
}
