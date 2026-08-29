import { describe, expect, it } from "vitest";
import { HeuristicDirector } from "@/lib/director/heuristic-director";
import { assembleSpec } from "@/lib/director/spec-assembler";
import { trimBlueprint } from "@/lib/prompts/blueprint";
import { buildBlueprint } from "@/lib/prompts/blueprint";
import { compileShot } from "@/lib/prompts/prompt-compiler";
import { MockProvider } from "@/lib/providers/mock/mock-provider";
import type { ProviderCapabilities } from "@/lib/providers/types";

const CAPS = new MockProvider().capabilities;

const PROMPT =
  "Cup of Coffee için gece kafede gerçekçi bir video. Masada iced latte var. Bir kız telefonuyla kahveyi çekiyor. Instagram videosu gibi olsun.";

async function buildSpec() {
  const director = await new HeuristicDirector().direct({
    prompt: PROMPT,
    brand: null,
    referenceRoles: [],
    overrides: {},
  });
  return assembleSpec({
    projectId: "prj_budget",
    prompt: PROMPT,
    director,
    brand: null,
    references: [],
    provider: {
      id: CAPS.id,
      supportsInitFrame: CAPS.supportsInitFrame,
      supportedReferenceUsages: CAPS.supportedReferenceUsages,
      maxGenerationEdge: CAPS.maxGenerationEdge,
      maxFps: CAPS.maxFps,
      maxClipSeconds: CAPS.maxClipSeconds,
    },
  }).spec;
}

describe("prompt budgeting", () => {
  it("fits the provider's text-encoder budget", async () => {
    const spec = await buildSpec();
    for (const shot of spec.shots) {
      const compiled = compileShot(spec, shot, CAPS);
      // Allow a small margin: the estimate is approximate by design.
      expect(compiled.approxTokens).toBeLessThanOrEqual(CAPS.maxPromptTokens * 1.15);
    }
  });

  it("trims progressively harder as the budget shrinks", async () => {
    const spec = await buildSpec();
    const shot = spec.shots[0];

    const generous = compileShot(spec, shot, { ...CAPS, maxPromptTokens: 4000 });
    const tight: ProviderCapabilities = { ...CAPS, maxPromptTokens: 120 };
    const tightCompiled = compileShot(spec, shot, tight);

    expect(generous.trimmedSections).toHaveLength(0);
    expect(tightCompiled.trimmedSections.length).toBeGreaterThan(0);
    expect(tightCompiled.approxTokens).toBeLessThan(generous.approxTokens);
  });

  it("protects the scene, action and reference instructions from trimming", async () => {
    const spec = await buildSpec();
    const shot = spec.shots[0];
    const original = buildBlueprint(spec, shot);
    const { blueprint } = trimBlueprint(original, 60);

    expect(blueprint.headline).toBe(original.headline);
    expect(blueprint.action).toEqual(original.action);
    expect(blueprint.references).toEqual(original.references);
    // Camera direction is what separates this from a keyword prompt; some of
    // it must always survive.
    expect(blueprint.camera.length).toBeGreaterThan(0);
  });

  it("reports what it dropped rather than truncating silently", async () => {
    const spec = await buildSpec();
    const compiled = compileShot(spec, spec.shots[0], { ...CAPS, maxPromptTokens: 150 });
    expect(compiled.trimmedSections.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
  });
});
