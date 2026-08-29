# GPU Worker

A small FastAPI service that performs the actual video inference. The Next.js
app talks to it over HTTP through the `remote-worker` provider adapter.

It is **vendor-neutral by design** — the same code runs on a LAN desktop, a
RunPod pod, a Vast.ai instance, or any other CUDA host. Nothing in the app
knows where the GPU is.

---

## What you need

| Requirement | Why |
|---|---|
| NVIDIA GPU, **12 GB VRAM minimum** (24 GB comfortable) | Video diffusion is VRAM-bound. Below 12 GB you will OOM on anything past 480p. |
| CUDA 12.x drivers | The PyTorch build must match. |
| Python **3.10–3.12** | 3.13+ still has patchy wheel coverage for the ML stack. |
| ~30–60 GB disk | Model weights. |

**None of this can run on the MacBook.** Apple Silicon has no CUDA, and no
current open-weights video model is usable on MPS. The worker detects this and
reports `device: "mps"` with `model_loaded: false` rather than pretending.

---

## Install

```bash
cd worker
python -m venv .venv && source .venv/bin/activate

# 1. torch FIRST, matched to your CUDA version (12.1 shown)
pip install torch --index-url https://download.pytorch.org/whl/cu121

# 2. everything else
pip install -r requirements.txt
```

## Run

```bash
export VIDEO_MODEL_ID=Wan-AI/Wan2.1-T2V-1.3B-Diffusers
export WORKER_AUTH_TOKEN=$(openssl rand -hex 24)   # required on a public IP
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

First start downloads the weights (several GB) — expect a long pause.

Then, in the app's `.env.local`:

```bash
VIDEO_PROVIDER=remote-worker
REMOTE_WORKER_URL=http://<gpu-host>:8000
REMOTE_WORKER_TOKEN=<the token you generated>
```

### Model suggestions

| Model | VRAM | Notes |
|---|---|---|
| `Wan-AI/Wan2.1-T2V-1.3B-Diffusers` | ~12 GB | Best starting point. Fast, good motion. |
| `Wan-AI/Wan2.1-I2V-14B-480P-Diffusers` | ~24 GB | Image-to-video — this is the one that honours product references. |
| `Lightricks/LTX-Video` | ~12 GB | Very fast; weaker prompt adherence. |
| `THUDM/CogVideoX-5b` | ~18 GB | Strong text adherence, slower. |

For this product's purposes an **image-to-video** model matters more than raw
quality: reference adherence is what keeps a product from morphing.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_MODEL_ID` | *(empty)* | Hugging Face model id. Empty = no model; `/health` says so. |
| `WORKER_AUTH_TOKEN` | *(empty)* | Shared bearer token. Empty disables auth. |
| `WORKER_OUTPUT_DIR` | `./worker_outputs` | Where clips are written before download. |
| `WORKER_EAGER_LOAD` | `true` | Load at startup instead of on first request. |
| `WORKER_CPU_OFFLOAD` | `true` | Sequential CPU offload. Leave on under 24 GB. |
| `WORKER_VAE_SLICING` | `true` | VAE slicing/tiling. Big VRAM saving. |
| `WORKER_MAX_CONCURRENT` | `1` | One GPU runs one generation at a time. |
| `WORKER_ARTIFACT_TTL` | `3600` | Seconds a finished clip is retained. |
| `HF_HOME` | *(unset)* | Weight cache. Point at a persistent volume on rented GPUs. |

---

## HTTP contract

Mirrored in `src/lib/providers/remote-worker/remote-worker-provider.ts`. Change
one, change the other.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Device, CUDA availability, VRAM, whether a model is loaded, and **why not** if not. |
| `POST` | `/jobs` | Submit a generation. Returns `{job_id}` immediately. |
| `GET` | `/jobs/{id}` | Poll status, progress 0..1, current stage. |
| `GET` | `/jobs/{id}/artifact` | Download the mp4 once `succeeded`. |
| `POST` | `/maintenance/sweep` | Drop expired artifacts. |

Reference images are sent **base64-encoded in the request body**, so the worker
needs no shared filesystem with the app. That is precisely what allows it to run
in a different datacentre from the web app.

---

## Honest status of this code

- **Real and runnable:** the service, auth, job queue, progress reporting,
  device/VRAM detection, model loading, memory configuration, and mp4 export.
- **Needs one verification pass on real hardware:** the inference call in
  `pipeline.py`. It is written against the Diffusers video-pipeline API and
  filters arguments against the pipeline's real signature (so Wan, LTX and
  CogVideoX all work without per-model branches) — but it has not been executed
  on a GPU, because none was available while this was built.

If something is missing, the worker says so through `/health` and the app shows
the user the reason. It never fabricates output.

---

## Deploying to a rented GPU

Works unchanged on RunPod / Vast.ai / Lambda:

1. Start a CUDA 12.x PyTorch container.
2. Clone the repo, `cd worker`, install as above.
3. Expose port 8000, set `WORKER_AUTH_TOKEN`.
4. Point `REMOTE_WORKER_URL` at the public endpoint.
5. Mount a persistent volume at `HF_HOME` so weights survive restarts.

**Always set `WORKER_AUTH_TOKEN` on a public IP.** Without it, anyone who finds
the endpoint can spend your GPU time.
