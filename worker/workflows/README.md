# ComfyUI Workflows

The `comfyui` provider drives a self-hosted ComfyUI instance. It does **not**
ship a workflow, and that is deliberate: a workflow references specific model
files and custom nodes, and one written against models you do not have would
fail in a confusing way. You export your own, once.

---

## Creating one

1. Build a working text-to-video or image-to-video workflow in ComfyUI and
   generate one clip manually. **Confirm it works before wiring it up here.**
2. Settings → enable **Dev mode options**.
3. **Save (API Format)** — this is a different file from the normal save.
4. Save it in this directory, e.g. `i2v_default.api.json`.
5. Point the app at it:

   ```bash
   VIDEO_PROVIDER=comfyui
   COMFYUI_BASE_URL=http://<gpu-host>:8188
   COMFYUI_WORKFLOW=worker/workflows/i2v_default.api.json
   ```

6. Replace the hardcoded values in the JSON with the tokens below.

---

## Placeholder tokens

The adapter does plain string substitution before submitting the graph. Every
token it fills:

| Token | Replaced with | Typical node input |
|---|---|---|
| `{{POSITIVE_PROMPT}}` | Compiled positive prompt (JSON-escaped) | `CLIPTextEncode.text` |
| `{{NEGATIVE_PROMPT}}` | Compiled negative prompt (JSON-escaped) | negative `CLIPTextEncode.text` |
| `{{WIDTH}}` | Generation width, multiple of 16 | latent `width` |
| `{{HEIGHT}}` | Generation height, multiple of 16 | latent `height` |
| `{{FRAMES}}` | `round(duration × fps)` | `length` / `num_frames` |
| `{{FPS}}` | Generation frame rate | video-combine `frame_rate` |
| `{{SEED}}` | Per-shot seed from the consistency contract | `KSampler.seed` |
| `{{CFG}}` | `3 + promptAdherence × 6` | `KSampler.cfg` |
| `{{STEPS}}` | `20 + promptAdherence × 20` | `KSampler.steps` |
| `{{INIT_IMAGE}}` | Absolute path to the init-frame reference, or `""` | `LoadImage.image` |
| `{{FILENAME_PREFIX}}` | `avs_<shotId>_a<attempt>` | save node `filename_prefix` |

**Any `{{TOKEN}}` the adapter does not recognise is a hard error**, not a silent
pass-through — you find out at health-check time rather than getting a graph
containing a literal `{{FOO}}`.

Numeric tokens are unquoted in the JSON; string tokens sit inside quotes:

```json
{
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "{{POSITIVE_PROMPT}}", "clip": ["4", 1] }
  },
  "3": {
    "class_type": "KSampler",
    "inputs": { "seed": {{SEED}}, "steps": {{STEPS}}, "cfg": {{CFG}} }
  }
}
```

---

## Requirements

- ComfyUI started with `--listen` so it is reachable off-host.
- A video model installed (Wan 2.x, LTX-Video, SVD, CogVideoX…).
- A node that writes **mp4/webm** — the adapter looks for video outputs under
  the history entry's `videos`, `gifs` or `images` buckets. `VideoHelperSuite`'s
  `VHS_VideoCombine` is the usual choice.

## Init-frame note

`{{INIT_IMAGE}}` is an **absolute path on the machine running this app**. If
ComfyUI runs on a different host, that path will not resolve there. Either run
ComfyUI on the same machine, mount shared storage at the same path, or use the
`remote-worker` provider instead — it sends images base64-encoded in the request
body and has no such constraint.

## Verifying

```bash
curl http://<gpu-host>:8188/system_stats
```

Then check the app's provider panel. If the workflow is missing or ComfyUI is
unreachable, the panel says exactly which, and generation falls back to the
development provider with a visible warning rather than failing silently.
