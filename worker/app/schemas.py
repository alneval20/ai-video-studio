"""
Wire contract between the TypeScript app and this worker.

This file is the single source of truth for the HTTP payloads. Its TypeScript
counterpart is `src/lib/providers/remote-worker/remote-worker-provider.ts`, and
`tests/worker-contract.test.ts` asserts the two agree — a field renamed here
without renaming it there fails the test suite.

The contract is deliberately provider-neutral: it carries the *normalised*
generation request (prompt, camera intent, motion intent, guidance dials), not
model-specific parameters. Mapping those onto a particular pipeline's arguments
is the worker's job, which is what keeps the app independent of the model.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ReferenceUsage(str, Enum):
    INIT_FRAME = "init_frame"
    IDENTITY = "identity"
    STYLE = "style"
    LAYOUT = "layout"
    DESCRIPTIVE_ONLY = "descriptive_only"


class ErrorCode(str, Enum):
    """
    Structured failure reasons.

    The TypeScript adapter maps these onto its own retry policy, so a caller can
    tell "the GPU ran out of memory, try a smaller shot" apart from "the model
    is not loaded, fix your deployment".
    """

    OOM = "oom"
    """CUDA ran out of memory. Retryable at a smaller resolution or frame count."""
    TIMEOUT = "timeout"
    """Generation exceeded its deadline."""
    CANCELLED = "cancelled"
    """The caller cancelled the job."""
    MODEL_UNAVAILABLE = "model_unavailable"
    """No usable model/device. Not retryable without fixing the deployment."""
    INVALID_REQUEST = "invalid_request"
    """The request could not be satisfied as specified."""
    INTERNAL = "internal"
    """Anything else."""


#: Failures where retrying the same job could plausibly succeed.
RETRYABLE_CODES: frozenset[ErrorCode] = frozenset(
    {ErrorCode.OOM, ErrorCode.TIMEOUT, ErrorCode.INTERNAL}
)


class ReferenceImage(BaseModel):
    id: str
    role: str
    usage: ReferenceUsage
    #: 0..1 conditioning strength; the pipeline maps this onto model scales.
    weight: float = Field(ge=0.0, le=1.0)
    mime_type: str
    #: Base64 so the worker needs no shared filesystem with the app — that is
    #: what allows it to run on a rented GPU in another datacentre.
    image_base64: str


class Guidance(BaseModel):
    prompt_adherence: float = Field(ge=0.0, le=1.0)
    reference_adherence: float = Field(ge=0.0, le=1.0)
    consistency_strength: float = Field(ge=0.0, le=1.0)


class ModelOptions(BaseModel):
    """Sampler controls for the one supported, verified production profile."""

    model_config = ConfigDict(extra="forbid")

    model_profile: Literal["wan2.2-i2v-a14b-720p"]
    num_inference_steps: int = Field(default=40, ge=20, le=60)
    guidance_scale: float = Field(default=5.0, ge=1.0, le=10.0)
    guidance_scale_2: float = Field(default=5.0, ge=1.0, le=10.0)


class GenerationRequest(BaseModel):
    request_id: str
    shot_id: str

    prompt: str
    negative_prompt: str = ""

    width: int = Field(ge=64, le=2048)
    height: int = Field(ge=64, le=2048)
    fps: int = Field(ge=1, le=60)
    duration_sec: float = Field(gt=0, le=30)
    num_frames: int = Field(ge=1, le=1024)
    seed: int = Field(ge=0)

    guidance: Guidance

    #: Structured camera and motion intent. Opaque here, but available to any
    #: pipeline that can condition on it (e.g. camera-control LoRAs).
    camera: dict[str, Any] = Field(default_factory=dict)
    motion: dict[str, Any] = Field(default_factory=dict)

    references: list[ReferenceImage] = Field(default_factory=list)
    provider_options: ModelOptions


JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class JobAccepted(BaseModel):
    job_id: str
    status: JobStatus = "queued"


class JobState(BaseModel):
    job_id: str
    status: JobStatus
    progress: float = 0.0
    stage: str = ""
    error: str | None = None
    #: Machine-readable counterpart to `error`. See ErrorCode.
    error_code: ErrorCode | None = None
    #: Whether retrying this exact job could succeed.
    retryable: bool = False

    duration_sec: float | None = None
    width: int | None = None
    height: int | None = None
    fps: int | None = None
    num_frames: int | None = None
    codec: str | None = None
    model_id: str | None = None
    model_profile: str | None = None
    device: str | None = None
    queue_ms: int | None = None


class CancelResponse(BaseModel):
    job_id: str
    cancelled: bool
    status: JobStatus


class HealthResponse(BaseModel):
    """Liveness. Always 200 while the process is up."""

    status: Literal["ok", "degraded"]
    device: str
    #: False until a video model is actually resident in VRAM.
    model_loaded: bool
    model_id: str | None = None
    model_profile: str | None = None
    #: Human-readable explanation of anything missing.
    detail: str = ""
    torch_version: str | None = None
    cuda_available: bool = False
    vram_total_gb: float | None = None
    vram_free_gb: float | None = None
    #: Queue observability, so a caller can see whether it is waiting on a queue.
    active_jobs: int = 0
    queued_jobs: int = 0


class ReadyResponse(BaseModel):
    """Readiness. 503 until the worker can actually accept generation work."""

    ready: bool
    detail: str
    device: str
    model_id: str | None = None
    model_profile: str | None = None
