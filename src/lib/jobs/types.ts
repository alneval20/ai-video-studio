import type { LogLevel } from "@/lib/core/logger";
import type { CompiledSpecPrompts } from "@/lib/prompts/prompt-compiler";
import type { QualityReport } from "@/lib/quality/types";
import type { VideoGenerationSpec } from "@/lib/spec/spec";
import type { DeliveryFormat, RealismLevel } from "@/lib/spec/vocab";

/**
 * Job states.
 *
 * Generation is long-running, so nothing here assumes a single synchronous
 * HTTP request. A job is created, persisted, and advanced by a runner; the UI
 * polls it. Swapping the in-process runner for a queue and remote workers means
 * changing `runner.ts`, not this model.
 */
export const JOB_STATUSES = [
  "draft",
  "planning",
  "queued",
  "generating",
  "quality_check",
  "composing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const SHOT_STATUSES = [
  "pending",
  "queued",
  "generating",
  "quality_check",
  "repairing",
  "completed",
  "failed",
] as const;
export type ShotStatus = (typeof SHOT_STATUSES)[number];

export interface JobLogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface JobError {
  code: string;
  message: string;
  remedy?: string;
  retryable: boolean;
}

/** One generation attempt for one shot. Attempts are kept for the plan inspector. */
export interface ShotAttempt {
  id: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed";
  /** Path relative to OUTPUT_DIR, safe to expose. */
  outputPath: string | null;
  isRealGeneration: boolean;
  diagnostics: string[];
  quality: QualityReport | null;
  /** What the repair planner changed before this attempt. */
  repairChanges: string[];
  error?: JobError;
  elapsedMs: number;
}

export interface ShotJob {
  shotId: string;
  index: number;
  title: string;
  status: ShotStatus;
  /** 0..1 within this shot. */
  progress: number;
  durationSec: number;
  attempts: ShotAttempt[];
  /** The accepted output, relative to OUTPUT_DIR. */
  outputPath: string | null;
  quality: QualityReport | null;
  error?: JobError;
}

/** Exactly what the user asked for, before the director touched it. */
export interface JobRequest {
  prompt: string;
  brandProfileId: string | null;
  format: DeliveryFormat | null;
  durationSec: number | null;
  realismLevel: RealismLevel | null;
  referenceIds: string[];
  providerId: string | null;
  advanced: {
    cameraPresetId: string | null;
    shotCount: number | null;
    seed: number | null;
    consistencyStrength: number | null;
    referenceStrength: number | null;
    motionBudget: number | null;
    negativePrompt: string | null;
    directorMode: "auto" | "llm" | "heuristic" | null;
  };
}

export interface JobOutput {
  /** Final composed video, relative to OUTPUT_DIR. */
  finalPath: string | null;
  posterPath: string | null;
  width: number;
  height: number;
  durationSec: number;
  /** False when any contributing clip came from the mock provider. */
  isRealGeneration: boolean;
  /** Notes from the composer, including skipped steps. */
  notes: string[];
}

export interface GenerationJob {
  id: string;
  projectId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;

  request: JobRequest;

  /** Populated once the director runs. */
  spec: VideoGenerationSpec | null;
  compiled: CompiledSpecPrompts | null;
  /** Decisions the director/planner made, shown in the plan inspector. */
  planNotes: string[];

  /** Which provider actually ran, and whether we fell back to mock. */
  provider: {
    requestedId: string;
    resolvedId: string;
    fellBack: boolean;
    fallbackReason: string | null;
    producesRealVideo: boolean;
  } | null;

  shots: ShotJob[];
  output: JobOutput | null;
  /** 0..1 across the whole job. */
  progress: number;
  logs: JobLogEntry[];
  error?: JobError;
}

/** Lightweight shape for list views — the spec and logs are large. */
export interface JobSummary {
  id: string;
  projectId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  logline: string | null;
  shotCount: number;
  progress: number;
  isRealGeneration: boolean;
  thumbnailPath: string | null;
}

export function toSummary(job: GenerationJob): JobSummary {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    prompt: job.request.prompt,
    logline: job.spec?.creative.logline ?? null,
    shotCount: job.shots.length,
    progress: job.progress,
    isRealGeneration: job.output?.isRealGeneration ?? job.provider?.producesRealVideo ?? false,
    thumbnailPath: job.output?.posterPath ?? null,
  };
}

/** Weighted overall progress. Generation dominates because it dominates wall-clock. */
export function computeProgress(job: GenerationJob): number {
  switch (job.status) {
    case "draft":
      return 0;
    case "planning":
      return 0.05;
    case "queued":
      return 0.1;
    case "completed":
      return 1;
    case "failed":
    case "cancelled":
      return job.progress;
    default:
      break;
  }

  const shotProgress =
    job.shots.length === 0
      ? 0
      : job.shots.reduce((sum, s) => sum + (s.status === "completed" ? 1 : s.progress), 0) /
        job.shots.length;

  // 10% planning, 75% generation+QC, 15% composition.
  const base = 0.1 + shotProgress * 0.75;
  return Number(Math.min(job.status === "composing" ? 0.95 : base, 0.99).toFixed(3));
}
