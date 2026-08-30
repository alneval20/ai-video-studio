/**
 * Image-to-video model profiles — the TypeScript mirror of
 * `worker/app/model_profiles.py`.
 *
 * The two files are kept in agreement by `tests/worker-contract.test.ts`. They
 * are separate because the app must know a profile's constraints *before* it
 * builds a spec — resolution, frame rate and clip length all feed the shot
 * planner — while the worker needs them to validate what actually arrives.
 *
 * Two profiles ship, at opposite ends of the hardware range:
 *
 *   wan2.2-i2v-a14b-720p   best quality; needs an 80 GB-class datacentre GPU
 *   ltx-2b-i2v-576p        ~10 GB, so it fits a free-tier T4/P100
 *
 * Both are genuine image-to-video models producing real generated motion. The
 * free-tier profile is a smaller model, not a different technique — see
 * docs/FREE-GPU.md for the quality trade-off in plain terms.
 */

export interface I2vProfile {
  /** Wire identifier, shared with the Python worker. */
  id: string;
  modelId: string;
  label: string;
  fps: number;
  /** Vertical sizes this profile is validated for, widest edge last. */
  sizes: ReadonlyArray<{ width: number; height: number }>;
  /** VAE temporal stride: frame counts must satisfy (n - 1) % stride === 0. */
  temporalStride: number;
  /** Both dimensions must be divisible by this. */
  spatialStride: number;
  minVramGib: number;
  /** Longest single clip this profile should be asked for. */
  maxClipSeconds: number;
  /** Text-encoder budget; past this the tail of the prompt is silently lost. */
  maxPromptTokens: number;
  /** Sampler defaults sent as provider options. */
  sampler: {
    numInferenceSteps: number;
    guidanceScale: number;
    /** Wan's second MoE expert. Ignored by single-expert profiles. */
    guidanceScale2: number;
  };
  summary: string;
}

export const WAN_I2V: I2vProfile = {
  id: "wan2.2-i2v-a14b-720p",
  modelId: "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
  label: "Wan 2.2 I2V A14B (720p)",
  fps: 24,
  sizes: [
    { width: 480, height: 832 },
    { width: 720, height: 1280 },
  ],
  temporalStride: 4,
  spatialStride: 16,
  minVramGib: 75,
  maxClipSeconds: 5,
  maxPromptTokens: 512,
  sampler: { numInferenceSteps: 40, guidanceScale: 5, guidanceScale2: 5 },
  summary: "Highest quality. Requires an 80 GB-class GPU (A100/H100).",
};

export const LTX_I2V: I2vProfile = {
  id: "ltx-2b-i2v-576p",
  modelId: "Lightricks/LTX-Video",
  label: "LTX-Video 2B I2V (576p)",
  fps: 24,
  // 576x1024 is exactly 9:16 and divisible by 32, which LTX requires. Sizes
  // that are merely close to 9:16 get letterboxed or stretched on Reels.
  sizes: [
    { width: 576, height: 1024 },
    { width: 704, height: 1216 },
  ],
  temporalStride: 8,
  spatialStride: 32,
  minVramGib: 10,
  maxClipSeconds: 5,
  // The LTX pipeline defaults max_sequence_length to 128, which silently
  // truncates a compiled prompt at the tail — dropping exactly the realism
  // constraints the trimmer ranks last. We compile to 256 and pass
  // max_sequence_length=256 explicitly, so the whole prompt is encoded and any
  // dropping is done deliberately by our trimmer rather than arbitrarily by
  // the tokenizer.
  maxPromptTokens: 256,
  // LTX is distilled and needs far fewer steps than Wan; running it at 40
  // wastes time on a free GPU without improving the result.
  sampler: { numInferenceSteps: 30, guidanceScale: 5, guidanceScale2: 5 },
  summary: "Runs in ~10 GB, so it fits a free-tier T4/P100. Smaller model than Wan.",
};

export const I2V_PROFILES: Record<string, I2vProfile> = {
  [WAN_I2V.id]: WAN_I2V,
  [LTX_I2V.id]: LTX_I2V,
};

export const DEFAULT_I2V_PROFILE_ID = WAN_I2V.id;

export function getI2vProfile(id: string | undefined | null): I2vProfile {
  if (!id) return I2V_PROFILES[DEFAULT_I2V_PROFILE_ID];
  return I2V_PROFILES[id] ?? I2V_PROFILES[DEFAULT_I2V_PROFILE_ID];
}

/**
 * Frame count nearest `durationSec` that satisfies the profile's temporal
 * stride.
 *
 * Neither rounding down nor rounding to nearest is sufficient on its own. The
 * worker rejects any frame count more than one frame from `duration_sec * fps`,
 * and with LTX's stride of 8 the nearest valid count can be up to 4 frames
 * away. So callers must pair this with `durationForFrames` and send the
 * *derived* duration, making the two agree exactly rather than approximately.
 */
export function frameCountFor(profile: I2vProfile, durationSec: number): number {
  const nominal = Math.max(1, Math.round(durationSec * profile.fps));
  const steps = Math.max(0, Math.round((nominal - 1) / profile.temporalStride));
  return steps * profile.temporalStride + 1;
}

/**
 * The exact duration a frame count represents.
 *
 * Sending this instead of the planner's requested duration guarantees
 * `num_frames === round(duration_sec * fps)`, which is what the worker
 * validates. Without it, a shot whose length happens to land badly against the
 * stride is rejected after the request has already reached the GPU.
 */
export function durationForFrames(profile: I2vProfile, frames: number): number {
  return Number((frames / profile.fps).toFixed(4));
}

/** The profile's largest supported vertical size. */
export function largestSize(profile: I2vProfile): { width: number; height: number } {
  return profile.sizes[profile.sizes.length - 1];
}
