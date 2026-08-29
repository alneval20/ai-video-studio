import { createLogger } from "@/lib/core/logger";
import { customBrands } from "@/lib/storage/repositories";
import { BUILT_IN_BRANDS, getBuiltInBrand } from "./profiles";
import { BrandProfile } from "./types";

const log = createLogger("brands");

/** Built-in profiles plus any the user has saved. */
export async function listBrands(): Promise<BrandProfile[]> {
  const custom = await customBrands.all().catch(() => []);
  const customIds = new Set(custom.map((b) => b.id));
  return [...BUILT_IN_BRANDS.filter((b) => !customIds.has(b.id)), ...custom];
}

export async function getBrand(id: string | null | undefined): Promise<BrandProfile | null> {
  if (!id) return null;
  const custom = await customBrands.find(id).catch(() => null);
  if (custom) {
    const parsed = BrandProfile.safeParse(custom);
    if (parsed.success) return parsed.data;
    log.warn("Stored brand profile is invalid; ignoring it.", { id });
  }
  return getBuiltInBrand(id) ?? null;
}

export async function saveBrand(input: unknown): Promise<BrandProfile> {
  const profile = BrandProfile.parse({ ...(input as object), builtIn: false });
  return customBrands.upsert(profile);
}

export { BUILT_IN_BRANDS, getBuiltInBrand };
export * from "./types";
