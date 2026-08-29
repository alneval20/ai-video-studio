"""
Model lifecycle and inference.

WHAT IS REAL HERE AND WHAT IS NOT
=================================
The device detection, VRAM reporting, model loading, memory-saving
configuration, concurrency control, OOM handling, cancellation, deadline
enforcement and video export are all real and will run.

The inference call is intentionally specialised for Diffusers'
`WanImageToVideoPipeline`. The local development machine has no NVIDIA GPU, so
the worker refuses to claim readiness until that exact model is loaded on CUDA.

If no model is configured or CUDA is absent, the worker does not pretend: it
reports it through /health and /ready, and the TypeScript provider surfaces
that to the user instead of silently producing nothing.
"""

from __future__ import annotations

import base64
import binascii
import inspect
import io
import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .config import settings
from .model_profiles import (
    WAN_I2V_MODEL_ID,
    WAN_I2V_PROFILE,
    WAN_MIN_VRAM_GIB,
)
from .schemas import ErrorCode

log = logging.getLogger("worker.pipeline")

# Imported lazily so the worker starts (and can report its own status) even in
# an environment with no torch installed.
try:  # pragma: no cover - depends on the host
    import torch
except Exception:  # noqa: BLE001
    torch = None  # type: ignore[assignment]


class WorkerError(RuntimeError):
    """A failure with a machine-readable code the TypeScript side understands."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ModelUnavailable(WorkerError):
    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.MODEL_UNAVAILABLE, message)


class JobCancelled(WorkerError):
    def __init__(self, message: str = "Cancelled by the caller.") -> None:
        super().__init__(ErrorCode.CANCELLED, message)


class JobTimeout(WorkerError):
    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.TIMEOUT, message)


class OutOfMemory(WorkerError):
    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.OOM, message)


def _is_oom(error: BaseException) -> bool:
    """CUDA OOM surfaces under several types/messages depending on the stack."""
    if torch is not None and isinstance(error, getattr(torch.cuda, "OutOfMemoryError", ())):
        return True
    text = str(error).lower()
    return "out of memory" in text or "cuda error: out of memory" in text


class VideoPipelineManager:
    """
    Owns the model. One instance per process.

    The model is loaded once and reused for every job. Loading is guarded so
    two concurrent first-requests cannot both start a multi-gigabyte load, and
    inference is serialised because Diffusers pipelines hold mutable state and
    are not thread-safe — running two through one pipeline object corrupts both.
    """

    def __init__(self) -> None:
        self._pipeline: Any | None = None
        self._load_error: str | None = None
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    # ---------------------------------------------------------------- status

    @property
    def device(self) -> str:
        if torch is None:
            return "none"
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            # Apple Silicon can run some image models but no current video
            # model at usable speed. Reported honestly rather than attempted.
            return "mps"
        return "cpu"

    @property
    def loaded(self) -> bool:
        return self._pipeline is not None

    def vram_gb(self) -> tuple[float | None, float | None]:
        """(free, total) in GiB, or (None, None) off CUDA."""
        if torch is None or not torch.cuda.is_available():
            return None, None
        try:
            free, total = torch.cuda.mem_get_info()
            return round(free / 1024**3, 2), round(total / 1024**3, 2)
        except Exception:  # noqa: BLE001
            return None, None

    def status_detail(self) -> str:
        if torch is None:
            return "PyTorch is not installed in this environment."
        if self.device != "cuda":
            return (
                f"Running on '{self.device}'. Video generation requires an NVIDIA GPU; "
                "deploy this worker to a CUDA host."
            )
        if not settings.model_id:
            return "No VIDEO_MODEL_ID is configured, so no model can be loaded."
        if settings.model_id != WAN_I2V_MODEL_ID:
            return f"Unsupported VIDEO_MODEL_ID '{settings.model_id}'; expected '{WAN_I2V_MODEL_ID}'."
        if settings.model_profile != WAN_I2V_PROFILE:
            return (
                f"Unsupported VIDEO_MODEL_PROFILE '{settings.model_profile}'; "
                f"expected '{WAN_I2V_PROFILE}'."
            )
        _, total = self.vram_gb()
        if total is not None and total < WAN_MIN_VRAM_GIB:
            return (
                f"CUDA GPU exposes {total:.1f} GiB VRAM; the full-quality Wan 2.2 "
                f"I2V A14B profile requires an 80 GB-class GPU."
            )
        if self._load_error:
            return f"Model failed to load: {self._load_error}"
        if not self.loaded:
            return "Model is configured but not loaded yet."
        return f"Ready with {settings.model_id}."

    # ---------------------------------------------------------------- loading

    def ensure_loaded(self) -> None:
        """Loads the model if it is not already resident. Idempotent and thread-safe."""
        if self._pipeline is not None:
            return

        with self._load_lock:
            # Re-check: another thread may have loaded it while we waited.
            if self._pipeline is not None:
                return

            if torch is None:
                raise ModelUnavailable("PyTorch is not installed.")
            if self.device != "cuda":
                raise ModelUnavailable(
                    f"Device is '{self.device}'. An NVIDIA GPU is required for video generation."
                )
            if not settings.model_id:
                raise ModelUnavailable("VIDEO_MODEL_ID is not set.")
            if settings.model_id != WAN_I2V_MODEL_ID or settings.model_profile != WAN_I2V_PROFILE:
                raise ModelUnavailable(self.status_detail())
            _, total = self.vram_gb()
            if total is not None and total < WAN_MIN_VRAM_GIB:
                raise ModelUnavailable(self.status_detail())

            try:
                from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
            except Exception as exc:  # noqa: BLE001
                raise ModelUnavailable(
                    "diffusers with WanImageToVideoPipeline support is not installed: "
                    f"{exc}"
                ) from exc

            log.info("Loading %s ...", settings.model_id)
            started = time.monotonic()
            try:
                # Wan's VAE is kept in float32 to prevent liquid/glass detail
                # instability; the two transformer stages run in bfloat16.
                vae = AutoencoderKLWan.from_pretrained(
                    settings.model_id,
                    subfolder="vae",
                    torch_dtype=torch.float32,
                    cache_dir=settings.cache_dir,
                )
                pipeline = WanImageToVideoPipeline.from_pretrained(
                    settings.model_id,
                    vae=vae,
                    torch_dtype=torch.bfloat16,
                    cache_dir=settings.cache_dir,
                )

                # CPU offload is an official inference memory strategy, not a
                # lower-quality model fallback. It trades speed for headroom.
                if settings.enable_cpu_offload and hasattr(pipeline, "enable_model_cpu_offload"):
                    pipeline.enable_model_cpu_offload()
                else:
                    pipeline.to("cuda")

                if settings.enable_vae_slicing:
                    for method in ("enable_slicing", "enable_tiling"):
                        if hasattr(pipeline.vae, method):
                            getattr(pipeline.vae, method)()

                self._pipeline = pipeline
                self._load_error = None
                log.info(
                    "Loaded %s in %.1fs.", settings.model_id, time.monotonic() - started
                )
            except Exception as exc:  # noqa: BLE001
                self._load_error = str(exc)
                log.exception("Model load failed.")
                if _is_oom(exc):
                    self._free_vram()
                    raise OutOfMemory(
                        f"Ran out of VRAM loading {settings.model_id}. "
                        "Use a smaller model or enable WORKER_CPU_OFFLOAD."
                    ) from exc
                raise ModelUnavailable(f"Could not load {settings.model_id}: {exc}") from exc

    def _free_vram(self) -> None:
        """Best-effort VRAM reclaim after an OOM, so the next job can still run."""
        if torch is None or not torch.cuda.is_available():
            return
        try:
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        except Exception:  # noqa: BLE001
            log.debug("VRAM reclaim failed.", exc_info=True)

    # ------------------------------------------------------------- inference

    def generate(
        self,
        *,
        prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        num_frames: int,
        fps: int,
        seed: int,
        guidance_scale: float,
        guidance_scale_2: float,
        num_inference_steps: int,
        init_image_b64: str | None,
        output_path: Path,
        deadline: float | None = None,
        cancel_event: threading.Event | None = None,
        on_progress: Callable[[float, str], None] | None = None,
    ) -> Path:
        """
        Runs one generation and writes an mp4.

        Raises `WorkerError` subclasses with structured codes. Inference is
        serialised across threads; the queue wait counts against the deadline.
        """
        self.ensure_loaded()
        assert self._pipeline is not None and torch is not None

        self._check_interrupts(deadline, cancel_event, "before inference")

        if on_progress:
            on_progress(0.02, "Waiting for the GPU")

        # One generation at a time per process, whatever the pool size.
        with self._inference_lock:
            self._check_interrupts(deadline, cancel_event, "while queued")

            generator = torch.Generator(device="cuda").manual_seed(seed)
            kwargs: dict[str, Any] = {
                "prompt": prompt,
                "negative_prompt": negative_prompt or None,
                "height": height,
                "width": width,
                "num_frames": num_frames,
                "guidance_scale": guidance_scale,
                "guidance_scale_2": guidance_scale_2,
                "num_inference_steps": num_inference_steps,
                "generator": generator,
                "output_type": "pil",
            }

            if not init_image_b64:
                raise WorkerError(ErrorCode.INVALID_REQUEST, "Wan I2V requires an init image.")
            image = self._decode_image(init_image_b64)
            if image.size != (width, height):
                raise WorkerError(
                    ErrorCode.INVALID_REQUEST,
                    f"Init image is {image.width}x{image.height}; expected exactly {width}x{height}.",
                )
            kwargs["image"] = image

            if on_progress:
                on_progress(0.05, "Running inference")

            try:
                result = self._call_pipeline(kwargs, deadline, cancel_event, on_progress)
                frames = self._extract_frames(result)
                self._export(frames, fps, output_path)
            except WorkerError:
                raise
            except Exception as exc:  # noqa: BLE001
                if _is_oom(exc):
                    self._free_vram()
                    raise OutOfMemory(
                        f"CUDA ran out of memory generating {width}x{height} x{num_frames} frames. "
                        "Reduce resolution, frame count, or enable WORKER_CPU_OFFLOAD."
                    ) from exc
                raise WorkerError(ErrorCode.INTERNAL, f"{type(exc).__name__}: {exc}") from exc
            finally:
                # Release intermediates whether we succeeded or not, so one big
                # job does not leave the next one short of VRAM.
                self._free_vram()

        if on_progress:
            on_progress(1.0, "Complete")
        return output_path

    @staticmethod
    def _check_interrupts(
        deadline: float | None,
        cancel_event: threading.Event | None,
        where: str,
    ) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise JobCancelled(f"Cancelled {where}.")
        if deadline is not None and time.monotonic() > deadline:
            raise JobTimeout(f"Exceeded the time limit {where}.")

    def _call_pipeline(
        self,
        kwargs: dict[str, Any],
        deadline: float | None,
        cancel_event: threading.Event | None,
        on_progress: Callable[[float, str], None] | None,
    ) -> Any:
        """
        Calls the pipeline with only the arguments it actually accepts.

        Wan's public Diffusers API is inspected once here so a dependency
        mismatch fails loudly instead of silently dropping a conditioning
        parameter.

        The step callback is also the only place a running diffusion loop can be
        interrupted, so cancellation and the deadline are enforced there.
        """
        assert self._pipeline is not None
        signature = inspect.signature(self._pipeline.__call__)
        accepted = set(signature.parameters)

        required = {
            "prompt",
            "negative_prompt",
            "image",
            "height",
            "width",
            "num_frames",
            "guidance_scale",
            "guidance_scale_2",
            "num_inference_steps",
            "generator",
        }
        missing = sorted(required - accepted)
        if missing:
            raise ModelUnavailable(
                "Installed diffusers has an incompatible Wan I2V call signature; "
                f"missing: {', '.join(missing)}."
            )

        filtered = {k: v for k, v in kwargs.items() if k in accepted and v is not None}

        total = int(filtered.get("num_inference_steps", 30))

        if "callback_on_step_end" in accepted:

            def _step(_pipe: Any, step: int, _t: Any, cb_kwargs: dict[str, Any]) -> dict[str, Any]:
                self._check_interrupts(deadline, cancel_event, f"at step {step}/{total}")
                if on_progress:
                    on_progress(0.05 + 0.85 * (step / max(1, total)), f"Step {step}/{total}")
                return cb_kwargs

            filtered["callback_on_step_end"] = _step
        else:
            log.warning(
                "This pipeline exposes no step callback: cancellation and the deadline "
                "cannot interrupt it mid-generation and will only apply at the boundaries."
            )

        return self._pipeline(**filtered)

    @staticmethod
    def _extract_frames(result: Any) -> Any:
        for attr in ("frames", "videos", "images"):
            value = getattr(result, attr, None)
            if value is not None:
                # Video pipelines return a batch; take the first item.
                return value[0] if len(value) > 0 else value
        raise WorkerError(ErrorCode.INTERNAL, "The pipeline returned no frames.")

    @staticmethod
    def _export(frames: Any, fps: int, output_path: Path) -> None:
        """
        Writes the mp4 atomically.

        A partial file at the final path would be served to the caller as a
        complete artifact, so the encode goes to a sibling `.part` and is
        renamed only on success.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = output_path.with_name(f"{output_path.stem}.part.mp4")

        import imageio.v2 as imageio
        import numpy as np

        try:
            writer = imageio.get_writer(
                str(temp_path),
                format="FFMPEG",
                mode="I",
                fps=fps,
                codec="libx264",
                pixelformat="yuv420p",
                macro_block_size=None,
                output_params=["-profile:v", "high", "-movflags", "+faststart"],
            )
            try:
                for frame in frames:
                    pixels = np.asarray(frame)
                    if pixels.dtype != np.uint8:
                        pixels = np.clip(pixels, 0, 255).astype(np.uint8)
                    writer.append_data(pixels)
            finally:
                writer.close()
            temp_path.replace(output_path)
        finally:
            temp_path.unlink(missing_ok=True)

    @staticmethod
    def _decode_image(image_b64: str) -> Any:
        try:
            from PIL import Image
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailable(f"Pillow is not installed: {exc}") from exc

        try:
            raw = base64.b64decode(image_b64, validate=True)
            image = Image.open(io.BytesIO(raw))
            image.verify()  # rejects corrupt/incomplete data before we use it
            return Image.open(io.BytesIO(raw)).convert("RGB")
        except (binascii.Error, ValueError, OSError) as exc:
            raise WorkerError(ErrorCode.INVALID_REQUEST, f"Could not decode init image: {exc}") from exc


manager = VideoPipelineManager()
