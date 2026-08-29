# AI Video Studio

An AI video **director** and generation platform. You type an ordinary idea; it
produces a professionally directed, realistic generative-video request and
turns the result into a social-ready export.

```
simple prompt → AI director → shot design → AI generation → quality control → Reel
```

This is **not** a motion-graphics tool. Nothing is animated from templates or
layers. The imagery comes from generative video models; traditional rendering is
used only afterwards, for editing, overlays, audio and encoding.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # optional — it runs fine with no keys
npm run dev
```

Open <http://localhost:3000>, type an idea, press **Generate**.

With an empty `.env` you get:

- the **heuristic director** (offline, deterministic, no API key), and
- the **development provider**, which renders clearly labelled placeholder
  clips instead of AI video.

Everything else is real: the shot plan, camera design, realism and consistency
engines, compiled prompts, provider request, job pipeline, quality control and
FFmpeg composition all run exactly as they will with a GPU attached.

### Turning on the good stuff

```bash
# Better directing — infers far more nuance from a casual prompt
ANTHROPIC_API_KEY=sk-ant-...

# Real video generation (needs an NVIDIA GPU somewhere — see below)
VIDEO_PROVIDER=comfyui           # or remote-worker
COMFYUI_BASE_URL=http://<gpu-host>:8188
```

---

## Architecture

```
                        ┌──────────────────────────────────────┐
   "make a reel for  →  │  AI DIRECTOR   (LLM or heuristic)    │
    my iced latte"      │  → validated DirectorBrief           │
                        └──────────────────┬───────────────────┘
                                           │  zod validation boundary
                        ┌──────────────────▼───────────────────┐
                        │  DETERMINISTIC ENGINES               │
                        │  shot planner · camera director      │
                        │  realism engine · consistency engine │
                        │  reference manager · brand profiles  │
                        │  → VideoGenerationSpec               │
                        └──────────────────┬───────────────────┘
                                           │
                        ┌──────────────────▼───────────────────┐
                        │  PROMPT COMPILER                     │
                        │  blueprint → provider dialect        │
                        └──────────────────┬───────────────────┘
                                           │  normalised request
                     ┌─────────────────────┼─────────────────────┐
                     ▼                     ▼                     ▼
                  mock                 comfyui             remote-worker
             (placeholders)         (self-hosted)         (Python/CUDA)
                     └─────────────────────┼─────────────────────┘
                                           ▼
                        quality control → repair → compose → mp4
```

### The deterministic boundary

An LLM is used in exactly one place — the Director — and its output is never
trusted:

```
natural language → LLM → JSON → zod validation → VideoGenerationSpec → engines
```

If the model returns malformed JSON, violates the schema, refuses, or the API is
down, the system falls back to the heuristic director and records why. **No
engine ever reads raw model output**, and the app cannot crash on a bad
generation.

### Directory map

| Path | Contents |
|---|---|
| `src/lib/spec/` | `VideoGenerationSpec`, `DirectorBrief`, controlled vocabularies |
| `src/lib/director/` | LLM + heuristic directors, spec assembler |
| `src/lib/planner/` | Shot planner, motion planner |
| `src/lib/camera/` | 14 camera presets + the selection engine |
| `src/lib/realism/` | Conditional realism rule catalogue + engine |
| `src/lib/consistency/` | Identity locks, cross-shot continuity, seed policy |
| `src/lib/references/` | Reference roles, usage negotiation, shot scoping |
| `src/lib/brands/` | Brand profiles (Cup of Coffee ships as one) |
| `src/lib/prompts/` | Blueprint, camera language, provider dialects, compiler |
| `src/lib/providers/` | Provider contract + mock / ComfyUI / remote-worker |
| `src/lib/quality/` | Analyzer contract, composite evaluator, 5 analyzers, repair planner |
| `src/lib/jobs/` | Job model, pipeline orchestrator, runner |
| `src/lib/compose/` | FFmpeg wrapper and final composer |
| `worker/` | Python GPU worker (FastAPI + Diffusers) |

---

## What makes the output good

The user types one sentence. These do the rest:

**Camera Director** — 14 presets that are *parameter sets*, not labels: movement
intensity, stability, micro-jitter, focal length, depth of field, focus
behaviour, subject distance, parallax. Presets are scored per shot against
purpose, subject kinds, archetype, style and duration. Every preset caps
movement at 0.55 and realism level caps it further, because a camera that flies
is the single fastest way to look like AI.

**Realism Engine** — a conditional rule catalogue, not a fixed block of text. A
macro shot of a coffee cup never carries "realistic hands and fingers", because
naming an absent body part invites the model to render one. Food escalates food
texture; beverages escalate liquid physics; people escalate anatomy and facial
identity.

**Consistency Engine** — per-entity locks by subject kind. A beverage locks
vessel geometry, fill level and ice arrangement; a person locks facial features
and wardrobe. Seed policy (shared / per-shot / random) follows the strength dial.

**Shot Planner** — biased *against* cutting. It will override a director asking
for six shots in eight seconds, because authentic social video reads as staged
when it cuts too often.

**Prompt Compiler** — builds a semantic blueprint, then renders it in the target
model's dialect (flowing prose / labelled blocks / tags). Trims to the text
encoder's token budget by importance, so realism constraints at the tail are
never silently truncated.

**Quality Control** — a composite of analyzers that measure real pixels, not
guesses. FFmpeg ships with the project, so out of the box it measures technical
integrity, temporal stability (including *frozen output* — a valid file where
nothing moves, which nothing else catches), motion plausibility, reference
similarity and subject drift. Adding an API key adds a vision-model review of
anatomy, branding and material realism. See [`docs/QUALITY.md`](docs/QUALITY.md).

---

## Connecting real generation

Two supported paths. Both need an NVIDIA GPU — there is no way around this, and
the app says so rather than pretending.

### ComfyUI (easiest)

Run ComfyUI on any CUDA box, export an API-format workflow, point the app at it.
See [`worker/workflows/README.md`](worker/workflows/README.md).

### Python worker (most control)

Direct Diffusers/PyTorch inference. Runs on a LAN machine, RunPod, Vast.ai or
anywhere else with CUDA. See [`worker/README.md`](worker/README.md).

The provider panel in the UI reports each backend's live status and exactly what
is missing.

---

## Commands

```bash
npm run dev         # development server
npm run build       # production build
npm run test        # unit tests (120)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run verify      # all of the above
```

---

## Honesty rules this project follows

1. The mock provider never claims to produce AI video. Every result carries
   `isRealGeneration`, and the UI shows it prominently.
2. Every quality score is labelled with how it was obtained. `measured: true`
   means the analyzer read the actual pixels; `measured: false` is a risk
   estimate, shown with an asterisk and always superseded by a real
   measurement. Quality control does not invent observations it did not make.
3. Providers that require a GPU say so, and say what is missing and how to fix
   it, rather than failing opaquely.
4. When the configured provider is unavailable, generation falls back to the
   development provider **with a visible warning**, never silently.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit
- [`docs/QUALITY.md`](docs/QUALITY.md) — what QC does and does not measure
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — adding a generation backend
- [`worker/README.md`](worker/README.md) — GPU worker setup
