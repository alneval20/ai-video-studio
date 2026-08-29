import { describe, expect, it } from "vitest";
import { buildConsistencyContract, seedForShot } from "@/lib/consistency/consistency-engine";
import type { ReferenceDirective, SceneSubject } from "@/lib/spec/spec";

const subjects: SceneSubject[] = [
  {
    key: "latte",
    kind: "beverage",
    label: "Latte",
    description: "an iced latte",
    hero: true,
    identityNotes: ["layered espresso over milk"],
  },
  {
    key: "person",
    kind: "human",
    label: "Person",
    description: "a young woman",
    hero: false,
    identityNotes: [],
  },
];

const shots = [
  { id: "shot_a", featuredSubjectKeys: ["latte"] },
  { id: "shot_b", featuredSubjectKeys: ["latte", "person"] },
];

const productRef: ReferenceDirective = {
  referenceId: "ref_1",
  label: "cup.png",
  role: "product",
  usage: "identity",
  adherence: "strict",
  weight: 1,
  shotIds: null,
  preserve: ["silhouette"],
  notes: "",
};

function contract(overrides: Partial<Parameters<typeof buildConsistencyContract>[0]> = {}) {
  return buildConsistencyContract({
    subjects,
    shots,
    references: [],
    strength: 0.8,
    seedSource: "project:prompt",
    multiShot: true,
    ...overrides,
  });
}

describe("buildConsistencyContract", () => {
  it("locks attributes appropriate to each subject kind", () => {
    const c = contract();
    const latte = c.entities.find((e) => e.key === "latte")!;
    const person = c.entities.find((e) => e.key === "person")!;

    expect(latte.lockedAttributes.join(" ")).toContain("vessel geometry");
    expect(person.lockedAttributes.join(" ")).toContain("facial features");
    // A beverage must not be given facial locks.
    expect(latte.lockedAttributes.join(" ")).not.toContain("facial");
  });

  it("carries the director's identity notes into the locks", () => {
    const latte = contract().entities.find((e) => e.key === "latte")!;
    expect(latte.lockedAttributes).toContain("layered espresso over milk");
  });

  it("anchors a subject to a matching reference", () => {
    const c = contract({ references: [productRef] });
    const latte = c.entities.find((e) => e.key === "latte")!;
    expect(latte.anchorReferenceIds).toContain("ref_1");
    // A product reference must not anchor the human.
    expect(c.entities.find((e) => e.key === "person")!.anchorReferenceIds).toHaveLength(0);
  });

  it("disables cross-shot locks for a single-shot video", () => {
    const c = contract({ multiShot: false });
    expect(c.crossShot.lighting).toBe("off");
    expect(c.crossShot.wardrobe).toBe("off");
  });

  it("omits wardrobe continuity when there are no people", () => {
    const c = buildConsistencyContract({
      subjects: [subjects[0]],
      shots,
      references: [],
      strength: 0.9,
      seedSource: "x",
      multiShot: true,
    });
    expect(c.crossShot.wardrobe).toBe("off");
  });

  it("relaxes everything when strength is near zero", () => {
    const c = contract({ strength: 0.05 });
    expect(c.entities.every((e) => e.adherence === "off")).toBe(true);
    expect(c.seedPolicy).toBe("random");
  });

  it("shares a seed across shots at high strength", () => {
    expect(contract({ strength: 0.9 }).seedPolicy).toBe("shared");
    expect(contract({ strength: 0.5 }).seedPolicy).toBe("per_shot");
  });

  it("is deterministic for the same seed source", () => {
    expect(contract().baseSeed).toBe(contract().baseSeed);
    expect(contract({ seedSource: "other" }).baseSeed).not.toBe(contract().baseSeed);
  });

  it("honours an explicit seed override", () => {
    expect(contract({ seedOverride: 4242 }).baseSeed).toBe(4242);
  });
});

describe("seedForShot", () => {
  it("keeps a shared seed identical across shots but varies it per attempt", () => {
    const c = contract({ strength: 0.9 });
    expect(seedForShot(c, 0, 0)).toBe(seedForShot(c, 1, 0));
    // A repair must not reproduce the identical clip.
    expect(seedForShot(c, 0, 1)).not.toBe(seedForShot(c, 0, 0));
  });

  it("varies per shot under the per-shot policy", () => {
    const c = contract({ strength: 0.5 });
    expect(seedForShot(c, 0, 0)).not.toBe(seedForShot(c, 1, 0));
  });

  it("always produces a sampler-safe positive integer", () => {
    const c = contract();
    for (let i = 0; i < 5; i++) {
      const seed = seedForShot(c, i, i);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2_147_483_647);
    }
  });
});
