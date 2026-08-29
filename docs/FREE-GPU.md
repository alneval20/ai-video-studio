# Running with no paid GPU

This is the honest answer to "can I generate this on my Mac, for free?"

## Short version

**Not on this Mac.** An M1 with 8 GB unified memory cannot run any current
image-to-video model at usable quality. But you can still generate real video
for free by running the *existing* worker on a free cloud GPU. Nothing about the
app changes — only where inference happens.

---

## Why local is not viable on an 8 GB M1

| Constraint | This machine | What I2V needs |
|---|---|---|
| Unified memory | **8 GB** (~4–5 GB usable after macOS) | 16 GB minimum, 32 GB comfortable |
| Free disk | **11 GB** | ~4 GB for the ML stack + 5–10 GB per checkpoint, plus swap headroom |
| GPU | Apple M1 (Metal/MPS) | MPS works for images; video pipelines are poorly supported and very slow |

Two independent walls, either of which alone is disqualifying:

1. **Memory.** With 8 GB shared between CPU and GPU, a video model spends its
   time swapping. Published guidance puts 16 GB as the floor for the smallest
   useful models, and LTX 2.3 wants 32 GB+.
2. **Disk.** 11 GB free does not fit PyTorch (~2.5 GB), diffusers and
   dependencies (~1.5 GB), and a checkpoint (5–10 GB) — let alone the swap an
   8 GB machine will lean on hard.

Anything that *did* fit would be so heavily quantised and so slow that the
output would not be usable in a paid campaign. That is the trade-off being
avoided, not a limitation being worked around.

> There is no honest local fallback here. Simulating motion with an ffmpeg pan
> or zoom over a still is exactly the "slideshow" this project refuses to ship,
> and the test harness rejects frozen output on purpose.

---

## What works instead: free cloud GPU, same worker

The provider abstraction already separates *deciding what to generate* from
*where it runs*. So:

- **Stays on your Mac:** director, shot planner, camera/realism/consistency,
  prompt compiler, quality control, compositor, the whole UI. All of it runs
  fine on an M1.
- **Moves to a free GPU:** inference only.

| Option | GPU | Free allowance | Notes |
|---|---|---|---|
| **Google Colab** | T4 16 GB | Free tier, ~12 h max session | Easiest start; availability varies |
| **Kaggle Notebooks** | P100 16 GB / 2×T4 | ~30 h/week | More predictable quota than Colab |
| **Lightning AI** | T4-class | Monthly free credits | Persistent storage |

All three give ~16 GB VRAM, which is why the `ltx-2b-i2v-576p` profile exists.

### Model profiles

| Profile | Model | VRAM | Where |
|---|---|---|---|
| `wan2.2-i2v-a14b-720p` | Wan 2.2 I2V A14B | ~75 GB | Paid A100/H100 80 GB |
| `ltx-2b-i2v-576p` | LTX-Video 2B | ~10 GB | **Free-tier T4/P100** |

Both are genuine image-to-video models producing real generated motion. The
free one is a *smaller model*, not a different technique.

### Setup

On the free GPU notebook:

```bash
!git clone https://github.com/alneval20/ai-video-studio.git
%cd ai-video-studio/worker
!pip install -q -r requirements.txt
!pip install -q "huggingface_hub[hf_transfer]" pyngrok
```

```bash
!VIDEO_MODEL_ID=Lightricks/LTX-Video \
 VIDEO_MODEL_PROFILE=ltx-2b-i2v-576p \
 WORKER_AUTH_TOKEN=$(openssl rand -hex 24) \
 WORKER_CPU_OFFLOAD=true \
 nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 &
```

Expose it (Colab: `pyngrok`; Kaggle: a Cloudflare quick tunnel), then on your
Mac in `.env.local`:

```bash
VIDEO_PROVIDER=remote-worker
VIDEO_MODEL_PROFILE=ltx-2b-i2v-576p
REMOTE_WORKER_URL=https://<your-tunnel-url>
REMOTE_WORKER_TOKEN=<the token you generated>
```

`VIDEO_MODEL_PROFILE` must match on both sides — the health check refuses to run
if they disagree, because the resolution and frame maths differ per profile.

---

## The quality trade-off, stated plainly

Against the Wan 2.2 A14B target:

| | Wan 2.2 A14B (paid) | LTX 2B (free) |
|---|---|---|
| Parameters | 14 B × 2 experts | 2 B |
| Resolution | 720×1280 | 576×1024 |
| Prompt adherence | Strong | Noticeably looser |
| Ice / glass refraction | The reason to pick it | **Weakest area** |
| Fine liquid motion | Convincing | Approximate |
| Logo legibility over time | Usually holds | Degrades faster |
| Retries per usable shot | 1–3 | Expect more |

**What you should realistically expect from the free path:** believable
atmospheric motion — light shifting across surfaces, gentle camera drift,
background life, condensation reading as wet. That is genuine generated video
and it will not look like a slideshow.

**What it will not reliably deliver:** the ray-traced ice-cube caustics and
crisp macro liquid detail in the original brief. That specific look is the
hardest thing in beverage CGI and it is where a 2 B model is furthest behind.

### Practical consequence for this campaign

Shots 1 and 3 (the cafe drift and the lineup payoff) should hold up well on the
free path — they lean on atmosphere, light and parallax.

Shot 2 (the macro ice-and-liquid hero) is the one at risk. If it doesn't reach
the bar after a few attempts, the professional move is the one real beverage
commercials already make: **film that single macro shot on a phone.** A close-up
of a real drink with real condensation costs nothing, and compositing one real
macro shot with two generated ones is a completely normal production hybrid —
often better than an all-synthetic result.

---

## If quality matters more than cost

A single 3-second Wan 2.2 test on a rented H100 is roughly **$0.70–1.20**, and
a full 10-second render a few dollars. That remains the highest-quality route;
see the RunPod handoff. The free path is genuinely free, and genuinely a step
down — both statements are true.
