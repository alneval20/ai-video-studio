"""
Job registry and bounded execution.

One worker process owns one GPU, and a GPU runs one video generation at a time.
The executor pool bounds *admission*; `VideoPipelineManager` serialises the
actual inference, so raising `WORKER_MAX_CONCURRENT` lets requests queue without
ever running two generations through one (non-thread-safe) pipeline object.

If you later run several GPUs, put a real queue (Redis/RQ, Celery, SQS) behind
the same HTTP contract — the TypeScript side does not change.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings
from .pipeline import WorkerError, manager
from .schemas import RETRYABLE_CODES, ErrorCode, GenerationRequest, JobState

log = logging.getLogger("worker.jobs")


@dataclass
class Job:
    id: str
    request: GenerationRequest
    status: str = "queued"
    progress: float = 0.0
    stage: str = "Queued"
    error: str | None = None
    error_code: ErrorCode | None = None
    artifact: Path | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    #: Set by /jobs/{id}/cancel; observed inside the diffusion step callback.
    cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def terminal(self) -> bool:
        return self.status in {"succeeded", "failed", "cancelled"}

    def to_state(self) -> JobState:
        return JobState(
            job_id=self.id,
            status=self.status,  # type: ignore[arg-type]
            progress=round(self.progress, 3),
            stage=self.stage,
            error=self.error,
            error_code=self.error_code,
            retryable=self.error_code in RETRYABLE_CODES if self.error_code else False,
            duration_sec=self.request.duration_sec if self.status == "succeeded" else None,
            width=self.request.width if self.status == "succeeded" else None,
            height=self.request.height if self.status == "succeeded" else None,
            fps=self.request.fps if self.status == "succeeded" else None,
            num_frames=self.request.num_frames if self.status == "succeeded" else None,
            codec="h264" if self.status == "succeeded" else None,
            model_id=settings.model_id or None,
            model_profile=settings.model_profile or None,
            device=manager.device,
            queue_ms=int((self.started_at - self.created_at) * 1000)
            if self.started_at
            else None,
        )


class JobRegistry:
    """
    Owns the job table and the execution pool.

    The pool is created lazily and can be recreated after `shutdown()`. That
    matters: this registry is a module-level singleton, and a shut-down
    `ThreadPoolExecutor` can never accept work again — so an in-process app
    restart (uvicorn --reload, an embedding host, a second lifespan) used to
    leave the worker permanently rejecting every job with a raw
    `RuntimeError: cannot schedule new futures after shutdown`.
    """

    def __init__(self) -> None:
        # Insertion-ordered so the oldest finished job is the first evicted.
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.Lock()
        self._pool: ThreadPoolExecutor | None = None
        self._closed = False

    def _ensure_pool(self) -> ThreadPoolExecutor:
        """Creates the pool on first use, and again after a restart."""
        if self._pool is None:
            self._pool = ThreadPoolExecutor(
                max_workers=max(1, settings.max_concurrent_jobs),
                thread_name_prefix="gen",
            )
        return self._pool

    def startup(self) -> None:
        """Reopens the registry after a previous shutdown."""
        with self._lock:
            self._closed = False

    # ------------------------------------------------------------ admission

    def submit(self, request: GenerationRequest) -> Job:
        with self._lock:
            if self._closed:
                raise WorkerError(
                    ErrorCode.INTERNAL, "The worker is shutting down and is not accepting jobs."
                )
            job = Job(id=f"wjob_{uuid.uuid4().hex[:12]}", request=request)
            self._jobs[job.id] = job
            self._evict_locked()
            pool = self._ensure_pool()

        pool.submit(self._run, job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        """
        Requests cancellation. A queued job stops immediately; a running one
        stops at its next diffusion step, which is the only interruptible point.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.terminal:
                return job
            job.cancel_event.set()
            if job.status == "queued":
                job.status = "cancelled"
                job.stage = "Cancelled before it started"
                job.error_code = ErrorCode.CANCELLED
                job.finished_at = time.time()
        return job

    def counts(self) -> tuple[int, int]:
        """(running, queued) — surfaced on /health for queue observability."""
        with self._lock:
            running = sum(1 for j in self._jobs.values() if j.status == "running")
            queued = sum(1 for j in self._jobs.values() if j.status == "queued")
        return running, queued

    # ------------------------------------------------------------- execution

    def _run(self, job: Job) -> None:
        if job.cancel_event.is_set():
            # Cancelled while queued; `cancel()` already recorded the state.
            return

        job.status = "running"
        job.started_at = time.time()
        job.stage = "Preparing"

        deadline = time.monotonic() + settings.job_timeout_sec

        try:
            req = job.request
            output = settings.output_dir / f"{job.id}.mp4"

            init_frame = next(
                (r for r in req.references if r.usage.value == "init_frame"),
                None,
            )

            manager.generate(
                prompt=req.prompt,
                negative_prompt=req.negative_prompt,
                width=req.width,
                height=req.height,
                num_frames=req.num_frames,
                fps=req.fps,
                seed=req.seed,
                guidance_scale=req.provider_options.guidance_scale,
                guidance_scale_2=req.provider_options.guidance_scale_2,
                num_inference_steps=req.provider_options.num_inference_steps,
                init_image_b64=init_frame.image_base64 if init_frame else None,
                output_path=output,
                deadline=deadline,
                cancel_event=job.cancel_event,
                on_progress=lambda fraction, stage: self._progress(job, fraction, stage),
            )

            job.artifact = output
            job.status = "succeeded"
            job.progress = 1.0
            job.stage = "Complete"
            log.info("Job %s finished in %.1fs", job.id, time.time() - (job.started_at or 0))

        except WorkerError as exc:
            job.error_code = exc.code
            job.error = str(exc)
            job.status = "cancelled" if exc.code is ErrorCode.CANCELLED else "failed"
            job.stage = exc.code.value
            log.warning("Job %s ended: %s (%s)", job.id, exc, exc.code.value)
        except Exception as exc:  # noqa: BLE001
            job.error_code = ErrorCode.INTERNAL
            job.error = f"{type(exc).__name__}: {exc}"
            job.status = "failed"
            log.exception("Job %s failed.", job.id)
        finally:
            job.finished_at = time.time()

    @staticmethod
    def _progress(job: Job, fraction: float, stage: str) -> None:
        job.progress = max(0.0, min(1.0, fraction))
        job.stage = stage

    # ------------------------------------------------------------- retention

    def sweep(self) -> int:
        """Drops finished jobs (and their artifacts) past the TTL."""
        cutoff = time.time() - settings.artifact_ttl_sec
        with self._lock:
            expired = [
                jid
                for jid, j in self._jobs.items()
                if j.finished_at is not None and j.finished_at < cutoff
            ]
            return sum(1 for jid in expired if self._drop_locked(jid))

    def _evict_locked(self) -> None:
        """
        Caps the registry so a long-lived worker cannot grow without bound.
        Only terminal jobs are evicted — an in-flight job is never dropped.
        """
        if len(self._jobs) <= settings.max_tracked_jobs:
            return
        for jid in list(self._jobs.keys()):
            if len(self._jobs) <= settings.max_tracked_jobs:
                break
            if self._jobs[jid].terminal:
                self._drop_locked(jid)

    def _drop_locked(self, job_id: str) -> bool:
        job = self._jobs.pop(job_id, None)
        if job is None:
            return False
        if job.artifact is not None:
            try:
                job.artifact.unlink(missing_ok=True)
            except OSError:
                log.debug("Could not remove artifact for %s", job_id, exc_info=True)
        return True

    def shutdown(self) -> None:
        """Cancels in-flight work and stops accepting more."""
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                if not job.terminal:
                    job.cancel_event.set()
            pool, self._pool = self._pool, None

        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


registry = JobRegistry()
