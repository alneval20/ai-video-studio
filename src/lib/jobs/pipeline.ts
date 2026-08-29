import path from "node:path";
import { getBrand } from "@/lib/brands";
import { compose } from "@/lib/compose/composer";
import { getEnv } from "@/lib/config/env";
import { describeError, StudioError } from "@/lib/core/errors";
import { ID } from "@/lib/core/ids";
import { createLogger } from "@/lib/core/logger";
import { resolveReferencePath } from "@/lib/references/paths";
import { assembleSpec, createDirector } from "@/lib/director";
import { compileShot, compileSpec } from "@/lib/prompts/prompt-compiler";
import { resolveProvider } from "@/lib/providers/registry";
import type { GenerationRequest, ProviderReference, VideoProvider } from "@/lib/providers/types";
import { getEvaluator, planRepair, type QualityReport } from "@/lib/quality";
import type { StoredReference } from "@/lib/references/types";
import { referencesForShot, type Shot, type VideoGenerationSpec } from "@/lib/spec/spec";
import { jobs as jobRepo, references as refRepo } from "@/lib/storage/repositories";
import { ensureDir, finalOutputPath, generationDir, shotOutputPath, toRelative } from "@/lib/storage/paths";
import {
  computeProgress,
  TERMINAL_JOB_STATUSES,
  type GenerationJob,
  type JobError,
  type ShotAttempt,
  type ShotJob,
} from "./types";

const log = createLogger("pipeline");

/**
 * The generation pipeline.
 *
 *   plan (director -> spec -> shot plan -> compiled prompts)
 *     -> generate each shot (provider)
 *       -> evaluate (quality)
 *         -> repair only the failing shot
 *           -> compose
 *
 * Every state transition is persisted, so the UI can poll and a crash leaves an
 * inspectable record rather than a hung request.
 */

/** Appends a log line to the job record and the process log in one call. */
async function record(
  jobId: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  log[level](message, { jobId, ...data });
  await jobRepo
    .update(jobId, (job) => ({
      ...job,
      updatedAt: new Date().toISOString(),
      logs: [...job.logs, { ts: new Date().toISOString(), level, message, data }].slice(-400),
    }))
    .catch(() => undefined);
}

async function patch(jobId: string, mutate: (job: GenerationJob) => GenerationJob): Promise<GenerationJob> {
  return jobRepo.update(jobId, (job) => {
    // Once a job reaches a terminal state its status is final. Without this,
    // an in-flight shot finishing after a cancel would overwrite "cancelled"
    // with "completed" — the classic cancel race.
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      const next = mutate(job);
      return {
        ...next,
        status: job.status,
        completedAt: job.completedAt,
        error: job.error,
        updatedAt: new Date().toISOString(),
      };
    }
    const next = mutate(job);
    return { ...next, updatedAt: new Date().toISOString(), progress: computeProgress(next) };
  });
}

/** True when the job has been cancelled or otherwise finished elsewhere. */
async function isTerminal(jobId: string): Promise<boolean> {
  const job = await jobRepo.find(jobId);
  return job === null || TERMINAL_JOB_STATUSES.has(job.status);
}

/**
 * Phase 1 — planning. Turns the user's request into a validated spec and
 * compiled prompts. Runs in a couple of seconds and is safe to await inline.
 */
export async function planJob(jobId: string): Promise<GenerationJob> {
  const job = await jobRepo.require(jobId);
  await patch(jobId, (j) => ({ ...j, status: "planning", startedAt: new Date().toISOString() }));
  await record(jobId, "info", "Planning started.");

  const brand = await getBrand(job.request.brandProfileId);
  const storedRefs = await loadReferences(job.request.referenceIds);

  // Negotiate the provider BEFORE building the spec, so reference bindings and
  // resolutions reflect what the backend can actually honour.
  const resolution = await resolveProvider(job.request.providerId ?? undefined);
  const provider = resolution.provider;

  if (resolution.fellBack) {
    await record(jobId, "warn", resolution.fallbackReason ?? "Fell back to the development provider.");
  }
  await record(jobId, "info", `Provider: ${provider.capabilities.label}.`, {
    producesRealVideo: provider.capabilities.producesRealVideo,
  });

  // --- director ------------------------------------------------------------
  const director = createDirector(job.request.advanced.directorMode ?? undefined);
  const directed = await director.direct({
    prompt: job.request.prompt,
    brand,
    referenceRoles: storedRefs.map((r) => r.role),
    overrides: {
      format: job.request.format,
      durationSec: job.request.durationSec,
      realismLevel: job.request.realismLevel,
      shotCount: job.request.advanced.shotCount,
    },
  });

  await record(jobId, "info", `Director (${directed.engine}) produced a brief.`, {
    logline: directed.brief.logline,
    elapsedMs: directed.elapsedMs,
  });
  for (const warning of directed.warnings) await record(jobId, "warn", warning);

  // --- spec assembly -------------------------------------------------------
  const { spec, notes } = assembleSpec({
    projectId: job.projectId,
    prompt: job.request.prompt,
    director: directed,
    brand,
    references: storedRefs,
    provider: {
      id: provider.capabilities.id,
      supportsInitFrame: provider.capabilities.supportsInitFrame,
      supportedReferenceUsages: provider.capabilities.supportedReferenceUsages,
      maxGenerationEdge: provider.capabilities.maxGenerationEdge,
      maxFps: provider.capabilities.maxFps,
      maxClipSeconds: provider.capabilities.maxClipSeconds,
    },
    advanced: {
      cameraPresetId: job.request.advanced.cameraPresetId,
      shotCount: job.request.advanced.shotCount,
      seed: job.request.advanced.seed,
      consistencyStrength: job.request.advanced.consistencyStrength,
      referenceStrength: job.request.advanced.referenceStrength,
      motionBudget: job.request.advanced.motionBudget,
      negativePrompt: job.request.advanced.negativePrompt,
      maxShots: getEnv().MAX_SHOTS,
    },
  });

  for (const note of notes) await record(jobId, "info", note);

  const compiled = compileSpec(spec, provider.capabilities);
  await record(jobId, "info", `Compiled ${compiled.shots.length} shot prompt(s).`, {
    approxTokens: compiled.shots.map((s) => s.approxTokens),
  });

  const shots: ShotJob[] = spec.shots.map((shot) => ({
    shotId: shot.id,
    index: shot.index,
    title: shot.title,
    status: "pending",
    progress: 0,
    durationSec: shot.durationSec,
    attempts: [],
    outputPath: null,
    quality: null,
  }));

  return patch(jobId, (j) => ({
    ...j,
    status: "queued",
    spec,
    compiled,
    planNotes: [...j.planNotes, ...notes],
    provider: {
      requestedId: j.request.providerId ?? getEnv().VIDEO_PROVIDER,
      resolvedId: provider.capabilities.id,
      fellBack: resolution.fellBack,
      fallbackReason: resolution.fallbackReason ?? null,
      producesRealVideo: provider.capabilities.producesRealVideo,
    },
    shots,
  }));
}

/**
 * Phase 2 — execution. Generates, evaluates and repairs each shot, then
 * composes. Long-running: callers should not await this inside a request
 * handler (see runner.ts).
 */
export async function executeJob(jobId: string, signal?: AbortSignal): Promise<GenerationJob> {
  let job = await jobRepo.require(jobId);

  if (!job.spec || !job.compiled) {
    throw new StudioError("PLANNING_FAILED", "This job has no plan yet; call planJob first.");
  }

  const spec = job.spec;
  const provider = (await resolveProvider(job.provider?.resolvedId)).provider;

  await patch(jobId, (j) => ({ ...j, status: "generating" }));
  await ensureDir(generationDir(job.projectId, job.id));

  const storedRefs = await loadReferences(job.request.referenceIds);
  const refIndex = new Map(storedRefs.map((r) => [r.id, r]));

  for (const specShot of spec.shots) {
    if (signal?.aborted || (await isTerminal(jobId))) {
      await markCancelled(jobId);
      return jobRepo.require(jobId);
    }
    await runShot({ jobId, spec, shot: specShot, provider, refIndex, signal });
  }

  // A cancel that landed during the last shot must not fall through to compose.
  if (signal?.aborted || (await isTerminal(jobId))) {
    await markCancelled(jobId);
    return jobRepo.require(jobId);
  }

  job = await jobRepo.require(jobId);
  const completedShots = job.shots.filter((s) => s.status === "completed" && s.outputPath);

  if (completedShots.length === 0) {
    return patch(jobId, (j) => ({
      ...j,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: {
        code: "PROVIDER_FAILED",
        message: "No shot produced a usable clip.",
        remedy: "Open the shot logs below to see what each attempt reported.",
        retryable: true,
      },
    }));
  }

  // --- composition ---------------------------------------------------------
  await patch(jobId, (j) => ({ ...j, status: "composing" }));
  await record(jobId, "info", "Composing the final export.");

  const env = getEnv();
  const clipPaths = completedShots
    .sort((a, b) => a.index - b.index)
    .map((s) => path.join(env.outputDir, s.outputPath!));

  const logoRef = spec.post.branding.logoReferenceId
    ? refIndex.get(spec.post.branding.logoReferenceId)
    : undefined;

  const composed = await compose({
    spec,
    clipPaths,
    outputPath: finalOutputPath(job.projectId, job.id),
    logoPath: logoRef ? resolveReferencePath(logoRef) : null,
  });

  for (const note of composed.notes) await record(jobId, "info", note);
  if (composed.error) await record(jobId, "error", `Composition failed: ${composed.error}`);

  if (await isTerminal(jobId)) return jobRepo.require(jobId);

  const anyMock = job.shots.some((s) => s.attempts.some((a) => a.status === "succeeded" && !a.isRealGeneration));

  return patch(jobId, (j) => ({
    ...j,
    status: composed.status === "failed" ? "failed" : "completed",
    completedAt: new Date().toISOString(),
    output: {
      finalPath: composed.outputPath ? toRelative(composed.outputPath) : null,
      posterPath: composed.posterPath ? toRelative(composed.posterPath) : null,
      width: spec.delivery.export.width,
      height: spec.delivery.export.height,
      durationSec: spec.delivery.totalDurationSec,
      isRealGeneration: !anyMock,
      notes: composed.notes,
    },
    error:
      composed.status === "failed"
        ? { code: "COMPOSE_FAILED", message: composed.error ?? "Composition failed.", retryable: true }
        : j.error,
  }));
}

async function markCancelled(jobId: string): Promise<void> {
  await jobRepo
    .update(jobId, (job) =>
      TERMINAL_JOB_STATUSES.has(job.status)
        ? job
        : {
            ...job,
            status: "cancelled" as const,
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
    )
    .catch(() => undefined);
}

/** Generates one shot, with quality gating and targeted repair. */
async function runShot(args: {
  jobId: string;
  spec: VideoGenerationSpec;
  shot: Shot;
  provider: VideoProvider;
  refIndex: Map<string, StoredReference>;
  signal?: AbortSignal;
}): Promise<void> {
  const { jobId, spec, provider, refIndex, signal } = args;
  const evaluator = getEvaluator();

  let shot = args.shot;
  let attempt = 0;
  /** Why the *next* attempt differs. Set by the repair planner below. */
  let pendingRepairChanges: string[] = [];

  while (attempt <= spec.quality.maxRepairAttempts) {
    if (signal?.aborted || (await isTerminal(jobId))) return;

    await setShot(jobId, shot.id, (s) => ({
      ...s,
      status: attempt === 0 ? "generating" : "repairing",
      progress: 0.05,
    }));

    const compiled = compileShot(spec, shot, provider.capabilities);
    const outputPath = shotOutputPath(spec.projectId, jobId, shot.id, attempt);

    const request: GenerationRequest = {
      requestId: ID.providerJob(),
      projectId: spec.projectId,
      specId: spec.id,
      shotId: shot.id,
      attempt,
      prompt: compiled.positive,
      negativePrompt: compiled.negative,
      references: buildProviderReferences(spec, shot, refIndex),
      width: compiled.parameters.width,
      height: compiled.parameters.height,
      fps: compiled.parameters.fps,
      durationSec: compiled.parameters.durationSec,
      seed: compiled.parameters.seed,
      camera: shot.camera,
      motion: shot.motion,
      guidance: {
        promptAdherence: compiled.parameters.promptAdherence,
        referenceAdherence: compiled.parameters.referenceAdherence,
        consistencyStrength: compiled.parameters.consistencyStrength,
      },
      outputPath,
      providerOptions: spec.provider.options,
    };

    const attemptRecord: ShotAttempt = {
      id: ID.attempt(),
      attempt,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      outputPath: null,
      isRealGeneration: provider.capabilities.producesRealVideo,
      diagnostics: [],
      quality: null,
      repairChanges: pendingRepairChanges,
      elapsedMs: 0,
    };
    pendingRepairChanges = [];
    await setShot(jobId, shot.id, (s) => ({ ...s, attempts: [...s.attempts, attemptRecord] }));

    let quality: QualityReport | null = null;
    let failure: JobError | null = null;
    let producedPath: string | null = null;
    let isReal = provider.capabilities.producesRealVideo;

    try {
      const result = await provider.generate(request, {
        signal,
        onProgress: (fraction, message) => {
          void setShot(jobId, shot.id, (s) => ({ ...s, progress: 0.05 + fraction * 0.75 })).catch(
            () => undefined,
          );
          if (message) void record(jobId, "debug", `${shot.title}: ${message}`).catch(() => undefined);
        },
      });

      isReal = result.isRealGeneration;
      producedPath = result.outputPath;
      attemptRecord.diagnostics = result.diagnostics;

      if (result.status === "failed" || !result.outputPath) {
        failure = result.error ?? {
          code: "PROVIDER_FAILED",
          message: "The provider returned no output.",
          retryable: true,
        };
      } else {
        await setShot(jobId, shot.id, (s) => ({ ...s, status: "quality_check", progress: 0.85 }));

        quality = await evaluator.evaluate({
          shotId: shot.id,
          attempt,
          videoPath: result.outputPath,
          expected: {
            durationSec: request.durationSec,
            width: request.width,
            height: request.height,
            fps: request.fps,
          },
          context: buildQualityContext(spec, shot, request, isReal),
          targets: spec.quality,
        });

        await record(
          jobId,
          quality.passed ? "info" : "warn",
          `${shot.title} attempt ${attempt + 1}: quality ${(quality.overall * 100).toFixed(0)}%` +
            ` (${quality.passed ? "passed" : "below target"}, confidence ${quality.confidence}).`,
          { issues: quality.issues.map((i) => i.code) },
        );
      }
    } catch (error) {
      failure = describeError(error);
      await record(jobId, "error", `${shot.title} attempt ${attempt + 1} failed: ${failure.message}`, {
        remedy: failure.remedy,
      });
    }

    // Persist the attempt outcome.
    const succeeded = !failure && quality !== null;
    await setShot(jobId, shot.id, (s) => ({
      ...s,
      attempts: s.attempts.map((a) =>
        a.id === attemptRecord.id
          ? {
              ...a,
              status: succeeded ? "succeeded" : "failed",
              finishedAt: new Date().toISOString(),
              outputPath: producedPath ? toRelative(producedPath) : null,
              isRealGeneration: isReal,
              diagnostics: attemptRecord.diagnostics,
              quality,
              error: failure ?? undefined,
              elapsedMs: Date.now() - new Date(a.startedAt).getTime(),
            }
          : a,
      ),
    }));

    // Accept and stop.
    if (succeeded && quality!.passed) {
      await setShot(jobId, shot.id, (s) => ({
        ...s,
        status: "completed",
        progress: 1,
        outputPath: producedPath ? toRelative(producedPath) : null,
        quality,
      }));
      return;
    }

    // Decide whether to repair.
    const report =
      quality ??
      ({
        id: ID.qualityReport(),
        shotId: shot.id,
        attempt,
        evaluatorId: "none",
        evaluatedAt: new Date().toISOString(),
        overall: 0,
        scores: [],
        issues: [
          {
            code: "missing_output",
            dimension: "technicalIntegrity" as const,
            severity: "critical" as const,
            message: failure?.message ?? "Generation failed.",
            suggestion: "",
          },
        ],
        passed: false,
        confidence: "low" as const,
        notCheckedNotes: [],
      } satisfies QualityReport);

    const repair = planRepair(spec, shot, report, attempt);

    if (!repair.shouldRetry) {
      // Out of attempts: keep the best clip we got rather than discarding work.
      const best = await bestAttempt(jobId, shot.id);
      await setShot(jobId, shot.id, (s) => ({
        ...s,
        status: best ? "completed" : "failed",
        progress: 1,
        outputPath: best?.outputPath ?? null,
        quality: best?.quality ?? report,
        error: best
          ? undefined
          : failure ?? { code: "QUALITY_REJECTED", message: repair.reason ?? "Shot failed.", retryable: true },
      }));
      await record(
        jobId,
        best ? "warn" : "error",
        best
          ? `${shot.title}: keeping the best attempt (${(best.quality?.overall ?? 0) * 100}%) — ${repair.reason}`
          : `${shot.title} failed. ${repair.reason ?? ""}`,
      );
      return;
    }

    await record(jobId, "info", `${shot.title}: repairing — ${repair.changes.join(" ")}`);
    shot = repair.shot;
    attempt += 1;
    // Carried into the next attempt record directly. A module-level map keyed
    // by job/shot/attempt used to hold this, which leaked across jobs and could
    // mis-attribute changes when two jobs ran concurrently.
    pendingRepairChanges = repair.changes;
  }
}

async function setShot(
  jobId: string,
  shotId: string,
  mutate: (shot: ShotJob) => ShotJob,
): Promise<void> {
  await patch(jobId, (job) => ({
    ...job,
    shots: job.shots.map((s) => (s.shotId === shotId ? mutate(s) : s)),
  }));
}

async function bestAttempt(jobId: string, shotId: string): Promise<ShotAttempt | null> {
  const job = await jobRepo.require(jobId);
  const shot = job.shots.find((s) => s.shotId === shotId);
  const candidates = (shot?.attempts ?? []).filter((a) => a.status === "succeeded" && a.outputPath);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, a) =>
    (a.quality?.overall ?? 0) > (best.quality?.overall ?? 0) ? a : best,
  );
}

function buildProviderReferences(
  spec: VideoGenerationSpec,
  shot: Shot,
  refIndex: Map<string, StoredReference>,
): ProviderReference[] {
  return referencesForShot(spec, shot.id)
    .map((directive) => {
      const stored = refIndex.get(directive.referenceId);
      if (!stored) return null;
      return {
        id: directive.referenceId,
        role: directive.role,
        usage: directive.usage,
        weight: directive.weight,
        path: resolveReferencePath(stored),
        mimeType: stored.mimeType,
        description: directive.notes || stored.filename,
      } satisfies ProviderReference;
    })
    .filter((r): r is ProviderReference => r !== null);
}

function buildQualityContext(
  spec: VideoGenerationSpec,
  shot: Shot,
  request: GenerationRequest,
  isReal: boolean,
) {
  const kinds = new Set(
    shot.featuredSubjectKeys
      .map((k) => spec.scene.subjects.find((s) => s.key === k)?.kind)
      .filter(Boolean) as string[],
  );
  const strictDomains = Object.entries(shot.realism.emphasis)
    .filter(([, s]) => s === "strict")
    .map(([d]) => d);

  // Only identity-bearing references are meaningful to compare frames against;
  // a style reference is not supposed to reappear literally.
  const identityRefs = referencesForShot(spec, shot.id).filter(
    (r) => r.usage === "identity" || r.usage === "init_frame",
  );
  const identityRefIds = new Set(identityRefs.map((r) => r.referenceId));

  return {
    realismLevel: spec.realism.level,
    strictDomains,
    hasHuman: kinds.has("human"),
    hasHands: kinds.has("hands"),
    hasProduct: kinds.has("product") || kinds.has("beverage"),
    hasLiquid: kinds.has("liquid") || kinds.has("beverage"),
    hasBranding: kinds.has("text_or_logo"),
    referencePaths: request.references
      .filter((r) => identityRefIds.has(r.id))
      .map((r) => r.path),
    consistencyStrength: spec.consistency.strength,
    isRealGeneration: isReal,
    cameraMoveIntensity: shot.camera.moveIntensity,
    subjectMotion: shot.motion.subjectMotion,
    shotDescription: shot.action,
    preserveNotes: identityRefs.flatMap((r) => r.preserve),
  };
}

async function loadReferences(ids: string[]): Promise<StoredReference[]> {
  if (ids.length === 0) return [];
  const all = await refRepo.all();
  const index = new Map(all.map((r) => [r.id, r]));
  return ids.map((id) => index.get(id)).filter((r): r is StoredReference => Boolean(r));
}
