import { getEnv } from "@/lib/config/env";
import { describeError } from "@/lib/core/errors";
import { ID } from "@/lib/core/ids";
import { createLogger } from "@/lib/core/logger";
import { jobs as jobRepo } from "@/lib/storage/repositories";
import { executeJob, planJob } from "./pipeline";
import { computeProgress, TERMINAL_JOB_STATUSES, type GenerationJob, type JobRequest } from "./types";

const log = createLogger("runner");

/**
 * The job runner.
 *
 * For the local MVP this is an in-process background runner: the API route
 * creates the job, plans it synchronously (fast, and it is what the UI wants to
 * show immediately), then kicks execution off without awaiting it. The client
 * polls the job record.
 *
 * The important property is that the *architecture* does not depend on this
 * being in-process. Jobs are persisted, addressable and resumable, so replacing
 * this file with a queue consumer on a GPU host requires no changes elsewhere.
 */

/** Tracks running jobs so they can be cancelled within this process. */
const running = new Map<string, AbortController>();

export function createJobRecord(projectId: string, request: JobRequest): GenerationJob {
  const now = new Date().toISOString();
  return {
    id: ID.job(),
    projectId,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    request,
    spec: null,
    compiled: null,
    planNotes: [],
    provider: null,
    shots: [],
    output: null,
    progress: 0,
    logs: [],
  };
}

/**
 * Creates and plans a job, then starts generation in the background.
 * Returns as soon as the plan exists — typically well under a second with the
 * heuristic director, a few seconds with the LLM director.
 */
export async function startJob(projectId: string, request: JobRequest): Promise<GenerationJob> {
  const job = createJobRecord(projectId, request);
  await jobRepo.insert(job);

  let planned: GenerationJob;
  try {
    planned = await planJob(job.id);
  } catch (error) {
    const described = describeError(error);
    log.error("Planning failed.", { jobId: job.id, ...described });
    return jobRepo.update(job.id, (j) => ({
      ...j,
      status: "failed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: described,
      logs: [
        ...j.logs,
        { ts: new Date().toISOString(), level: "error" as const, message: described.message },
      ],
    }));
  }

  void runInBackground(planned.id);
  return planned;
}

/** Runs (or re-runs) execution for an already-planned job. */
export async function runInBackground(jobId: string): Promise<void> {
  if (running.has(jobId)) {
    log.warn("Job is already running; ignoring the duplicate start.", { jobId });
    return;
  }

  const controller = new AbortController();
  running.set(jobId, controller);

  // A provider that never returns must not wedge the job forever. The abort
  // propagates all the way into the provider's in-flight HTTP calls.
  const timeoutMs = getEnv().JOB_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      log.error("Job exceeded its time limit; aborting.", { jobId, timeoutMs });
      controller.abort(new DOMException("Job timeout", "TimeoutError"));
    }
  }, timeoutMs);

  try {
    await executeJob(jobId, controller.signal);
    log.info("Job finished.", { jobId });
  } catch (error) {
    const described = describeError(error);
    log.error("Job execution failed.", { jobId, ...described });
    await jobRepo
      .update(jobId, (j) => ({
        ...j,
        status: "failed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: described,
        progress: computeProgress(j),
        logs: [
          ...j.logs,
          { ts: new Date().toISOString(), level: "error" as const, message: described.message },
        ],
      }))
      .catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    running.delete(jobId);
  }
}

/**
 * Marks abandoned jobs as failed.
 *
 * A job in a non-terminal state that no runner in this process owns, and that
 * has not been touched for `JOB_STALE_MS`, cannot make progress — the usual
 * cause is the server restarting mid-generation. Without this they sit at
 * "generating" forever and the UI polls them indefinitely.
 *
 * Called from the job read endpoints, so recovery needs no scheduler.
 */
export async function reconcileStaleJobs(): Promise<number> {
  const { JOB_STALE_MS } = getEnv();
  const cutoff = Date.now() - JOB_STALE_MS;

  const candidates = (await jobRepo.all().catch(() => [])).filter(
    (job) =>
      !TERMINAL_JOB_STATUSES.has(job.status) &&
      !running.has(job.id) &&
      Date.parse(job.updatedAt) < cutoff,
  );

  for (const job of candidates) {
    log.warn("Reclaiming an abandoned job.", { jobId: job.id, status: job.status });
    await jobRepo
      .update(job.id, (current) =>
        TERMINAL_JOB_STATUSES.has(current.status)
          ? current
          : {
              ...current,
              status: "failed" as const,
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              error: {
                code: "INTERRUPTED",
                message:
                  "Generation was interrupted — the server stopped while this job was running.",
                remedy: "Start it again; completed shots are not reused, so it restarts from the top.",
                retryable: true,
              },
              logs: [
                ...current.logs,
                {
                  ts: new Date().toISOString(),
                  level: "error" as const,
                  message: "Job abandoned: no runner owned it and it went stale.",
                },
              ],
            },
      )
      .catch(() => undefined);
  }

  return candidates.length;
}

export function cancelJob(jobId: string): boolean {
  const controller = running.get(jobId);
  if (!controller) return false;
  controller.abort();
  running.delete(jobId);
  log.info("Job cancelled.", { jobId });
  return true;
}

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

/** Default request shape, so callers only send what the user actually changed. */
export function normaliseRequest(input: Partial<JobRequest> & { prompt: string }): JobRequest {
  return {
    prompt: input.prompt.trim(),
    brandProfileId: input.brandProfileId ?? null,
    format: input.format ?? null,
    durationSec: input.durationSec ?? null,
    realismLevel: input.realismLevel ?? null,
    referenceIds: input.referenceIds ?? [],
    providerId: input.providerId ?? getEnv().VIDEO_PROVIDER,
    advanced: {
      cameraPresetId: input.advanced?.cameraPresetId ?? null,
      shotCount: input.advanced?.shotCount ?? null,
      seed: input.advanced?.seed ?? null,
      consistencyStrength: input.advanced?.consistencyStrength ?? null,
      referenceStrength: input.advanced?.referenceStrength ?? null,
      motionBudget: input.advanced?.motionBudget ?? null,
      negativePrompt: input.advanced?.negativePrompt ?? null,
      directorMode: input.advanced?.directorMode ?? null,
    },
  };
}
