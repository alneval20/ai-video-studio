"""
Worker tests.

These run WITHOUT torch, diffusers or CUDA installed — exactly the situation on
a development Mac. That is deliberate: the worker's most important property
before GPU integration is that it starts, reports its own limitations honestly,
and refuses work it cannot do instead of hanging or crashing.
"""

from __future__ import annotations

import base64
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.jobs import JobRegistry
from app.main import app
from app.pipeline import (
    JobCancelled,
    JobTimeout,
    ModelUnavailable,
    OutOfMemory,
    WorkerError,
    _is_oom,
    manager,
)
from app.schemas import RETRYABLE_CODES, ErrorCode, GenerationRequest, Guidance


@pytest.fixture()
def client() -> TestClient:
    with TestClient(app) as c:
        yield c


def make_request(**overrides) -> dict:
    payload = {
        "request_id": "req_1",
        "shot_id": "shot_1",
        "prompt": "a cup of coffee on a table",
        "negative_prompt": "blurry",
        "width": 720,
        "height": 1280,
        "fps": 24,
        "duration_sec": 3.0,
        "num_frames": 73,
        "seed": 12345,
        "guidance": {
            "prompt_adherence": 0.7,
            "reference_adherence": 0.8,
            "consistency_strength": 0.85,
        },
        "camera": {"presetId": "slow_push_in", "moveIntensity": 0.2},
        "motion": {"subjectMotion": "micro"},
        "references": [
            {
                "id": "r_init",
                "role": "food",
                "usage": "init_frame",
                "weight": 1.0,
                "mime_type": "image/png",
                "image_base64": "AA==",
            }
        ],
        "provider_options": {
            "model_profile": "wan2.2-i2v-a14b-720p",
            "num_inference_steps": 40,
            "guidance_scale": 5.0,
            "guidance_scale_2": 5.0,
        },
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------- schemas


class TestSchemas:
    def test_accepts_the_canonical_request(self):
        req = GenerationRequest.model_validate(make_request())
        assert req.num_frames == 73
        assert req.guidance.prompt_adherence == pytest.approx(0.7)

    def test_rejects_out_of_range_guidance(self):
        with pytest.raises(Exception):
            Guidance(prompt_adherence=1.5, reference_adherence=0.5, consistency_strength=0.5)

    def test_rejects_absurd_dimensions(self):
        with pytest.raises(Exception):
            GenerationRequest.model_validate(make_request(width=99999))

    def test_rejects_negative_seed(self):
        with pytest.raises(Exception):
            GenerationRequest.model_validate(make_request(seed=-1))

    def test_reference_usage_is_a_closed_set(self):
        with pytest.raises(Exception):
            GenerationRequest.model_validate(
                make_request(
                    references=[
                        {
                            "id": "r1",
                            "role": "product",
                            "usage": "not_a_real_usage",
                            "weight": 0.9,
                            "mime_type": "image/png",
                            "image_base64": "AA==",
                        }
                    ]
                )
            )

    def test_retryable_codes_are_the_transient_ones(self):
        assert ErrorCode.OOM in RETRYABLE_CODES
        assert ErrorCode.TIMEOUT in RETRYABLE_CODES
        # Fixing these requires a deployment change, not a retry.
        assert ErrorCode.MODEL_UNAVAILABLE not in RETRYABLE_CODES
        assert ErrorCode.CANCELLED not in RETRYABLE_CODES


# ---------------------------------------------------------------- health


class TestHealth:
    def test_health_is_200_even_with_no_model(self, client: TestClient):
        # Liveness must not depend on the model, or an orchestrator will
        # crash-loop a worker that is merely still downloading weights.
        res = client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["model_loaded"] is False
        assert body["device"] in {"none", "cpu", "mps", "cuda"}
        assert body["detail"]

    def test_health_explains_why_it_cannot_generate(self, client: TestClient):
        detail = client.get("/health").json()["detail"]
        assert any(
            phrase in detail
            for phrase in ("PyTorch is not installed", "requires an NVIDIA GPU", "VIDEO_MODEL_ID")
        )

    def test_ready_is_503_until_it_can_generate(self, client: TestClient):
        res = client.get("/ready")
        assert res.status_code == 503
        assert res.json()["ready"] is False

    def test_health_reports_queue_depth(self, client: TestClient):
        body = client.get("/health").json()
        assert body["active_jobs"] == 0
        assert body["queued_jobs"] == 0


# ---------------------------------------------------------------- jobs


class TestJobs:
    def test_rejects_frames_that_disagree_with_duration(self, client: TestClient):
        # Wan requires 4n+1; 5 is valid for the VAE but not a three-second clip.
        res = client.post("/jobs", json=make_request(num_frames=5))
        assert res.status_code == 422
        assert "within one frame" in res.json()["detail"]

    def test_rejects_non_4n_plus_1_frames(self, client: TestClient):
        res = client.post("/jobs", json=make_request(num_frames=72))
        assert res.status_code == 422
        assert "4n+1" in res.json()["detail"]

    @pytest.mark.parametrize(
        ("override", "expected"),
        [
            ({"fps": 30, "num_frames": 89}, "fps must be 24"),
            ({"width": 464}, "720x1280 or 480x832"),
            ({"references": []}, "exactly one conditioned reference"),
        ],
    )
    def test_rejects_requests_outside_the_wan_profile(
        self, client: TestClient, override: dict, expected: str
    ):
        res = client.post("/jobs", json=make_request(**override))
        assert res.status_code == 422
        assert expected in res.json()["detail"]

    def test_accepts_a_consistent_request_and_fails_it_honestly(self, client: TestClient):
        res = client.post("/jobs", json=make_request())
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        state = _await_terminal(client, job_id)
        # No torch/CUDA here, so it must fail with the structured reason rather
        # than hang or pretend to succeed.
        assert state["status"] == "failed"
        assert state["error_code"] == ErrorCode.MODEL_UNAVAILABLE.value
        assert state["retryable"] is False
        assert state["error"]

    def test_request_response_contract_reaches_a_real_artifact_route(
        self, client: TestClient, monkeypatch
    ):
        captured: dict = {}

        def completed_generation(**kwargs):
            captured.update(kwargs)
            kwargs["output_path"].write_bytes(b"contract-artifact")
            return kwargs["output_path"]

        monkeypatch.setattr(manager, "generate", completed_generation)
        res = client.post("/jobs", json=make_request())
        assert res.status_code == 200
        job_id = res.json()["job_id"]
        state = _await_terminal(client, job_id)

        assert state["status"] == "succeeded"
        assert state["width"] == 720
        assert state["height"] == 1280
        assert state["fps"] == 24
        assert state["num_frames"] == 73
        assert state["codec"] == "h264"
        assert state["model_profile"] == "wan2.2-i2v-a14b-720p"
        assert captured["guidance_scale"] == pytest.approx(5.0)
        assert captured["guidance_scale_2"] == pytest.approx(5.0)
        assert captured["init_image_b64"] == "AA=="

        artifact = client.get(f"/jobs/{job_id}/artifact")
        assert artifact.status_code == 200
        assert artifact.content == b"contract-artifact"

    def test_unknown_job_is_404(self, client: TestClient):
        assert client.get("/jobs/wjob_missing").status_code == 404

    def test_artifact_is_409_when_not_succeeded(self, client: TestClient):
        job_id = client.post("/jobs", json=make_request()).json()["job_id"]
        _await_terminal(client, job_id)
        res = client.get(f"/jobs/{job_id}/artifact")
        assert res.status_code == 409

    def test_cancel_unknown_job_is_404(self, client: TestClient):
        assert client.post("/jobs/wjob_missing/cancel").status_code == 404

    def test_state_echoes_the_device(self, client: TestClient):
        job_id = client.post("/jobs", json=make_request()).json()["job_id"]
        assert client.get(f"/jobs/{job_id}").json()["device"] == manager.device


def _await_terminal(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = client.get(f"/jobs/{job_id}").json()
        if state["status"] in {"succeeded", "failed", "cancelled"}:
            return state
        time.sleep(0.05)
    raise AssertionError(f"Job {job_id} never reached a terminal state.")


# ---------------------------------------------------------------- registry


class TestRegistry:
    def test_cancelling_a_queued_job_stops_it_before_it_runs(self):
        registry = JobRegistry()
        request = GenerationRequest.model_validate(make_request())

        # Occupy the single worker thread so the next job stays queued.
        gate = threading.Event()
        registry._ensure_pool().submit(gate.wait)  # noqa: SLF001 - deliberate reach-in

        job = registry.submit(request)
        cancelled = registry.cancel(job.id)
        assert cancelled is not None
        assert cancelled.status == "cancelled"
        assert cancelled.error_code == ErrorCode.CANCELLED

        gate.set()
        registry.shutdown()

    def test_cancel_is_idempotent_on_a_terminal_job(self):
        registry = JobRegistry()
        job = registry.submit(GenerationRequest.model_validate(make_request()))
        _wait(lambda: job.terminal)

        before = job.status
        again = registry.cancel(job.id)
        assert again is not None and again.status == before
        registry.shutdown()

    def test_counts_reflect_activity(self):
        registry = JobRegistry()
        active, queued = registry.counts()
        assert active == 0 and queued == 0
        registry.shutdown()

    def test_eviction_keeps_the_registry_bounded(self, monkeypatch):
        monkeypatch.setattr(settings, "max_tracked_jobs", 3, raising=False)
        registry = JobRegistry()

        for _ in range(8):
            job = registry.submit(GenerationRequest.model_validate(make_request()))
            _wait(lambda: job.terminal)

        assert len(registry._jobs) <= 3  # noqa: SLF001
        registry.shutdown()

    def test_shutdown_cancels_in_flight_work(self):
        registry = JobRegistry()
        job = registry.submit(GenerationRequest.model_validate(make_request()))
        registry.shutdown()
        assert job.cancel_event.is_set() or job.terminal

    def test_submit_after_shutdown_is_refused_structurally(self):
        registry = JobRegistry()
        registry.shutdown()
        with pytest.raises(WorkerError) as excinfo:
            registry.submit(GenerationRequest.model_validate(make_request()))
        assert excinfo.value.code is ErrorCode.INTERNAL

    def test_registry_can_be_restarted(self):
        """A shut-down pool can never accept work again; startup() must rebuild it."""
        registry = JobRegistry()
        registry.shutdown()
        registry.startup()
        job = registry.submit(GenerationRequest.model_validate(make_request()))
        assert job.id
        registry.shutdown()


def _wait(predicate, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Condition never became true.")


# ---------------------------------------------------------------- pipeline


class TestPipelineGuards:
    def test_oom_is_detected_from_the_message(self):
        assert _is_oom(RuntimeError("CUDA error: out of memory")) is True
        assert _is_oom(RuntimeError("something else entirely")) is False

    def test_worker_errors_carry_machine_codes(self):
        assert OutOfMemory("x").code is ErrorCode.OOM
        assert JobTimeout("x").code is ErrorCode.TIMEOUT
        assert JobCancelled().code is ErrorCode.CANCELLED

    def test_interrupt_check_raises_on_cancel(self):
        event = threading.Event()
        event.set()
        with pytest.raises(JobCancelled):
            manager._check_interrupts(None, event, "in test")  # noqa: SLF001

    def test_interrupt_check_raises_past_the_deadline(self):
        with pytest.raises(JobTimeout):
            manager._check_interrupts(time.monotonic() - 1, None, "in test")  # noqa: SLF001

    def test_interrupt_check_passes_when_healthy(self):
        manager._check_interrupts(time.monotonic() + 60, threading.Event(), "in test")  # noqa: SLF001

    def test_generate_refuses_without_a_model(self, tmp_path):
        with pytest.raises(Exception) as excinfo:
            manager.generate(
                prompt="x",
                negative_prompt="",
                width=64,
                height=64,
                num_frames=8,
                fps=8,
                seed=1,
                guidance_scale=5.0,
                guidance_scale_2=5.0,
                num_inference_steps=10,
                init_image_b64=None,
                output_path=tmp_path / "out.mp4",
            )
        assert getattr(excinfo.value, "code", None) is ErrorCode.MODEL_UNAVAILABLE

    def test_bad_init_image_is_rejected_not_crashed(self):
        try:
            import PIL  # noqa: F401
        except ImportError:
            with pytest.raises(ModelUnavailable):
                manager._decode_image("not base64 at all!!")  # noqa: SLF001
            return

        with pytest.raises(WorkerError) as invalid_base64:
            manager._decode_image("not base64 at all!!")  # noqa: SLF001
        assert invalid_base64.value.code is ErrorCode.INVALID_REQUEST

        with pytest.raises(WorkerError) as invalid_image:
            manager._decode_image(base64.b64encode(b"nope").decode())  # noqa: SLF001
        assert invalid_image.value.code is ErrorCode.INVALID_REQUEST


# ---------------------------------------------------------------- auth


class TestAuth:
    def test_token_is_enforced_when_configured(self, monkeypatch):
        monkeypatch.setattr(settings, "auth_token", "s3cret", raising=False)
        with TestClient(app) as c:
            assert c.post("/jobs", json=make_request()).status_code == 401
            assert c.get("/jobs/anything").status_code == 401
            # Liveness stays open so orchestrators can probe it.
            assert c.get("/health").status_code == 200

    def test_correct_token_is_accepted(self, monkeypatch):
        monkeypatch.setattr(settings, "auth_token", "s3cret", raising=False)
        with TestClient(app) as c:
            res = c.post(
                "/jobs",
                json=make_request(),
                headers={"Authorization": "Bearer s3cret"},
            )
            assert res.status_code == 200

    def test_wrong_token_is_rejected(self, monkeypatch):
        monkeypatch.setattr(settings, "auth_token", "s3cret", raising=False)
        with TestClient(app) as c:
            res = c.post(
                "/jobs",
                json=make_request(),
                headers={"Authorization": "Bearer wrong"},
            )
            assert res.status_code == 401
