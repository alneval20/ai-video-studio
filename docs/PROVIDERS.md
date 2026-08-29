# Providers

A provider is a video-generation backend. Adding one touches exactly two files.

## The contract

```ts
interface VideoProvider {
  readonly capabilities: ProviderCapabilities;
  health(): Promise<ProviderHealth>;   // must never throw
  generate(req: GenerationRequest, ctx?: GenerationContext): Promise<GenerationResult>;
}
```

## Capabilities are load-bearing

They are read *before* the spec is assembled, so the spec is built against what
the backend can actually do rather than discovering failures on the GPU:

| Field | Effect on the spec |
|---|---|
| `supportsInitFrame` | An `init_frame` reference degrades to `descriptive_only` when false |
| `supportedReferenceUsages` | Unsupported usages degrade explicitly, with a note in the UI |
| `maxGenerationEdge` | Sets generation resolution (snapped to a multiple of 16) |
| `maxFps` | Caps generation frame rate |
| `maxClipSeconds` | Trims longer shots, with a planner note |
| `supportsNegativePrompt` | When false, negatives are folded into the positive prompt |
| `supportsSeed` | When false, seed is sent as 0 |
| `promptStyle` | Selects the prompt dialect renderer |
| `maxPromptTokens` | Blueprint is trimmed by importance to fit |
| `producesRealVideo` | **Drives the honesty banners throughout the UI** |

## Adding one

```ts
// src/lib/providers/acme/acme-provider.ts
export class AcmeProvider implements VideoProvider {
  readonly capabilities: ProviderCapabilities = {
    id: "acme",
    label: "Acme Video",
    description: "…",
    kind: "external_api",
    requiresGpu: false,
    requiresApiKey: true,
    producesRealVideo: true,
    supportsInitFrame: true,
    supportedReferenceUsages: ["init_frame", "identity", "descriptive_only"],
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxGenerationEdge: 1280,
    maxFps: 30,
    maxClipSeconds: 10,
    promptStyle: "cinematic_prose",
    maxPromptTokens: 1000,
  };

  async health(): Promise<ProviderHealth> {
    if (!process.env.ACME_API_KEY) {
      return {
        available: false,
        detail: "No ACME_API_KEY is set.",
        remedy: "Add ACME_API_KEY to .env.local.",   // shown verbatim in the UI
      };
    }
    return { available: true, detail: "Ready." };
  }

  async generate(req, ctx) {
    ctx?.onProgress?.(0.1, "Submitting");
    // …call the API, write the file to req.outputPath…
    return {
      requestId: req.requestId,
      shotId: req.shotId,
      status: "succeeded",
      outputPath: req.outputPath,
      posterPath: null,
      mimeType: "video/mp4",
      durationSec: req.durationSec,
      width: req.width,
      height: req.height,
      fps: req.fps,
      provider: { id: "acme", model: "acme-v2" },
      isRealGeneration: true,
      diagnostics: [],
      metrics: { elapsedMs: 0 },
    };
  }
}
```

Then register it:

```ts
// src/lib/providers/registry.ts
register(new AcmeProvider());
```

That is the whole change. The director, planner, camera, realism, consistency,
compiler, jobs, quality and UI layers need no modification — the new backend
appears in the provider picker and the health panel automatically.

## Rules

1. **`health()` must never throw.** Return `{available: false, detail, remedy}`.
   `detail` says what is wrong; `remedy` says what the user must do about it.
2. **Be honest about `producesRealVideo`.** It drives the placeholder warnings.
   A provider that returns anything other than generated video sets it `false`.
3. **Provider-specific settings stay in `providerOptions`.** No code outside the
   adapter may read that field.
4. **Report progress** via `ctx.onProgress` when the backend allows it.
5. **Respect `ctx.signal`** so cancellation works.
6. **Write to `request.outputPath` exactly.** The job pipeline owns file layout.

## Shipped providers

| Id | Kind | Real video | Needs |
|---|---|---|---|
| `mock` | mock | **no** | nothing — the zero-setup default |
| `comfyui` | remote | yes | ComfyUI + NVIDIA GPU + an exported workflow |
| `remote-worker` | remote | yes | the Python worker on an NVIDIA GPU |

## Fallback behaviour

`resolveProvider()` checks health before generation. If the configured provider
is unavailable it falls back to `mock` and records a `fallbackReason` that the UI
shows as a warning banner. Generation degrades to an honest placeholder rather
than dead-ending the user — but it is never silent.
