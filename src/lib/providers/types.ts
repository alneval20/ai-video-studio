import type { CameraDirective, MotionDirective } from "@/lib/spec/spec";
import type { ReferenceRole, ReferenceUsage } from "@/lib/spec/vocab";

/**
 * What a provider can actually do.
 *
 * The spec assembler reads this *before* building the spec, so that reference
 * bindings, resolutions and clip lengths are negotiated up front rather than
 * discovered as failures at generation time.
 */
export interface ProviderCapabilities {
  id: string;
  label: string;
  description: string;
  /** Where the compute lives. Drives what the UI warns about. */
  kind: "mock" | "local" | "remote" | "external_api";
  requiresGpu: boolean;
  requiresApiKey: boolean;
  /** True if this provider produces genuine AI video. The mock provider is false. */
  producesRealVideo: boolean;

  supportsInitFrame: boolean;
  supportedReferenceUsages: ReferenceUsage[];
  supportsSeed: boolean;
  supportsNegativePrompt: boolean;

  /** Longest edge, in pixels, this provider should be asked to render. */
  maxGenerationEdge: number;
  maxFps: number;
  /** Longest single clip in seconds. Longer shots get trimmed by the assembler. */
  maxClipSeconds: number;

  /**
   * How this model likes to be prompted. Selects the prompt adapter, which is
   * what keeps the Director model-independent.
   */
  promptStyle: PromptStyle;

  /**
   * Approximate token budget for the text encoder.
   *
   * This matters more than it looks: video models built on T5 encoders cap
   * around 512 tokens, and CLIP-based ones at 77. Anything past the limit is
   * silently truncated by the model — so the compiler trims low-priority
   * sections to fit rather than letting the tail (which is where the realism
   * constraints live) get cut off without warning.
   */
  maxPromptTokens: number;
}

export const PROMPT_STYLES = ["cinematic_prose", "structured_blocks", "tag_soup"] as const;
export type PromptStyle = (typeof PROMPT_STYLES)[number];

/** A reference image, resolved to something a provider can actually open. */
export interface ProviderReference {
  id: string;
  role: ReferenceRole;
  usage: ReferenceUsage;
  /** 0..1 conditioning strength; adapters map this onto model-specific scales. */
  weight: number;
  /** Absolute path on disk. */
  path: string;
  mimeType: string;
  /** Short description used when `usage` is `descriptive_only`. */
  description: string;
}

/**
 * The normalised request every provider receives.
 *
 * Nothing here is provider-specific except `providerOptions`, which no code
 * outside the owning adapter is allowed to read.
 */
export interface GenerationRequest {
  requestId: string;
  projectId: string;
  specId: string;
  shotId: string;
  /** 0 for the first try; incremented by the repair loop. */
  attempt: number;

  prompt: string;
  negativePrompt: string;
  references: ProviderReference[];

  width: number;
  height: number;
  fps: number;
  durationSec: number;
  seed: number;

  /** Structured camera intent, for providers that can consume it directly. */
  camera: CameraDirective;
  motion: MotionDirective;

  guidance: {
    /** How closely to follow the text prompt, 0..1 (adapters map to CFG etc.). */
    promptAdherence: number;
    /** How hard to hold reference images, 0..1. */
    referenceAdherence: number;
    /** How hard to hold frame-to-frame consistency, 0..1. */
    consistencyStrength: number;
  };

  /** Absolute path the provider must write its video to. */
  outputPath: string;
  providerOptions: Record<string, unknown>;
}

export interface GenerationResult {
  requestId: string;
  shotId: string;
  status: "succeeded" | "failed";

  /** Absolute path to the produced file. Null on failure. */
  outputPath: string | null;
  /** Optional still frame for the UI. */
  posterPath: string | null;
  mimeType: string;

  durationSec: number;
  width: number;
  height: number;
  fps: number;

  provider: { id: string; model: string | null };

  /**
   * False when the output is a placeholder rather than generated video.
   * The UI shows this prominently — the system must never imply it produced
   * AI footage when it did not.
   */
  isRealGeneration: boolean;

  /** Human-readable notes: what was sent, what the backend reported. */
  diagnostics: string[];
  metrics: { elapsedMs: number; queueMs?: number };
  error?: { code: string; message: string; remedy?: string; retryable: boolean };
}

export interface ProviderHealth {
  available: boolean;
  detail: string;
  /** What the user must do to make this provider work. */
  remedy?: string;
  /** Extra info from the backend, e.g. loaded models. */
  info?: Record<string, unknown>;
}

export interface GenerationContext {
  /** Called with 0..1 progress. Providers should call it when they can. */
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/**
 * The provider contract.
 *
 * Adding a new generation backend means implementing this interface and
 * registering it. No orchestration, UI or domain code changes.
 */
export interface VideoProvider {
  readonly capabilities: ProviderCapabilities;
  /** Cheap reachability check. Must never throw. */
  health(): Promise<ProviderHealth>;
  generate(request: GenerationRequest, ctx?: GenerationContext): Promise<GenerationResult>;
}
