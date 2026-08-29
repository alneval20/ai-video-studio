import { describe, expect, it } from "vitest";
import { HeuristicDirector } from "@/lib/director/heuristic-director";
import { DirectorBrief, coerceBriefShape, slugKey } from "@/lib/spec/brief";

describe("coerceBriefShape", () => {
  it("wraps a single subject object into an array", () => {
    const result = coerceBriefShape({
      subjects: { key: "cup", kind: "product", description: "a cup" },
    }) as { subjects: unknown[] };
    expect(Array.isArray(result.subjects)).toBe(true);
  });

  it("derives a missing subject key from the description", () => {
    const result = coerceBriefShape({
      subjects: [{ kind: "product", description: "An Iced Latte!" }],
    }) as { subjects: Array<{ key: string }> };
    expect(result.subjects[0].key).toBe("an_iced_latte");
  });

  it("enforces exactly one hero", () => {
    const result = coerceBriefShape({
      subjects: [
        { key: "a", kind: "product", description: "a", hero: true },
        { key: "b", kind: "human", description: "b", hero: true },
      ],
    }) as { subjects: Array<{ hero: boolean }> };
    expect(result.subjects.filter((s) => s.hero)).toHaveLength(1);
  });

  it("promotes the first subject when the model marked no hero", () => {
    const result = coerceBriefShape({
      subjects: [{ key: "a", kind: "product", description: "a" }],
    }) as { subjects: Array<{ hero: boolean }> };
    expect(result.subjects[0].hero).toBe(true);
  });

  it("drops beat references to subjects that do not exist", () => {
    const result = coerceBriefShape({
      subjects: [{ key: "cup", kind: "product", description: "a cup", hero: true }],
      beats: [{ purpose: "product_hero", action: "x", featured: ["cup", "ghost"] }],
    }) as { beats: Array<{ featured: string[] }> };
    expect(result.beats[0].featured).toEqual(["cup"]);
  });

  it("leaves non-object input alone rather than throwing", () => {
    expect(coerceBriefShape("nonsense")).toBe("nonsense");
    expect(coerceBriefShape(null)).toBeNull();
  });
});

describe("slugKey", () => {
  it("normalises to lower_snake_case", () => {
    expect(slugKey("Iced Latte!")).toBe("iced_latte");
    expect(slugKey("  ")).toBe("subject");
  });
});

describe("HeuristicDirector", () => {
  const director = new HeuristicDirector();
  const base = { brand: null, referenceRoles: [], overrides: {} };

  it("always produces a schema-valid brief", async () => {
    const { brief } = await director.direct({ ...base, prompt: "asdfghjkl" });
    expect(() => DirectorBrief.parse(brief)).not.toThrow();
  });

  it("understands the worked Turkish example from the brief", async () => {
    const { brief } = await director.direct({
      ...base,
      prompt:
        "Cup of Coffee için gece kafede gerçekçi bir video. Masada iced latte var. Bir kız telefonuyla kahveyi çekiyor. Instagram videosu gibi olsun.",
    });

    expect(brief.sourceLanguage).toBe("tr");
    expect(brief.environment.timeOfDay).toBe("night");
    expect(brief.environment.setting.toLowerCase()).toContain("café");
    expect(brief.format).toBe("instagram_reel");

    const kinds = brief.subjects.map((s) => s.kind);
    expect(kinds).toContain("beverage");
    expect(kinds).toContain("human");
    // The drink is the brand hero, not the person filming it.
    expect(brief.subjects.find((s) => s.hero)?.kind).toBe("beverage");
  });

  it("picks the night-cafe archetype from an English prompt", async () => {
    const { brief } = await director.direct({
      ...base,
      prompt: "A cozy night cafe scene with an iced coffee on the table, Instagram reel",
    });
    expect(brief.environment.timeOfDay).toBe("night");
    expect(brief.mood).toBe("cozy");
  });

  it("parses an explicit duration in either language", async () => {
    const en = await director.direct({ ...base, prompt: "Make a 15 second product video" });
    const tr = await director.direct({ ...base, prompt: "15 saniyelik bir ürün videosu" });
    expect(en.brief.targetDurationSec).toBe(15);
    expect(tr.brief.targetDurationSec).toBe(15);
  });

  it("lets UI overrides win over anything it inferred", async () => {
    const { brief } = await director.direct({
      ...base,
      prompt: "A tiktok video at night",
      overrides: { format: "landscape_ad", durationSec: 30, realismLevel: "maximum", shotCount: 2 },
    });
    expect(brief.format).toBe("landscape_ad");
    expect(brief.targetDurationSec).toBe(30);
    expect(brief.realismLevel).toBe("maximum");
    expect(brief.suggestedShotCount).toBe(2);
  });

  it("infers a product subject from an attached product reference", async () => {
    const { brief } = await director.direct({
      ...base,
      prompt: "make something nice",
      referenceRoles: ["product"],
    });
    expect(brief.subjects.some((s) => s.kind === "product")).toBe(true);
  });

  it("warns rather than failing when it recognises nothing", async () => {
    const result = await director.direct({ ...base, prompt: "zzzz qqqq" });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.brief.subjects.length).toBeGreaterThan(0);
  });

  it("is deterministic", async () => {
    const prompt = "An iced latte in a cafe at night, Instagram reel";
    const a = await director.direct({ ...base, prompt });
    const b = await director.direct({ ...base, prompt });
    expect(a.brief).toEqual(b.brief);
  });
});
