import { describe, expect, it } from "vitest";
import {
  hasIdentityReference,
  inferReferenceRole,
  resolveReferences,
} from "@/lib/references/reference-manager";
import type { StoredReference } from "@/lib/references/types";
import type { SceneSubject } from "@/lib/spec/spec";
import type { ReferenceRole } from "@/lib/spec/vocab";

function stored(id: string, role: ReferenceRole, filename = `${id}.png`): StoredReference {
  return {
    id,
    projectId: "prj_test",
    filename,
    mimeType: "image/png",
    bytes: 1000,
    width: null,
    height: null,
    role,
    roleSource: "user",
    storagePath: `references/prj_test/${id}.png`,
    url: `/api/references/${id}/file`,
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

const subjects: SceneSubject[] = [
  { key: "cup", kind: "product", label: "Cup", description: "a cup", hero: true, identityNotes: [] },
  { key: "person", kind: "human", label: "Person", description: "a woman", hero: false, identityNotes: [] },
];

const shots = [
  { id: "s1", featuredSubjectKeys: ["cup"], index: 0 },
  { id: "s2", featuredSubjectKeys: ["person", "cup"], index: 1 },
];

const allUsages = ["init_frame", "identity", "style", "layout", "descriptive_only"] as const;

function resolve(refs: StoredReference[], overrides: Partial<Parameters<typeof resolveReferences>[0]> = {}) {
  return resolveReferences({
    references: refs,
    subjects,
    shots,
    referenceStrength: 0.8,
    providerSupportsInitFrame: true,
    supportedUsages: [...allUsages],
    ...overrides,
  });
}

describe("inferReferenceRole", () => {
  it("recognises common naming patterns", () => {
    expect(inferReferenceRole("brand-logo.png").role).toBe("logo");
    expect(inferReferenceRole("product_packshot.jpg").role).toBe("product");
    expect(inferReferenceRole("model-portrait.png").role).toBe("character");
    expect(inferReferenceRole("ürün.png").role).toBe("product");
  });

  it("falls back to the harmless style role when unsure", () => {
    const result = inferReferenceRole("IMG_4821.jpg");
    expect(result.role).toBe("style");
    expect(result.confident).toBe(false);
  });
});

describe("resolveReferences", () => {
  it("maps roles onto the right conditioning usage", () => {
    const [product, style] = resolve([stored("r1", "product"), stored("r2", "style")]);
    expect(product.usage).toBe("identity");
    expect(product.adherence).toBe("strict");
    expect(style.usage).toBe("style");
    expect(style.adherence).toBe("light");
  });

  it("scopes a character reference to the shots that actually contain a person", () => {
    const [character] = resolve([stored("r1", "character")]);
    // Only s2 features the person, so the reference must not leak into s1.
    expect(character.shotIds).toEqual(["s2"]);
  });

  it("applies style and environment references to every shot", () => {
    expect(resolve([stored("r1", "style")])[0].shotIds).toBeNull();
    expect(resolve([stored("r2", "environment")])[0].shotIds).toBeNull();
  });

  it("binds an init frame to the opening shot only", () => {
    expect(resolve([stored("r1", "first_frame")])[0].shotIds).toEqual(["s1"]);
  });

  it("degrades an init frame when the provider has no image input", () => {
    const [ref] = resolve([stored("r1", "first_frame")], { providerSupportsInitFrame: false });
    expect(ref.usage).toBe("descriptive_only");
    expect(ref.notes).toContain("described in the prompt");
  });

  it("demotes a second init frame rather than silently dropping it", () => {
    const refs = resolve([stored("r1", "first_frame"), stored("r2", "first_frame")]);
    expect(refs.filter((r) => r.usage === "init_frame")).toHaveLength(1);
    expect(refs.some((r) => r.notes.includes("Demoted"))).toBe(true);
  });

  it("degrades explicitly when the provider cannot honour a usage", () => {
    const [ref] = resolve([stored("r1", "product")], { supportedUsages: ["descriptive_only"] });
    expect(ref.usage).toBe("descriptive_only");
    expect(ref.notes).toContain("does not support");
  });

  it("scales weight with the global reference-strength dial", () => {
    const strong = resolve([stored("r1", "product")], { referenceStrength: 1 })[0];
    const weak = resolve([stored("r1", "product")], { referenceStrength: 0 })[0];
    expect(strong.weight).toBeGreaterThan(weak.weight);
  });

  it("lets a brand profile override role adherence", () => {
    const [ref] = resolve([stored("r1", "logo")], { brandAdherence: { logo: "light" } });
    expect(ref.adherence).toBe("light");
  });

  it("lists what must be preserved from each image", () => {
    expect(resolve([stored("r1", "logo")])[0].preserve).toContain("exact letterforms");
  });
});

describe("hasIdentityReference", () => {
  it("is false when everything degraded to description", () => {
    const refs = resolve([stored("r1", "product")], { supportedUsages: ["descriptive_only"] });
    expect(hasIdentityReference(refs)).toBe(false);
  });

  it("is true when a real identity binding survived", () => {
    expect(hasIdentityReference(resolve([stored("r1", "product")]))).toBe(true);
  });
});
