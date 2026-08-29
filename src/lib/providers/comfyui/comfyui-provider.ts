import fs from "node:fs/promises";
import path from "node:path";
import { linkedSignal, sleep } from "@/lib/core/abort";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";
import { ensureDir, fileExists } from "@/lib/storage/paths";
import type {
  GenerationContext,
  GenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ProviderHealth,
  VideoProvider,
} from "../types";

const log = createLogger("provider:comfyui");

/**
 * ComfyUI adapter — the first *real* generation backend.
 *
 * ComfyUI is the pragmatic first choice for a zero-budget project: it is open
 * source, it runs every current open-weights video model (Wan 2.x, LTX-Video,
 * SVD, CogVideoX), and it exposes a plain HTTP API. Point this at a ComfyUI
 * instance on any NVIDIA box — a spare desktop on the LAN, RunPod, Vast.ai —
 * and the studio starts producing real footage with no code changes.
 *
 * ==========================================================================
 * WHAT THIS REQUIRES THAT YOU MAY NOT HAVE YET
 * ==========================================================================
 *  1. An NVIDIA GPU with >= 12 GB VRAM (24 GB for 720p Wan 2.2).
 *  2. ComfyUI running with `--listen`, reachable at COMFYUI_BASE_URL.
 *  3. A video model checkpoint installed in ComfyUI.
 *  4. An API-format workflow JSON exported from ComfyUI
 *     (Settings -> Enable dev mode -> "Save (API format)"), saved at
 *     COMFYUI_WORKFLOW, using the placeholder tokens listed in
 *     worker/workflows/README.md.
 *
 * None of that can be faked. If any of it is missing, `health()` says exactly
 * which piece is absent and `generate()` refuses rather than pretending.
 * ==========================================================================
 */
export class ComfyUiProvider implements VideoProvider {
  readonly capabilities: ProviderCapabilities = {
    id: "comfyui",
    label: "ComfyUI (self-hosted, open source)",
    description:
      "Drives a self-hosted ComfyUI instance running an open-weights video model. Requires an NVIDIA GPU and a workflow file.",
    kind: "remote",
    requiresGpu: true,
    requiresApiKey: false,
    producesRealVideo: true,

    supportsInitFrame: true,
    supportedReferenceUsages: ["init_frame", "identity", "style", "descriptive_only"],
    supportsSeed: true,
    supportsNegativePrompt: true,

    // Conservative defaults matching what a 24GB card handles for Wan 2.x i2v.
    maxGenerationEdge: 832,
    maxFps: 24,
    maxClipSeconds: 5,
    promptStyle: "cinematic_prose",
    // T5-class text encoders cap around 512 tokens; past that the model
    // silently truncates and the realism constraints at the tail are lost.
    maxPromptTokens: 512,
  };

  private get baseUrl(): string {
    return getEnv().COMFYUI_BASE_URL.replace(/\/+$/, "");
  }

  private get workflowPath(): string {
    // turbopackIgnore: a user-supplied workflow path read at runtime.
    return path.resolve(/* turbopackIgnore: true */ process.cwd(), getEnv().COMFYUI_WORKFLOW);
  }

  async health(): Promise<ProviderHealth> {
    const workflowPresent = await fileExists(this.workflowPath);

    let reachable = false;
    let info: Record<string, unknown> = {};
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(4000),
      });
      reachable = res.ok;
      if (res.ok) info = (await res.json()) as Record<string, unknown>;
    } catch {
      reachable = false;
    }

    if (!reachable) {
      return {
        available: false,
        detail: `No ComfyUI instance responded at ${this.baseUrl}.`,
        remedy:
          "Start ComfyUI on a machine with an NVIDIA GPU (`python main.py --listen`) and set COMFYUI_BASE_URL to its address.",
      };
    }
    if (!workflowPresent) {
      return {
        available: false,
        detail: `ComfyUI is reachable, but no workflow file exists at ${getEnv().COMFYUI_WORKFLOW}.`,
        remedy:
          "Export an API-format workflow from ComfyUI and save it there. See worker/workflows/README.md for the placeholder tokens it must contain.",
      };
    }

    return {
      available: true,
      detail: `ComfyUI reachable at ${this.baseUrl} with a workflow loaded.`,
      info,
    };
  }

  async generate(request: GenerationRequest, ctx?: GenerationContext): Promise<GenerationResult> {
    const started = Date.now();
    const health = await this.health();
    if (!health.available) {
      throw new StudioError("PROVIDER_NOT_CONFIGURED", health.detail, { remedy: health.remedy });
    }

    const workflow = await this.loadWorkflow(request);
    const promptId = await this.queue(workflow, ctx?.signal);
    log.info("Queued ComfyUI job.", { promptId, shotId: request.shotId });

    const outputs = await this.waitForResult(promptId, ctx);
    await ensureDir(path.dirname(request.outputPath));
    const bytes = await this.download(outputs, ctx?.signal);
    await fs.writeFile(request.outputPath, bytes);

    return {
      requestId: request.requestId,
      shotId: request.shotId,
      status: "succeeded",
      outputPath: request.outputPath,
      posterPath: null,
      mimeType: "video/mp4",
      durationSec: request.durationSec,
      width: request.width,
      height: request.height,
      fps: request.fps,
      provider: { id: this.capabilities.id, model: null },
      isRealGeneration: true,
      diagnostics: [`ComfyUI prompt ${promptId}`, `Output: ${outputs.filename}`],
      metrics: { elapsedMs: Date.now() - started },
    };
  }

  /**
   * Loads the API-format workflow and substitutes placeholder tokens.
   *
   * Token substitution (rather than node-graph surgery) keeps the adapter
   * agnostic to which model or node set the user has installed — they own the
   * graph, we only fill in the values.
   */
  private async loadWorkflow(request: GenerationRequest): Promise<unknown> {
    let raw: string;
    try {
      raw = await fs.readFile(this.workflowPath, "utf8");
    } catch {
      throw new StudioError("PROVIDER_NOT_CONFIGURED", `Could not read ${this.workflowPath}.`, {
        remedy: "Set COMFYUI_WORKFLOW to an API-format workflow exported from ComfyUI.",
      });
    }

    const initFrame = request.references.find((r) => r.usage === "init_frame");

    const substitutions: Record<string, string> = {
      "{{POSITIVE_PROMPT}}": jsonSafe(request.prompt),
      "{{NEGATIVE_PROMPT}}": jsonSafe(request.negativePrompt),
      "{{WIDTH}}": String(request.width),
      "{{HEIGHT}}": String(request.height),
      "{{FPS}}": String(request.fps),
      "{{FRAMES}}": String(Math.max(1, Math.round(request.durationSec * request.fps))),
      "{{SEED}}": String(request.seed),
      "{{CFG}}": (3 + request.guidance.promptAdherence * 6).toFixed(2),
      "{{STEPS}}": String(Math.round(20 + request.guidance.promptAdherence * 20)),
      "{{INIT_IMAGE}}": initFrame ? jsonSafe(initFrame.path) : "",
      "{{FILENAME_PREFIX}}": jsonSafe(`avs_${request.shotId}_a${request.attempt}`),
    };

    let filled = raw;
    for (const [token, value] of Object.entries(substitutions)) {
      filled = filled.split(token).join(value);
    }

    const leftover = filled.match(/\{\{[A-Z_]+\}\}/g);
    if (leftover) {
      throw new StudioError(
        "PROVIDER_NOT_CONFIGURED",
        `The workflow contains placeholders this adapter does not fill: ${Array.from(new Set(leftover)).join(", ")}.`,
        { remedy: "See worker/workflows/README.md for the supported placeholder tokens." },
      );
    }

    try {
      return JSON.parse(filled) as unknown;
    } catch (error) {
      throw new StudioError(
        "PROVIDER_NOT_CONFIGURED",
        `The workflow file is not valid JSON after substitution: ${(error as Error).message}`,
        { remedy: "Re-export the workflow in API format from ComfyUI." },
      );
    }
  }

  private async queue(workflow: unknown, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal: linkedSignal(30_000, signal),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new StudioError("PROVIDER_FAILED", `ComfyUI rejected the workflow (HTTP ${res.status}).`, {
        details: body.slice(0, 2000),
        remedy: "Open the workflow in ComfyUI and confirm every node and model it references is installed.",
      });
    }

    const data = (await res.json()) as { prompt_id?: string };
    if (!data.prompt_id) {
      throw new StudioError("PROVIDER_FAILED", "ComfyUI did not return a prompt id.");
    }
    return data.prompt_id;
  }

  private async waitForResult(
    promptId: string,
    ctx?: GenerationContext,
  ): Promise<{ filename: string; subfolder: string; type: string }> {
    const deadline = Date.now() + 20 * 60_000;
    let poll = 0;

    while (Date.now() < deadline) {
      if (ctx?.signal?.aborted) {
        throw new StudioError("PROVIDER_FAILED", "Generation was cancelled.");
      }
      await sleep(Math.min(4000, 800 + poll * 250), ctx?.signal);
      poll += 1;

      const res = await fetch(`${this.baseUrl}/history/${promptId}`, {
        signal: linkedSignal(15_000, ctx?.signal),
      });
      if (!res.ok) continue;

      const history = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];
      if (!entry) {
        ctx?.onProgress?.(Math.min(0.9, poll / 40), "Queued on the GPU");
        continue;
      }

      if (entry.status?.status_str === "error") {
        throw new StudioError("PROVIDER_FAILED", "ComfyUI reported an execution error.", {
          details: entry.status,
          remedy: "Check the ComfyUI console for the failing node.",
        });
      }

      const file = findVideoOutput(entry);
      if (file) {
        ctx?.onProgress?.(1, "Downloading");
        return file;
      }
    }

    throw new StudioError("PROVIDER_FAILED", "Timed out waiting for ComfyUI (20 minutes).", {
      remedy: "The GPU may be overloaded, or the workflow may not produce a video output node.",
    });
  }

  private async download(
    file: { filename: string; subfolder: string; type: string },
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const url =
      `${this.baseUrl}/view?filename=${encodeURIComponent(file.filename)}` +
      `&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`;
    const res = await fetch(url, { signal: linkedSignal(120_000, signal) });
    if (!res.ok) {
      throw new StudioError("PROVIDER_FAILED", `Could not download the output (HTTP ${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<string, { gifs?: ComfyFile[]; videos?: ComfyFile[]; images?: ComfyFile[] }>;
}

interface ComfyFile {
  filename: string;
  subfolder: string;
  type: string;
}

/** ComfyUI video nodes report under `gifs`, `videos` or `images` depending on the pack. */
function findVideoOutput(entry: ComfyHistoryEntry): ComfyFile | null {
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const bucket of [node.videos, node.gifs, node.images]) {
      const candidate = bucket?.find((f) => /\.(mp4|webm|mov|gif)$/i.test(f.filename));
      if (candidate) return candidate;
    }
  }
  return null;
}

/** Escapes a value for embedding in a JSON string literal inside the template. */
function jsonSafe(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
