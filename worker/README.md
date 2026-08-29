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
| NVIDIA **A100 80 GB or H100 80 GB** | The selected full Wan 2.2 I2V A14B 720p profile requires an 80 GB-class CUDA GPU. |
| CUDA 12.x drivers | The PyTorch build must match. |
| Python **3.10–3.12** | 3.13+ still has patchy wheel coverage for the ML stack. |
| **250 GB persistent disk minimum** | The Diffusers checkpoint is roughly 126 GB before caches and outputs. |
| **117 GB host RAM minimum** | Required headroom when model CPU offload is enabled. |

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
export VIDEO_MODEL_ID=Wan-AI/Wan2.2-I2V-A14B-Diffusers
export VIDEO_MODEL_PROFILE=wan2.2-i2v-a14b-720p
export WORKER_AUTH_TOKEN=$(openssl rand -hex 24)   # required on a public IP
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

First start downloads roughly 126 GB of weights — keep `HF_HOME` on persistent storage.

Then, in the app's `.env.local`:

```bash
VIDEO_PROVIDER=remote-worker
REMOTE_WORKER_URL=http://<gpu-host>:8000
REMOTE_WORKER_TOKEN=<the token you generated>
```

The worker deliberately supports only `Wan-AI/Wan2.2-I2V-A14B-Diffusers` for
this production path. It does not silently load a smaller model when resources
are insufficient.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_MODEL_ID` | `Wan-AI/Wan2.2-I2V-A14B-Diffusers` | Exact supported Hugging Face model id. |
| `VIDEO_MODEL_PROFILE` | `wan2.2-i2v-a14b-720p` | Enforces 720×1280/480×832, 24 fps and 4n+1 frames. |
| `WORKER_AUTH_TOKEN` | *(empty)* | Shared bearer token. Empty disables auth. |
| `WORKER_OUTPUT_DIR` | `./worker_outputs` | Where clips are written before download. |
| `WORKER_EAGER_LOAD` | `true` | Load at startup instead of on first request. |
| `WORKER_CPU_OFFLOAD` | `true` | Official memory-saving execution path; quality is unchanged, inference is slower. |
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
- **Needs the requested hardware run:** the exact Wan pipeline call is wired and
  contract-tested, but this checkout has no CUDA GPU. `/health` refuses
  readiness until the exact model is resident on an 80 GB-class device.

If something is missing, the worker says so through `/health` and the app shows
the user the reason. It never fabricates output.

---

## Deploying to a rented GPU

Works unchanged on RunPod / Vast.ai / Lambda:

1. Start an A100 80 GB or H100 80 GB CUDA 12.x PyTorch container with at least
   117 GB system RAM and a 250 GB persistent volume.
2. Clone the repo, `cd worker`, install as above.
3. Expose port 8000, set `WORKER_AUTH_TOKEN`.
4. Point `REMOTE_WORKER_URL` at the public endpoint.
5. Mount a persistent volume at `HF_HOME` so weights survive restarts.

**Always set `WORKER_AUTH_TOKEN` on a public IP.** Without it, anyone who finds
the endpoint can spend your GPU time.
