import path from "node:path";
import { z } from "zod";

/**
 * Single source of truth for environment configuration. Everything is optional:
 * the app must boot and run end-to-end with an empty environment (mock mode).
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  DIRECTOR_MODEL: z.string().trim().min(1).default("claude-opus-5"),
  DIRECTOR_MODE: z.enum(["auto", "llm", "heuristic"]).default("auto"),

  VIDEO_PROVIDER: z.string().trim().min(1).default("mock"),
  /**
   * Whether an unavailable real provider may silently degrade to the mock.
   * Convenient in development; in production it means a user who asked for AI
   * video receives a placeholder instead. Defaults to off when NODE_ENV is
   * "production".
   */
  ALLOW_MOCK_FALLBACK: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? process.env.NODE_ENV !== "production" : v === "true")),

  COMFYUI_BASE_URL: z.string().trim().default("http://127.0.0.1:8188"),
  COMFYUI_WORKFLOW: z.string().trim().default("worker/workflows/i2v_default.api.json"),

  REMOTE_WORKER_URL: z.string().trim().default("http://127.0.0.1:8000"),
  /**
   * Which image-to-video profile the worker is serving. Must match the
   * worker's own VIDEO_MODEL_PROFILE — the health check refuses to run if the
   * two disagree, since the resolution and frame maths differ per profile.
   */
  VIDEO_MODEL_PROFILE: z.string().trim().min(1).default("wan2.2-i2v-a14b-720p"),
  REMOTE_WORKER_TOKEN: z.string().trim().optional(),

  STORAGE_DIR: z.string().trim().default("./storage"),
  OUTPUT_DIR: z.string().trim().default("./outputs"),

  FFMPEG_PATH: z.string().trim().default("ffmpeg"),
  FFPROBE_PATH: z.string().trim().default("ffprobe"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_SHOTS: z.coerce.number().int().min(1).max(12).default(6),
  /** Hard ceiling on one generation job. Prevents a hung provider wedging a job forever. */
  JOB_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(6 * 3600_000).default(45 * 60_000),
  /**
   * A non-terminal job untouched for this long, with no runner owning it, is
   * treated as interrupted (e.g. the server restarted mid-generation).
   */
  JOB_STALE_MS: z.coerce.number().int().min(30_000).default(5 * 60_000),
});

type EnvValues = z.infer<typeof EnvSchema>;

export interface StudioEnv extends EnvValues {
  /** Absolute path to the runtime data directory. */
  storageDir: string;
  /** Absolute path to the rendered-video output directory. */
  outputDir: string;
  hasDirectorKey: boolean;
}

function blankToUndefined(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v : undefined;
}

let cached: StudioEnv | null = null;

export function getEnv(): StudioEnv {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse({
    ANTHROPIC_API_KEY: blankToUndefined(process.env.ANTHROPIC_API_KEY),
    DIRECTOR_MODEL: blankToUndefined(process.env.DIRECTOR_MODEL),
    DIRECTOR_MODE: blankToUndefined(process.env.DIRECTOR_MODE),
    VIDEO_PROVIDER: blankToUndefined(process.env.VIDEO_PROVIDER),
    ALLOW_MOCK_FALLBACK: blankToUndefined(process.env.ALLOW_MOCK_FALLBACK),
    COMFYUI_BASE_URL: blankToUndefined(process.env.COMFYUI_BASE_URL),
    COMFYUI_WORKFLOW: blankToUndefined(process.env.COMFYUI_WORKFLOW),
    REMOTE_WORKER_URL: blankToUndefined(process.env.REMOTE_WORKER_URL),
    VIDEO_MODEL_PROFILE: blankToUndefined(process.env.VIDEO_MODEL_PROFILE),
    REMOTE_WORKER_TOKEN: blankToUndefined(process.env.REMOTE_WORKER_TOKEN),
    STORAGE_DIR: blankToUndefined(process.env.STORAGE_DIR),
    OUTPUT_DIR: blankToUndefined(process.env.OUTPUT_DIR),
    FFMPEG_PATH: blankToUndefined(process.env.FFMPEG_PATH),
    FFPROBE_PATH: blankToUndefined(process.env.FFPROBE_PATH),
    LOG_LEVEL: blankToUndefined(process.env.LOG_LEVEL),
    MAX_SHOTS: blankToUndefined(process.env.MAX_SHOTS),
    JOB_TIMEOUT_MS: blankToUndefined(process.env.JOB_TIMEOUT_MS),
    JOB_STALE_MS: blankToUndefined(process.env.JOB_STALE_MS),
  });

  // Config problems must never hard-crash the app; fall back to defaults.
  const base = parsed.success ? parsed.data : EnvSchema.parse({});

  const root = process.cwd();
  cached = {
    ...base,
    // turbopackIgnore: these resolve runtime-configured data directories, not
    // bundled modules. Without the hint the bundler traces the whole project.
    storageDir: path.resolve(/* turbopackIgnore: true */ root, base.STORAGE_DIR),
    outputDir: path.resolve(/* turbopackIgnore: true */ root, base.OUTPUT_DIR),
    hasDirectorKey: Boolean(base.ANTHROPIC_API_KEY),
  };
  return cached;
}

/** Test helper — forget the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
}
