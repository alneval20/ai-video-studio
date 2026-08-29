#!/usr/bin/env bash
#
# One-command provisioning for a rented 80 GB CUDA host (RunPod / Vast.ai /
# Lambda). Run it from the repo's `worker/` directory on the GPU box.
#
#   bash provision.sh
#
# Every check that can fail is done BEFORE the 126 GB download, because on a
# rented GPU every minute is billed and discovering "disk too small" after a
# 20-minute download is a pure waste of money.
#
# Safe to re-run: with HF_HOME on a persistent volume the weights are cached and
# a second run skips straight to serving.

set -euo pipefail

readonly MODEL_ID="${VIDEO_MODEL_ID:-Wan-AI/Wan2.2-I2V-A14B-Diffusers}"
readonly MIN_VRAM_GIB=75
readonly MIN_DISK_GIB=200
readonly MIN_RAM_GIB=100
readonly CUDA_WHEEL="${CUDA_WHEEL:-cu121}"

# Keep weights on the persistent volume, not the container's ephemeral layer —
# otherwise a restart re-downloads 126 GB of billed transfer.
export HF_HOME="${HF_HOME:-/workspace/hf}"
export WORKER_OUTPUT_DIR="${WORKER_OUTPUT_DIR:-/workspace/worker_outputs}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

log "Preflight (before any download)"

command -v nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi not found — this is not a CUDA host."

vram_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)"
vram_gib=$(( vram_mib / 1024 ))
gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
log "GPU: ${gpu_name} (${vram_gib} GiB VRAM)"
[ "$vram_gib" -ge "$MIN_VRAM_GIB" ] || fail \
  "Need >= ${MIN_VRAM_GIB} GiB VRAM for ${MODEL_ID}; this card has ${vram_gib} GiB. Use an A100 80GB or H100 80GB."

mkdir -p "$HF_HOME" "$WORKER_OUTPUT_DIR"
disk_gib="$(df -BG --output=avail "$HF_HOME" | tail -1 | tr -dc '0-9')"
log "Free disk at ${HF_HOME}: ${disk_gib} GiB"
[ "$disk_gib" -ge "$MIN_DISK_GIB" ] || fail \
  "Need >= ${MIN_DISK_GIB} GiB free (checkpoint alone is ~126 GB); only ${disk_gib} GiB available."

ram_gib=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
log "Host RAM: ${ram_gib} GiB"
[ "$ram_gib" -ge "$MIN_RAM_GIB" ] || log \
  "WARNING: ${ram_gib} GiB RAM is below the ${MIN_RAM_GIB} GiB recommended for CPU offload."

log "Preflight passed."

# ---------------------------------------------------------------- install

log "Installing torch (${CUDA_WHEEL}) and the model stack"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet torch --index-url "https://download.pytorch.org/whl/${CUDA_WHEEL}"
python -m pip install --quiet -r requirements.txt
# hf_transfer gives multi-connection downloads; on a 126 GB pull that is the
# difference between a few minutes and half an hour of billed time.
python -m pip install --quiet "huggingface_hub[hf_transfer]"
export HF_HUB_ENABLE_HF_TRANSFER=1

python - <<'PY'
import torch
assert torch.cuda.is_available(), "torch cannot see the GPU"
print(f"    torch {torch.__version__}, CUDA {torch.version.cuda}, device {torch.cuda.get_device_name(0)}")
PY

# ---------------------------------------------------------------- weights

log "Fetching ${MODEL_ID} (~126 GB; cached in ${HF_HOME})"
python - "$MODEL_ID" <<'PY'
import sys, time
from huggingface_hub import snapshot_download
started = time.time()
path = snapshot_download(sys.argv[1], resume_download=True)
print(f"    weights ready in {(time.time()-started)/60:.1f} min at {path}")
PY

# ---------------------------------------------------------------- serve

: "${WORKER_AUTH_TOKEN:?Set WORKER_AUTH_TOKEN before serving — an open worker on a public IP will be abused.}"

log "Starting the worker on 0.0.0.0:8000"
log "Readiness:  curl -s localhost:8000/ready | jq"
exec env \
  VIDEO_MODEL_ID="$MODEL_ID" \
  WORKER_EAGER_LOAD="${WORKER_EAGER_LOAD:-true}" \
  WORKER_CPU_OFFLOAD="${WORKER_CPU_OFFLOAD:-false}" \
  uvicorn app.main:app --host 0.0.0.0 --port 8000
