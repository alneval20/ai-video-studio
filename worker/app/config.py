"""Worker configuration, read from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    """
    Read once at import. Not frozen: tests and embedding hosts need to override
    a field without rebuilding the module graph, and nothing in the request path
    mutates it.
    """

    #: Hugging Face id of the video model to load, e.g.
    #: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers" or "Lightricks/LTX-Video".
    #: Empty means no model — the worker starts and reports honestly.
    model_id: str = field(default_factory=lambda: os.getenv("VIDEO_MODEL_ID", "").strip())

    #: Shared bearer token. Empty disables auth (fine on a private LAN, not on
    #: a public IP).
    auth_token: str = field(default_factory=lambda: os.getenv("WORKER_AUTH_TOKEN", "").strip())

    output_dir: Path = field(
        default_factory=lambda: Path(os.getenv("WORKER_OUTPUT_DIR", "./worker_outputs")).resolve()
    )
    cache_dir: str | None = field(default_factory=lambda: os.getenv("HF_HOME") or None)

    #: Load the model at startup rather than on the first request. Startup is
    #: slower but the first generation is not.
    eager_load: bool = field(default_factory=lambda: _bool("WORKER_EAGER_LOAD", True))

    #: Trade VRAM for speed. Essential on cards under 24 GB.
    enable_cpu_offload: bool = field(default_factory=lambda: _bool("WORKER_CPU_OFFLOAD", True))
    enable_vae_slicing: bool = field(default_factory=lambda: _bool("WORKER_VAE_SLICING", True))

    max_concurrent_jobs: int = field(
        default_factory=lambda: int(os.getenv("WORKER_MAX_CONCURRENT", "1"))
    )
    #: How long a finished job's artifact is kept before cleanup.
    artifact_ttl_sec: int = field(
        default_factory=lambda: int(os.getenv("WORKER_ARTIFACT_TTL", "3600"))
    )

    #: Hard ceiling on one generation, including time spent queued for the GPU.
    #: Enforced at diffusion-step granularity.
    job_timeout_sec: int = field(
        default_factory=lambda: int(os.getenv("WORKER_JOB_TIMEOUT_SEC", "1800"))
    )

    #: Upper bound on retained job records, so a long-lived worker cannot grow
    #: without bound. Only terminal jobs are evicted.
    max_tracked_jobs: int = field(
        default_factory=lambda: int(os.getenv("WORKER_MAX_TRACKED_JOBS", "200"))
    )


settings = Settings()
