import { describe, expect, it } from "vitest";
import { buildRealismDirective, resolveEmphasis, strictDomains } from "@/lib/realism/realism-engine";
import type { RealismContext } from "@/lib/realism/realism-engine";

function ctx(overrides: Partial<RealismContext> = {}): RealismContext {
  return {
    level: "high",
    subjectKinds: ["product"],
    hasMotion: false,
    hasIdentityReference: false,
    multiShot: false,
    ...overrides,
  };
}

describe("resolveEmphasis", () => {
  it("escalates hands and anatomy only when people are present", () => {
    const withPeople = resolveEmphasis(ctx({ subjectKinds: ["human", "hands"] }));
    const withoutPeople = resolveEmphasis(ctx({ subjectKinds: ["product"] }));

    expect(withPeople.hands).toBe("strict");
    expect(withPeople.human_anatomy).toBe("strict");
    // A product-only scene must not escalate anatomy domains.
    expect(withoutPeople.hands).not.toBe("strict");
  });

  it("escalates liquid physics for beverages", () => {
    expect(resolveEmphasis(ctx({ subjectKinds: ["beverage"] })).liquid_physics).toBe("strict");
  });

  it("turns everything off at the stylised level", () => {
    const emphasis = resolveEmphasis(ctx({ level: "stylised", subjectKinds: ["human"] }));
    expect(emphasis.camera_optics).toBe("off");
    expect(emphasis.temporal_stability).toBe("off");
  });

  it("lets an explicit override disable a domain the content would have escalated", () => {
    const emphasis = resolveEmphasis(
      ctx({ subjectKinds: ["human"], overrides: { human_anatomy: "off" } }),
    );
    expect(emphasis.human_anatomy).toBe("off");
  });
});

describe("buildRealismDirective", () => {
  it("does not mention hands in a scene with no people", () => {
    const directive = buildRealismDirective(ctx({ subjectKinds: ["product", "beverage"] }));
    const all = [...directive.positives, ...directive.negatives].join(" ").toLowerCase();
    expect(all).not.toContain("finger");
  });

  it("does mention hands when hands are in the shot", () => {
    const directive = buildRealismDirective(ctx({ subjectKinds: ["hands"] }));
    const all = [...directive.positives, ...directive.negatives].join(" ").toLowerCase();
    expect(all).toContain("finger");
  });

  it("adds food realism only for food", () => {
    const food = buildRealismDirective(ctx({ subjectKinds: ["food"] }));
    const product = buildRealismDirective(ctx({ subjectKinds: ["product"] }));
    expect(food.appliedRuleIds).toContain("food.texture");
    expect(product.appliedRuleIds).not.toContain("food.texture");
  });

  it("emits the reference-adherence rule only when an identity reference exists", () => {
    const withRef = buildRealismDirective(ctx({ hasIdentityReference: true }));
    const withoutRef = buildRealismDirective(ctx({ hasIdentityReference: false }));
    expect(withRef.appliedRuleIds).toContain("product.reference");
    expect(withoutRef.appliedRuleIds).not.toContain("product.reference");
  });

  it("emits cross-shot continuity only for multi-shot videos", () => {
    expect(buildRealismDirective(ctx({ multiShot: true })).appliedRuleIds).toContain(
      "temporal.cross_shot",
    );
    expect(buildRealismDirective(ctx({ multiShot: false })).appliedRuleIds).not.toContain(
      "temporal.cross_shot",
    );
  });

  it("respects the prompt budget caps", () => {
    const directive = buildRealismDirective(
      ctx({ level: "maximum", subjectKinds: ["human", "hands", "food", "beverage", "product"], maxPositives: 5, maxNegatives: 4 }),
    );
    expect(directive.positives.length).toBeLessThanOrEqual(5);
    expect(directive.negatives.length).toBeLessThanOrEqual(4);
  });

  it("appends user avoidances to the negatives", () => {
    const directive = buildRealismDirective(ctx({ extraNegatives: ["no visible brand logos"] }));
    expect(directive.negatives).toContain("no visible brand logos");
  });

  it("always constrains camera motion so the model does not fly the camera", () => {
    const directive = buildRealismDirective(ctx());
    expect(directive.appliedRuleIds).toContain("motion.no_camera_stunt");
  });

  it("reports strict domains for the quality engine", () => {
    const directive = buildRealismDirective(ctx({ subjectKinds: ["beverage"] }));
    expect(strictDomains(directive)).toContain("liquid_physics");
  });
});
