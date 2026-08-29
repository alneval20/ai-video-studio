"""
AI Video Studio — GPU worker.

A small FastAPI service that turns normalised generation requests into video on
an NVIDIA GPU. It is intentionally vendor-neutral: the same container runs on a
LAN machine, RunPod, Vast.ai, Lambda, or anything else with CUDA.

Run it:
    pip install -r requirements.txt
    VIDEO_MODEL_ID=Wan-AI/Wan2.1-T2V-1.3B-Diffusers uvicorn app.main:app --host 0.0.0.0 --port 8000

Then in the TypeScript app's .env.local:
    VIDEO_PROVIDER=remote-worker
    REMOTE_WORKER_URL=http://<gpu-host>:8000
"""

from __future__ import annotations

import logging
import os
import secrets
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.responses import FileResponse

from .config import settings
from .jobs import registry
from .pipeline import ModelUnavailable, WorkerError, manager, torch
from .schemas import (
    CancelResponse,
    GenerationRequest,
    HealthResponse,
    JobAccepted,
    JobState,
    ReadyResponse,
)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-5s %(name)s — %(message)s",
)
log = logging.getLogger("worker")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    registry.startup()
    log.info("Device: %s", manager.device)

    if not settings.auth_token:
        log.warning(
            "WORKER_AUTH_TOKEN is not set — this worker accepts unauthenticated "
            "generation requests. Acceptable on a private LAN; never on a public IP."
        )

    if settings.eager_load:
        try:
            manager.ensure_loaded()
        except ModelUnavailable as exc:
            # Never crash on startup: the whole point of /health and /ready is
            # to report this accurately so the app can tell the user what is
            # missing rather than the container crash-looping.
            log.warning("Starting without a model — %s", exc)

    try:
        yield
    finally:
        log.info("Shutting down; cancelling in-flight jobs.")
        registry.shutdown()


app = FastAPI(title="AI Video Studio Worker", version="1.1.0", lifespan=lifespan)


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    """Shared-bearer auth. Disabled when WORKER_AUTH_TOKEN is unset."""
    if not settings.auth_token:
        return
    expected = f"Bearer {settings.auth_token}"
    # Constant-time comparison: a naive `!=` leaks the token a byte at a time
    # to anyone who can measure response latency.
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token.")


# --------------------------------------------------------------------------
# Health and readiness
# --------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness. Always 200 while the process is up, whatever the model state."""
    free, total = manager.vram_gb()
    active, queued = registry.counts()
    return HealthResponse(
        status="ok" if manager.loaded else "degraded",
        device=manager.device,
        model_loaded=manager.loaded,
        model_id=settings.model_id or None,
        detail=manager.status_detail(),
        torch_version=getattr(torch, "__version__", None) if torch else None,
        cuda_available=bool(torch and torch.cuda.is_available()),
        vram_total_gb=total,
        vram_free_gb=free,
        active_jobs=active,
        queued_jobs=queued,
    )


@app.get("/ready", response_model=ReadyResponse)
async def ready(response: Response) -> ReadyResponse:
    """
    Readiness. 503 until the worker can actually generate.

    Separate from /health so an orchestrator can restart a dead process
    (liveness) without also restarting one that is merely still downloading
    weights (readiness).
    """
    is_ready = manager.loaded and manager.device == "cuda"
    if not is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(
        ready=is_ready,
        detail=manager.status_detail(),
        device=manager.device,
        model_id=settings.model_id or None,
    )


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------


@app.post("/jobs", response_model=JobAccepted, dependencies=[Depends(require_auth)])
async def create_job(request: GenerationRequest) -> JobAccepted:
    # Frames and duration must agree, or the caller silently gets a clip of a
    # different length than the shot plan allocated.
    expected_frames = round(request.duration_sec * request.fps)
    if abs(request.num_frames - expected_frames) > max(2, expected_frames * 0.2):
        raise HTTPException(
            status_code=422,
            detail=(
                f"num_frames ({request.num_frames}) is inconsistent with "
                f"duration_sec x fps ({expected_frames})."
            ),
        )

    # Reclaim expired artifacts opportunistically, so a long-lived worker needs
    # no external scheduler to avoid filling its disk.
    registry.sweep()

    try:
        job = registry.submit(request)
    except WorkerError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    log.info(
        "Queued %s for shot %s (%dx%d, %d frames)",
        job.id,
        request.shot_id,
        request.width,
        request.height,
        request.num_frames,
    )
    return JobAccepted(job_id=job.id)


@app.get("/jobs/{job_id}", response_model=JobState, dependencies=[Depends(require_auth)])
async def get_job(job_id: str) -> JobState:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such job.")
    return job.to_state()


@app.post(
    "/jobs/{job_id}/cancel",
    response_model=CancelResponse,
    dependencies=[Depends(require_auth)],
)
async def cancel_job(job_id: str) -> CancelResponse:
    """
    Requests cancellation.

    A queued job stops immediately. A running one stops at its next diffusion
    step — the only point at which a running generation is interruptible.
    """
    job = registry.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such job.")
    return CancelResponse(
        job_id=job.id,
        cancelled=job.cancel_event.is_set(),
        status=job.status,  # type: ignore[arg-type]
    )


@app.get("/jobs/{job_id}/artifact", dependencies=[Depends(require_auth)])
async def get_artifact(job_id: str) -> FileResponse:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such job.")
    if job.status != "succeeded" or not job.artifact or not job.artifact.exists():
        raise HTTPException(
            status_code=409,
            detail=f"Job is '{job.status}'; no artifact available.",
        )
    return FileResponse(job.artifact, media_type="video/mp4", filename=f"{job_id}.mp4")


@app.post("/maintenance/sweep", dependencies=[Depends(require_auth)])
async def sweep() -> dict[str, int]:
    return {"removed": registry.sweep()}
