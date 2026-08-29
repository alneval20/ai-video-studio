import { describe, expect, it } from "vitest";
import { getBuiltInBrand } from "@/lib/brands/profiles";
import { HeuristicDirector } from "@/lib/director/heuristic-director";
import { assembleSpec, generationResolution } from "@/lib/director/spec-assembler";
import { compileSpec } from "@/lib/prompts/prompt-compiler";
import { MockProvider } from "@/lib/providers/mock/mock-provider";
import type { ProviderCapabilities } from "@/lib/providers/types";
import type { StoredReference } from "@/lib/references/types";
import { VideoGenerationSpec } from "@/lib/spec/spec";

/**
 * The end-to-end contract from the product brief:
 *
 *   simple prompt -> director -> structured spec -> shot plan ->
 *   compiled prompts -> provider request
 *
 * This runs the whole deterministic path with no network, no GPU and no key.
 */

const CAPS = new MockProvider().capabilities;

function productRef(): StoredReference {
  return {
    id: "ref_cup",
    projectId: "prj_test",
    filename: "cup-of-coffee-product.png",
    mimeType: "image/png",
    bytes: 2048,
    width: 1024,
    height: 1024,
    role: "product",
    roleSource: "user",
    storagePath: "references/prj_test/ref_cup.png",
    url: "/api/references/ref_cup/file",
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

async function build(
  prompt: string,
  options: { references?: StoredReference[]; brandId?: string; capabilities?: ProviderCapabilities } = {},
) {
  const references = options.references ?? [];
  const brand = options.brandId ? (getBuiltInBrand(options.brandId) ?? null) : null;
  const caps = options.capabilities ?? CAPS;

  const director = await new HeuristicDirector().direct({
    prompt,
    brand,
    referenceRoles: references.map((r) => r.role),
    overrides: {},
  });

  const { spec, notes } = assembleSpec({
    projectId: "prj_test",
    prompt,
    director,
    brand,
    references,
    provider: {
      id: caps.id,
      supportsInitFrame: caps.supportsInitFrame,
      supportedReferenceUsages: caps.supportedReferenceUsages,
      maxGenerationEdge: caps.maxGenerationEdge,
      maxFps: caps.maxFps,
      maxClipSeconds: caps.maxClipSeconds,
    },
  });

  return { spec, notes, compiled: compileSpec(spec, caps) };
}

const TURKISH_PROMPT =
  "Cup of Coffee için gece kafede gerçekçi bir video. Masada iced latte var. Bir kız telefonuyla kahveyi çekiyor. Instagram videosu gibi olsun.";

describe("prompt -> spec", () => {
  it("produces a schema-valid spec from a casual prompt", async () => {
    const { spec } = await build(TURKISH_PROMPT, { brandId: "cup-of-coffee" });
    expect(() => VideoGenerationSpec.parse(spec)).not.toThrow();
  });

  it("infers the scene the user described without being told the details", async () => {
    const { spec } = await build(TURKISH_PROMPT, { brandId: "cup-of-coffee" });

    expect(spec.delivery.format).toBe("instagram_reel");
    expect(spec.delivery.aspectRatio).toBe("9:16");
    expect(spec.scene.environment.timeOfDay).toBe("night");
    expect(spec.realism.level).toBe("high");
    // A beverage scene must escalate liquid physics without being asked.
    expect(spec.realism.emphasis.liquid_physics).toBe("strict");
    expect(spec.shots.length).toBeGreaterThanOrEqual(1);
  });

  it("exports at 1080x1920 while generating at a GPU-sane resolution", async () => {
    const { spec } = await build(TURKISH_PROMPT);
    expect(spec.delivery.export).toMatchObject({ width: 1080, height: 1920 });
    expect(spec.delivery.generation.width).toBeLessThanOrEqual(CAPS.maxGenerationEdge);
    // Diffusion video models require multiples of 16.
    expect(spec.delivery.generation.width % 16).toBe(0);
    expect(spec.delivery.generation.height % 16).toBe(0);
  });

  it("never asks the provider for a clip it cannot render", async () => {
    const { spec } = await build("A 40 second cinematic cafe film");
    for (const shot of spec.shots) {
      expect(shot.durationSec).toBeLessThanOrEqual(CAPS.maxClipSeconds);
    }
  });

  it("applies brand defaults and brand avoidances", async () => {
    const { spec } = await build("a coffee video", { brandId: "cup-of-coffee" });
    expect(spec.source.brandProfileId).toBe("cup-of-coffee");
    expect(spec.creative.colorGrade).toBe("warm_film");
    expect(spec.realism.negatives.join(" ")).toContain("CGI");
  });

  it("binds an attached product reference and raises subject-consistency targets", async () => {
    const withRef = await build(TURKISH_PROMPT, { references: [productRef()] });
    const withoutRef = await build(TURKISH_PROMPT);

    expect(withRef.spec.references).toHaveLength(1);
    expect(withRef.spec.references[0].usage).toBe("identity");
    expect(withRef.spec.quality.minSubjectConsistency).toBeGreaterThan(
      withoutRef.spec.quality.minSubjectConsistency,
    );
    expect(withRef.spec.realism.appliedRuleIds).toContain("product.reference");
  });

  it("gives every shot a deterministic seed", async () => {
    const a = await build(TURKISH_PROMPT);
    const b = await build(TURKISH_PROMPT);
    expect(a.spec.shots.map((s) => s.seed)).toEqual(b.spec.shots.map((s) => s.seed));
    expect(a.spec.shots.every((s) => s.seed > 0)).toBe(true);
  });
});

describe("spec -> compiled prompts", () => {
  it("compiles a substantial prompt per shot without the user writing any syntax", async () => {
    const { spec, compiled } = await build(TURKISH_PROMPT, { brandId: "cup-of-coffee" });
    expect(compiled.shots).toHaveLength(spec.shots.length);

    for (const shot of compiled.shots) {
      expect(shot.positive.length).toBeGreaterThan(300);
      expect(shot.negative.length).toBeGreaterThan(20);
      expect(shot.sections.length).toBeGreaterThan(4);
      // The prompt must describe craft, not leak internal identifiers.
      expect(shot.positive).not.toContain("handheld_iphone");
      expect(shot.positive).not.toContain("shot_");
    }
  });

  it("includes the realism language the scene actually needs", async () => {
    const { compiled } = await build(TURKISH_PROMPT);
    const text = compiled.shots.map((s) => `${s.positive} ${s.negative}`).join(" ").toLowerCase();

    expect(text).toContain("photorealistic");
    expect(text).toContain("condensation");
    expect(text).toContain("cgi");
  });

  it("keeps prompts inside a sane attention budget", async () => {
    const { compiled } = await build(TURKISH_PROMPT, { brandId: "cup-of-coffee" });
    for (const shot of compiled.shots) {
      expect(shot.approxTokens).toBeLessThan(900);
    }
  });

  it("folds negatives into the positive prompt when a provider lacks negative support", async () => {
    const caps: ProviderCapabilities = { ...CAPS, supportsNegativePrompt: false };
    const { compiled } = await build(TURKISH_PROMPT, { capabilities: caps });
    const shot = compiled.shots[0];
    expect(shot.negative).toBe("");
    expect(shot.positive).toContain("Avoid entirely:");
  });

  it("renders a different dialect for a different prompt style", async () => {
    const structured = await build(TURKISH_PROMPT, {
      capabilities: { ...CAPS, promptStyle: "structured_blocks" },
    });
    const tags = await build(TURKISH_PROMPT, { capabilities: { ...CAPS, promptStyle: "tag_soup" } });

    expect(structured.compiled.shots[0].positive).toContain("CAMERA:");
    expect(tags.compiled.shots[0].positive).toContain(",");
    expect(tags.compiled.shots[0].positive).not.toContain("CAMERA:");
  });

  it("carries a structured camera intent alongside the prose", async () => {
    const { compiled } = await build(TURKISH_PROMPT);
    expect(compiled.shots[0].cameraFields).toHaveProperty("move_intensity");
    expect(compiled.shots[0].cameraFields).toHaveProperty("focal_length_mm");
  });
});

describe("generationResolution", () => {
  it("respects the aspect ratio and snaps to multiples of 16", () => {
    expect(generationResolution("9:16", 832)).toEqual({ width: 464, height: 832 });
    expect(generationResolution("16:9", 832)).toEqual({ width: 832, height: 464 });
    expect(generationResolution("1:1", 512)).toEqual({ width: 512, height: 512 });
  });
});
