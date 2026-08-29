"""
Image-to-video model profiles.

A profile is the set of hard constraints one checkpoint imposes: its native
frame rate, the resolutions it was trained on, its VAE's temporal stride, and
the VRAM it needs. Requests are validated against the profile the caller asked
for, so supporting another model is a new entry here plus a branch in
`pipeline.build_pipeline` — never a change to the application above.

Two profiles ship today, at opposite ends of the hardware range:

  wan2.2-i2v-a14b-720p   best quality, needs an 80 GB-class datacentre GPU
  ltx-2b-i2v-576p        runs in ~10 GB, so it fits a free-tier T4/P100

The free-tier profile exists because renting an 80 GB card is not always an
option. It is a genuine image-to-video model producing real generated motion —
it is emphatically not a slideshow or a synthetic camera move — but it is a 2B
model against a 14B one, and the quality gap is real. See docs/FREE-GPU.md.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schemas import GenerationRequest, ReferenceUsage


@dataclass(frozen=True)
class ModelProfile:
    profile_id: str
    model_id: str
    #: Diffusers pipeline class, resolved in pipeline.py.
    pipeline_class: str
    fps: int
    #: (width, height) pairs this profile is validated for. Vertical only —
    #: the studio targets 9:16 social delivery.
    sizes: frozenset[tuple[int, int]]
    #: VAE temporal stride: num_frames must satisfy (n - 1) % stride == 0.
    temporal_stride: int
    #: Spatial stride: width and height must both be divisible by this.
    spatial_stride: int
    min_vram_gib: float
    #: Torch dtype name used when loading.
    dtype: str
    #: Shown to the user when a profile is selected or rejected.
    summary: str


WAN_I2V = ModelProfile(
    profile_id="wan2.2-i2v-a14b-720p",
    model_id="Wan-AI/Wan2.2-I2V-A14B-Diffusers",
    pipeline_class="WanImageToVideoPipeline",
    fps=24,
    sizes=frozenset({(720, 1280), (480, 832)}),
    temporal_stride=4,
    spatial_stride=16,
    # NVIDIA markets an 80 GB A100/H100; torch normally reports roughly 79 GiB.
    min_vram_gib=75.0,
    dtype="bfloat16",
    summary="Wan 2.2 I2V A14B — highest quality, requires an 80 GB-class GPU.",
)

LTX_I2V = ModelProfile(
    profile_id="ltx-2b-i2v-576p",
    model_id="Lightricks/LTX-Video",
    pipeline_class="LTXImageToVideoPipeline",
    # LTX is trained around 24-25 fps; 24 keeps it aligned with the Wan profile
    # so the shot planner's frame maths is identical across both.
    fps=24,
    # 576x1024 is exactly 9:16 AND divisible by 32, which LTX requires. Most
    # "vertical" presets are neither, and silently get letterboxed or stretched.
    sizes=frozenset({(576, 1024), (704, 1216)}),
    temporal_stride=8,
    spatial_stride=32,
    # The published figure for the 2B checkpoint with offload enabled. Leaves
    # real headroom on a 16 GB free-tier card.
    min_vram_gib=10.0,
    dtype="bfloat16",
    summary="LTX-Video 2B I2V — runs in ~10 GB, suitable for a free-tier GPU.",
)

PROFILES: dict[str, ModelProfile] = {
    WAN_I2V.profile_id: WAN_I2V,
    LTX_I2V.profile_id: LTX_I2V,
}

#: Kept for callers that predate the registry.
WAN_I2V_MODEL_ID = WAN_I2V.model_id
WAN_I2V_PROFILE = WAN_I2V.profile_id
WAN_I2V_FPS = WAN_I2V.fps
WAN_I2V_SIZES = WAN_I2V.sizes
WAN_MIN_VRAM_GIB = WAN_I2V.min_vram_gib


def get_profile(profile_id: str) -> ModelProfile | None:
    return PROFILES.get(profile_id)


def validate_generation_request(request: GenerationRequest) -> list[str]:
    """Return every model-profile violation; an empty list means runnable."""
    errors: list[str] = []

    profile = PROFILES.get(request.provider_options.model_profile)
    if profile is None:
        return [
            f"unknown model_profile '{request.provider_options.model_profile}'; "
            f"expected one of: {', '.join(sorted(PROFILES))}."
        ]

    if (request.width, request.height) not in profile.sizes:
        allowed = ", ".join(f"{w}x{h}" for w, h in sorted(profile.sizes))
        errors.append(f"size must be one of {allowed} for {profile.profile_id}.")

    # Checked separately from `sizes` so a future size addition cannot quietly
    # introduce a dimension the VAE will reject.
    for label, value in (("width", request.width), ("height", request.height)):
        if value % profile.spatial_stride != 0:
            errors.append(
                f"{label} ({value}) must be divisible by {profile.spatial_stride} "
                f"for {profile.profile_id}."
            )

    if request.fps != profile.fps:
        errors.append(f"fps must be {profile.fps} for {profile.profile_id}.")

    if (request.num_frames - 1) % profile.temporal_stride != 0:
        errors.append(
            f"num_frames must satisfy {profile.temporal_stride}n+1 for "
            f"{profile.profile_id}'s temporal VAE."
        )

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
