/**
 * Generates `notebooks/amedspor_ltx_i2v.ipynb`.
 *
 * The notebook is generated rather than hand-written so the prompt it runs is
 * the compiler's real output for the LTX profile. A hand-copied prompt drifts
 * from the pipeline the moment any engine changes, and then the render no
 * longer reflects the plan the app produced.
 *
 *   VIDEO_MODEL_PROFILE=ltx-2b-i2v-576p node --import tsx scripts/build-colab-notebook.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assembleSpec } from "@/lib/director";
import { compileSpec } from "@/lib/prompts/prompt-compiler";
import { getProvider } from "@/lib/providers/registry";
import { getI2vProfile, frameCountFor, durationForFrames } from "@/lib/providers/remote-worker/profiles";
import { getBrand } from "@/lib/brands";
import { CAMPAIGN_BRIEF, resolveCampaignReferences } from "./campaign-brief";

const REPO = "https://github.com/alneval20/ai-video-studio.git";
const PROFILE_ID = "ltx-2b-i2v-576p";
/** Short first test: proves real motion without burning a free-tier session. */
const TEST_DURATION_SEC = 3;

type Cell = { cell_type: "markdown" | "code"; metadata: Record<string, unknown>; source: string[] };

const md = (...lines: string[]): Cell => ({
  cell_type: "markdown",
  metadata: {},
  source: lines.map((l, i) => (i === lines.length - 1 ? l : `${l}\n`)),
});

const code = (...lines: string[]): Cell => ({
  cell_type: "code",
  metadata: {},
  source: lines.map((l, i) => (i === lines.length - 1 ? l : `${l}\n`)),
});

async function main() {
  process.env.VIDEO_MODEL_PROFILE = PROFILE_ID;

  const provider = getProvider("remote-worker");
  const profile = getI2vProfile(PROFILE_ID);
  const brand = await getBrand("cup-of-coffee");
  const { references } = await resolveCampaignReferences();

  const { spec } = assembleSpec({
    projectId: "prj_amedspor",
    prompt: "Amedspor maç günlerinde tüm ürünlerde %21 indirim",
    director: { brief: CAMPAIGN_BRIEF, engine: "heuristic", model: null, fallbackUsed: false, warnings: [], elapsedMs: 0 },
    brand,
    references,
    provider: {
      id: provider.capabilities.id,
      supportsInitFrame: provider.capabilities.supportsInitFrame,
      supportedReferenceUsages: provider.capabilities.supportedReferenceUsages,
      maxGenerationEdge: provider.capabilities.maxGenerationEdge,
      supportedGenerationSizes: provider.capabilities.supportedGenerationSizes,
      maxFps: provider.capabilities.maxFps,
      maxClipSeconds: provider.capabilities.maxClipSeconds,
    },
    advanced: {
      shotCount: 3,
      motionBudget: 0.3,
      consistencyStrength: 0.95,
      referenceStrength: 1.0,
      seed: 212026,
      negativePrompt:
        "on-screen text, letters, numbers, captions, watermark, stadium, crowd, football pitch, sports poster, jersey",
      maxShots: 3,
    },
  });

  const compiled = compileSpec(spec, provider.capabilities);
  // Shot 2 is the macro on the iced latte — the shot the prepared init frame
  // actually depicts, so it is the honest first test of image conditioning.
  const shot = compiled.shots[1];
  const size = spec.delivery.generation;
  const frames = frameCountFor(profile, TEST_DURATION_SEC);
  const duration = durationForFrames(profile, frames);

  const notebook = {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {
      colab: { provenance: [], gpuType: "T4", toc_visible: true },
      kernelspec: { name: "python3", display_name: "Python 3" },
      language_info: { name: "python" },
      accelerator: "GPU",
    },
    cells: [
      md(
        "# Cup of Coffee — Amedspor match-day reel",
        "### Real image-to-video on a free GPU",
        "",
        "Generates a genuine **LTX-Video 2B** image-to-video clip conditioned on the real",
        "Cup of Coffee product photo. Vertical 9:16, 576×1024, 24 fps.",
        "",
        "This is real generative video. There is no slideshow, no pan/zoom over a still,",
        "no FFmpeg-synthesised motion and no mock output anywhere in this notebook —",
        "and the verification cell at the end **measures** inter-frame change and fails",
        "if the result is effectively frozen.",
        "",
        "---",
        "### Before you run: switch on the GPU",
        "**Runtime → Change runtime type → Hardware accelerator: T4 GPU → Save**",
        "",
        "Then **Runtime → Run all**. Everything after that is automatic.",
        "",
        "> **If a previous attempt hung during loading:** *Runtime → Restart session*",
        "> (not *Disconnect and delete runtime*). A restart clears the wedged memory",
        "> but keeps the disk, so the downloaded weights are reused.",
      ),

      md("## 1 · Confirm the GPU"),
      code(
        "import subprocess, sys",
        "",
        "out = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total',",
        "                      '--format=csv,noheader'], capture_output=True, text=True)",
        "if out.returncode != 0:",
        "    sys.exit('No GPU. Runtime -> Change runtime type -> T4 GPU, then Run all again.')",
        "",
        "name, mem = [p.strip() for p in out.stdout.strip().split(',')]",
        "gib = int(mem.split()[0]) / 1024",
        "print(f'GPU: {name} — {gib:.1f} GiB')",
        `assert gib >= ${profile.minVramGib}, f'Need >= ${profile.minVramGib} GiB for ${profile.id}; this GPU has {gib:.1f} GiB.'`,
        "print('OK — enough VRAM for the LTX 2B profile.')",
      ),

      md(
        "## 2 · Install dependencies",
        "_~2 minutes. Torch is already present in Colab._",
        "",
        "`bitsandbytes` is required: the text encoder is loaded in 8-bit, which is",
        "what keeps this within free Colab's host RAM.",
        "",
        "**This cell may restart the runtime once.** Colab preloads Pillow, and the",
        "LTX pipeline needs a newer one than ships by default. If it restarts, just",
        "click *Runtime → Run all* again — the second pass goes straight through.",
      ),
      code(
        "import os, subprocess, sys",
        "",
        "PACKAGES = [",
        "    'diffusers>=0.35.1',",
        "    'transformers>=4.49.0',",
        "    'accelerate',",
        "    'safetensors',",
        "    'sentencepiece',",
        "    'imageio',",
        "    'imageio-ffmpeg',",
        "    'bitsandbytes',",
        "    # Colab ships Pillow 11.x. The diffusers LTX pipeline imports",
        "    # PIL._typing._Ink, which only exists from Pillow 12.0 — without this",
        "    # pin the LTX import dies with \"cannot import name '_Ink'\".",
        "    'pillow>=12.0.0',",
        "]",
        "",
        "subprocess.run(",
        "    [sys.executable, '-m', 'pip', 'install', '-q', '--upgrade', *PACKAGES],",
        "    check=True,",
        ")",
        "",
        "# Probe in a CLEAN interpreter. This tests what is actually on disk,",
        "# independent of whatever this kernel imported at startup.",
        "probe = subprocess.run(",
        "    [sys.executable, '-c',",
        "     'import PIL; from diffusers import LTXImageToVideoPipeline; print(PIL.__version__)'],",
        "    capture_output=True, text=True,",
        ")",
        "if probe.returncode != 0:",
        "    raise RuntimeError('Install is broken on disk:\\n' + probe.stderr[-2000:])",
        "",
        "disk_version = probe.stdout.strip()",
        "",
        "# Colab preloads PIL at startup, so pip can upgrade the files on disk while",
        "# this kernel keeps the old module object in sys.modules. That mismatch is",
        "# exactly what produced the '_Ink' ImportError. Restart when it happens.",
        "import PIL",
        "if PIL.__version__ != disk_version:",
        "    print(f'This kernel has a stale Pillow {PIL.__version__}; disk now has {disk_version}.')",
        "    print('Restarting the runtime so the new version is picked up.')",
        "    print()",
        "    print('>>> When it reconnects, click Runtime -> Run all again.')",
        "    print('>>> This happens at most once; the second pass skips straight through.')",
        "    sys.stdout.flush()",
        "    os.kill(os.getpid(), 9)",
        "",
        "print(f'dependencies OK — Pillow {disk_version}, LTX pipeline imports cleanly')",
      ),

      md(
        "### Host RAM — the constraint that actually matters here",
        "",
        "A free Colab VM has ~12.7 GB of system RAM. LTX's text encoder is T5-XXL,",
        "roughly 11 GB in bf16, and `from_pretrained` materialises components in CPU",
        "RAM before moving them to the GPU. Loading the whole pipeline in one call",
        "therefore exhausts host RAM and the runtime thrashes — which looks exactly",
        "like a load that is stuck at 15% forever.",
        "",
        "The T4's 15 GB of VRAM was never the bottleneck.",
      ),
      code(
        "import psutil, torch",
        "",
        "ram = psutil.virtual_memory()",
        "print(f'host RAM   {ram.total/2**30:.1f} GiB total, {ram.available/2**30:.1f} GiB free')",
        "if torch.cuda.is_available():",
        "    print(f'VRAM       {torch.cuda.get_device_properties(0).total_memory/2**30:.1f} GiB')",
        "print()",
        "print('Staged load keeps peak host RAM well under the limit:')",
        "print('  1. 8-bit text encoder straight to GPU, encode prompts, free it')",
        "print('  2. transformer + VAE only (~4.5 GB); text encoder never loaded again')",
      ),

      md("## 3 · Fetch the repository and the real brand assets"),
      code(
        "import os, pathlib",
        "",
        "if not pathlib.Path('ai-video-studio').exists():",
        `    !git clone --depth 1 ${REPO}`,
        "",
        "os.chdir('/content/ai-video-studio')",
        "assets = pathlib.Path('public')",
        "product = assets / 'cup_of_coffee_HD_preserved.png'",
        "assert product.exists(), 'Product asset missing from the repository.'",
        "print('assets:', *[p.name for p in assets.iterdir() if p.is_file()], sep='\\n  ')",
      ),

      md(
        "## 4 · Prepare the init frame",
        "",
        "The source photo is stored **landscape but rotated 90°**, so it is uprighted,",
        "then centre-cropped to exactly 576×1024 — 9:16 and divisible by 32, which LTX",
        "requires. This only conditions the generator; it does not animate anything.",
      ),
      code(
        "from PIL import Image, ImageOps",
        "",
        `W, H = ${size.width}, ${size.height}`,
        "",
        "img = ImageOps.exif_transpose(Image.open(product)).convert('RGB')",
        "if img.width > img.height:",
        "    img = img.rotate(-90, expand=True)   # upright the sideways original",
        "",
        "scale = max(W / img.width, H / img.height)",
        "img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)",
        "left, top = (img.width - W) // 2, (img.height - H) // 2",
        "init_frame = img.crop((left, top, left + W, top + H))",
        "",
        "assert init_frame.size == (W, H)",
        "assert W % 32 == 0 and H % 32 == 0, 'LTX requires both dimensions divisible by 32.'",
        "init_frame.save('init_frame.png')",
        "print(f'init frame: {init_frame.size[0]}x{init_frame.size[1]}')",
        "init_frame",
      ),

      md(
        "## 5 · The prompt",
        "",
        "Compiled by the studio pipeline for this exact shot — director → shot planner →",
        "camera / realism / consistency → prompt compiler. Not hand-written here.",
      ),
      code(
        "PROMPT = " + JSON.stringify(shot.positive),
        "",
        "NEGATIVE = " + JSON.stringify(shot.negative),
        "",
        `WIDTH, HEIGHT = ${size.width}, ${size.height}`,
        `NUM_FRAMES = ${frames}          # ${profile.temporalStride}n+1, required by the LTX temporal VAE`,
        `FPS = ${profile.fps}`,
        `SEED = ${spec.consistency.baseSeed}`,
        `STEPS = ${profile.sampler.numInferenceSteps}`,
        `GUIDANCE = ${profile.sampler.guidanceScale}`,
        "",
        `assert (NUM_FRAMES - 1) % ${profile.temporalStride} == 0`,
        `print(f'{NUM_FRAMES} frames @ {FPS}fps = {NUM_FRAMES/FPS:.2f}s at {WIDTH}x{HEIGHT}')`,
        "print()",
        "print(PROMPT)",
      ),

      md(
        "## 6a · Encode the prompt with an 8-bit text encoder, then free it",
        "",
        "This is the step that makes the notebook finish on free Colab. The T5-XXL",
        "encoder is loaded **on its own**, in 8-bit, directly onto the GPU — never",
        "materialised in host RAM alongside the transformer. Once the prompt",
        "embeddings exist the encoder is deleted, because generation does not need",
        "it again.",
        "",
        "_First run downloads the checkpoint (~4 min). Re-runs use the cache._",
      ),
      code(
        "import gc, torch",
        "from diffusers import LTXImageToVideoPipeline",
        "from transformers import BitsAndBytesConfig, T5EncoderModel",
        "",
        `MODEL_ID = '${profile.modelId}'`,
        `MAX_SEQ = ${profile.maxPromptTokens}   # explicit: the pipeline default of 128 would truncate`,
        "",
        "# 8-bit + device_map='auto' streams shards to the GPU, so the ~11 GB bf16",
        "# encoder never has to fit in the VM's ~12.7 GB of host RAM.",
        "text_encoder = T5EncoderModel.from_pretrained(",
        "    MODEL_ID,",
        "    subfolder='text_encoder',",
        "    quantization_config=BitsAndBytesConfig(load_in_8bit=True),",
        "    device_map='auto',",
        ")",
        "print('text encoder loaded (8-bit)')",
        "",
        "# A pipeline shell with ONLY the encoder: transformer and VAE are skipped.",
        "# Using the real encode_prompt avoids re-implementing LTX's tokenisation.",
        "shell = LTXImageToVideoPipeline.from_pretrained(",
        "    MODEL_ID,",
        "    text_encoder=text_encoder,",
        "    transformer=None,",
        "    vae=None,",
        "    torch_dtype=torch.bfloat16,",
        ")",
        "",
        "with torch.no_grad():",
        "    pe, pm, ne, nm = shell.encode_prompt(",
        "        prompt=PROMPT,",
        "        negative_prompt=NEGATIVE,",
        "        do_classifier_free_guidance=True,",
        "        device='cuda',",
        "        max_sequence_length=MAX_SEQ,",
        "    )",
        "",
        "# Park the embeddings on the CPU (a few MB) while the transformer loads.",
        "PROMPT_EMBEDS, PROMPT_MASK = pe.cpu(), pm.cpu()",
        "NEG_EMBEDS, NEG_MASK = ne.cpu(), nm.cpu()",
        "print('embeddings:', tuple(PROMPT_EMBEDS.shape))",
        "",
        "del shell, text_encoder, pe, pm, ne, nm",
        "gc.collect()",
        "torch.cuda.empty_cache()",
        "print(f'encoder freed — {psutil.virtual_memory().available/2**30:.1f} GiB host RAM free')",
      ),

      md(
        "## 6b · Load the transformer and VAE only",
        "",
        "`text_encoder=None` and `tokenizer=None` skip the heavy component entirely.",
        "What remains is the 2B transformer and the VAE — about 4.5 GB.",
      ),
      code(
        "pipe = LTXImageToVideoPipeline.from_pretrained(",
        "    MODEL_ID,",
        "    text_encoder=None,",
        "    tokenizer=None,",
        "    torch_dtype=torch.bfloat16,",
        ")",
        "# Offload rather than .to('cuda'): keeps VRAM headroom on a 16 GiB card.",
        "pipe.enable_model_cpu_offload()",
        "pipe.vae.enable_tiling()",
        "",
        "print('pipeline ready on', torch.cuda.get_device_name(0))",
        "print(f'host RAM free: {psutil.virtual_memory().available/2**30:.1f} GiB')",
      ),

      md(
        "## 7 · Generate",
        "",
        "Uses the embeddings from 6a — no text encoder is present in memory. This is",
        "the real diffusion run. _~3–6 minutes on a T4._",
      ),
      code(
        "import time",
        "",
        "generator = torch.Generator(device='cuda').manual_seed(SEED)",
        "started = time.time()",
        "",
        "result = pipe(",
        "    image=init_frame,",
        "    prompt_embeds=PROMPT_EMBEDS.to('cuda'),",
        "    prompt_attention_mask=PROMPT_MASK.to('cuda'),",
        "    negative_prompt_embeds=NEG_EMBEDS.to('cuda'),",
        "    negative_prompt_attention_mask=NEG_MASK.to('cuda'),",
        "    width=WIDTH,",
        "    height=HEIGHT,",
        "    num_frames=NUM_FRAMES,",
        "    num_inference_steps=STEPS,",
        "    guidance_scale=GUIDANCE,",
        "    generator=generator,",
        ")",
        "",
        "frames_out = result.frames[0]",
        "print(f'generated {len(frames_out)} frames in {(time.time()-started)/60:.1f} min')",
      ),

      md("## 8 · Export H.264 MP4"),
      code(
        "from diffusers.utils import export_to_video",
        "import pathlib",
        "",
        "OUT = pathlib.Path('/content/outputs')",
        "OUT.mkdir(parents=True, exist_ok=True)",
        "mp4 = OUT / 'amedspor_ltx_i2v_576x1024.mp4'",
        "",
        "export_to_video(frames_out, str(mp4), fps=FPS)",
        "print(f'{mp4}  ({mp4.stat().st_size/1024:.0f} KB)')",
      ),

      md(
        "## 9 · Verify it is real video",
        "",
        "Measures mean absolute change between consecutive frames. A still image,",
        "a slideshow or a frozen generation scores ~0 and **fails here**.",
      ),
      code(
        "import numpy as np",
        "",
        "arr = np.stack([np.asarray(f, dtype=np.float32) for f in frames_out])",
        "deltas = np.abs(np.diff(arr, axis=0)).mean(axis=(1, 2, 3))",
        "mean_delta = float(deltas.mean())",
        "",
        "print(f'frames            {len(frames_out)}')",
        "print(f'mean frame delta  {mean_delta:.3f}  (0 = frozen)')",
        "print(f'min / max         {deltas.min():.3f} / {deltas.max():.3f}')",
        "",
        "assert mean_delta > 0.35, (",
        "    f'Effectively frozen (delta {mean_delta:.3f}). This is NOT real temporal video.'",
        ")",
        "print('\\nPASS — genuine frame-to-frame motion.')",
      ),

      md("## 10 · Watch, then download"),
      code(
        "from IPython.display import Video, display",
        "display(Video(str(mp4), embed=True, width=360))",
      ),
      code(
        "from google.colab import files",
        "files.download(str(mp4))",
      ),

      md(
        "---",
        "### What to expect",
        "",
        "LTX 2B produces believable atmospheric motion — light shifting across the cup,",
        "gentle camera drift, condensation reading as wet. It is a 2B model, so",
        "ice-cube refraction and fine liquid detail are its weakest areas; that is the",
        "documented trade-off of the free path (`docs/FREE-GPU.md`).",
        "",
        "If the motion is too subtle, raise `STEPS` to 40 or re-run with a different",
        "`SEED` — each attempt is a couple of minutes and costs nothing.",
        "",
        "**Campaign text is never generated into the footage.** `%21` and the Turkish",
        "copy are composited afterwards as clean overlay layers by",
        "`src/lib/compose/amedspor-compositor.ts`.",
      ),
    ] satisfies Cell[],
  };

  const outPath = path.resolve("notebooks/amedspor_ltx_i2v.ipynb");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(notebook, null, 1), "utf8");

  console.log(`wrote ${outPath}`);
  console.log(`  profile   ${profile.id} (${profile.modelId})`);
  console.log(`  size      ${size.width}x${size.height}`);
  console.log(`  frames    ${frames} @ ${profile.fps}fps = ${duration}s`);
  console.log(`  shot      ${shot.shotTitle}`);
  console.log(`  prompt    ${shot.approxTokens} tokens`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
