"""Hard constraints for the production Wan 2.2 image-to-video profile."""

from __future__ import annotations

from .schemas import GenerationRequest, ReferenceUsage

WAN_I2V_MODEL_ID = "Wan-AI/Wan2.2-I2V-A14B-Diffusers"
WAN_I2V_PROFILE = "wan2.2-i2v-a14b-720p"
WAN_I2V_FPS = 24
WAN_I2V_SIZES = frozenset({(720, 1280), (480, 832)})
# NVIDIA markets an 80 GB A100/H100; torch normally reports roughly 79 GiB.
WAN_MIN_VRAM_GIB = 75.0


def validate_generation_request(request: GenerationRequest) -> list[str]:
    """Return every model-profile violation; an empty list means runnable."""
    errors: list[str] = []

    if request.provider_options.model_profile != WAN_I2V_PROFILE:
        errors.append(f"model_profile must be '{WAN_I2V_PROFILE}'.")
    if (request.width, request.height) not in WAN_I2V_SIZES:
        errors.append("vertical size must be 720x1280 or 480x832.")
    if request.fps != WAN_I2V_FPS:
        errors.append(f"fps must be {WAN_I2V_FPS}.")
    if (request.num_frames - 1) % 4 != 0:
        errors.append("num_frames must satisfy 4n+1 for Wan's temporal VAE.")

    nominal = round(request.duration_sec * request.fps)
    if abs(request.num_frames - nominal) > 1:
        errors.append(
            f"num_frames ({request.num_frames}) must be within one frame of "
            f"duration_sec x fps ({nominal})."
        )

    conditioned = [
        reference
        for reference in request.references
        if reference.usage is not ReferenceUsage.DESCRIPTIVE_ONLY
    ]
    if len(conditioned) != 1 or conditioned[0].usage is not ReferenceUsage.INIT_FRAME:
        errors.append("exactly one conditioned reference is required and it must be init_frame.")

    return errors
