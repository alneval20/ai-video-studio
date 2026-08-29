# Architecture

## The core idea

Sophistication lives in the engine; the UI stays simple. A user types one
sentence and attaches an image. Everything else — shot structure, camera
choreography, lighting, realism constraints, identity locks, negative prompts,
model parameters — is inferred.

## The pipeline

```
JobRequest              what the user actually asked for
   │
   ▼
DirectorBrief           LLM output, zod-validated. Enums only, no technical fields.
   │  ◄── validation boundary. Nothing downstream sees unvalidated model output.
   ▼
VideoGenerationSpec     the normalised internal representation
   │                    (delivery, scene, realism, consistency, references, shots)
   ▼
CompiledShotPrompt[]    provider-dialect prompts + normalised parameters
   │
   ▼
GenerationRequest       what a provider receives. Nothing provider-specific
   │                    except `providerOptions`.
   ▼
GenerationResult        + QualityReport → repair loop → ComposeResult
```

Raw user text appears exactly once, in `spec.source.prompt`, and is never
re-parsed. Every engine downstream switches on enums.

## Why two directors

| | LLM director | Heuristic director |
|---|---|---|
| Needs a key | yes | no |
| Deterministic | no | yes |
| Nuance | high | moderate |
| Role | primary | fallback + offline floor |

The heuristic director is not a stub. It is a real bilingual (EN/TR) director
with a subject lexicon, environment/time/mood detection, archetype scoring and
narrative beat construction. It validates its own output against the same schema,
so a lexicon change that breaks the contract fails loudly in tests rather than
silently downstream.

The LLM director degrades to it on: malformed JSON, schema violation, refusal,
auth failure, rate limit, network error, or truncation. Every degradation is
recorded in `directorMeta.warnings` and shown in the UI.

## Provider negotiation happens *before* spec assembly

This ordering matters. The provider's capabilities are read first, then the spec
is built against them:

- **Reference usages** — a provider without image-to-video input cannot honour
  an `init_frame`, so that reference is explicitly degraded to
  `descriptive_only` and the prompt compiler describes it in words instead.
- **Resolution** — generation resolution is derived from the provider's
  `maxGenerationEdge` and snapped to a multiple of 16 (every diffusion video
  model requires this; silently rounding produces stretched output).
- **Clip length** — shots longer than `maxClipSeconds` are trimmed, with a note.
- **Negative prompts** — a provider that cannot take them gets its negatives
  folded into the positive prompt rather than losing them.
- **Prompt budget** — the blueprint is trimmed by importance to fit the text
  encoder, so constraints at the tail are never silently truncated.

Discovering these as failures at generation time would waste GPU minutes.

## Model independence

```
VideoGenerationSpec  →  PromptBlueprint  →  provider dialect  →  model request
        (universal)        (semantic)         (adapter)
```

`PromptBlueprint` is the semantic content of a prompt — headline, subjects,
action, references, camera, lighting, motion, atmosphere, continuity, realism,
negatives. Renderers turn it into:

- `cinematic_prose` — flowing paragraphs (modern T2V/I2V models)
- `structured_blocks` — labelled sections (ComfyUI graphs, debugging)
- `tag_soup` — comma-separated keywords (older SD-lineage pipelines)

Supporting a new model means adding a renderer, not touching the director.

Camera intent also travels *structurally* (`cameraFields`) alongside the prose,
so a model that can consume camera parameters directly gets them without
re-parsing English.

## Jobs

States: `draft → planning → queued → generating → quality_check → composing →
completed | failed | cancelled`. Shots have their own states and their own
attempt history.

Planning runs inline (fast, and it is what the UI wants to show immediately);
execution runs in the background and the client polls. Jobs are persisted,
addressable and resumable — so replacing the in-process runner with a queue
consumer on a GPU host requires no changes elsewhere.

## Repair, not regeneration

When a shot fails quality, only that shot is retried, with a concrete mutation:

| Failing dimension | Repair |
|---|---|
| Temporal consistency | Halve camera movement, shorten the shot |
| Subject / product consistency | Strengthen identity-lock language |
| Human anatomy | Reduce subject motion to micro, strengthen anatomy negatives |
| Motion plausibility | Dial back camera movement |
| Infrastructure failure | New seed, nothing else changed |

Every attempt records what changed, so the UI can say "attempt 2: camera
movement reduced, seed changed" rather than "retrying". If attempts run out, the
best-scoring attempt is kept rather than discarding the work.

## Persistence

A JSON-file collection store (`src/lib/storage/`) with per-collection write locks
and atomic temp-file-then-rename writes. Appropriate for a single-process MVP:
no daemon, inspectable with `cat`. Everything above it talks through
`Collection<T>`, so swapping in SQLite or Postgres is a local change.

## Security notes

- Reference and media paths are validated against their storage roots before any
  read; the media route resolves the URL path and rejects anything escaping
  `OUTPUT_DIR`.
- Upload type and size are checked before writing.
- Secrets live only in environment variables; `.env*` is gitignored and
  `.env.example` documents every knob.
- The worker supports shared-bearer auth, required on any public IP.
