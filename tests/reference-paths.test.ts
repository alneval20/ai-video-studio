import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resolveReferencePath } from "@/lib/references/paths";

const originalStorage = process.env.STORAGE_DIR;

afterEach(() => {
  if (originalStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = originalStorage;
  resetEnvCache();
});

describe("reference asset roots", () => {
  it("resolves checked-in public assets from /public", () => {
    expect(resolveReferencePath({ source: "public", storagePath: "logo.png" })).toBe(
      path.resolve("public/logo.png"),
    );
  });

  it("keeps legacy references rooted in STORAGE_DIR", () => {
    process.env.STORAGE_DIR = "./storage-test-root";
    resetEnvCache();
    expect(resolveReferencePath({ storagePath: "references/product.png" })).toBe(
      path.resolve("storage-test-root/references/product.png"),
    );
  });

  it.each([
    { source: "public" as const, storagePath: "../logo.png" },
    { source: "storage" as const, storagePath: "/tmp/image.png" },
  ])("rejects traversal outside the declared root", (reference) => {
    expect(() => resolveReferencePath(reference)).toThrow(/outside its declared asset root/i);
  });
});
