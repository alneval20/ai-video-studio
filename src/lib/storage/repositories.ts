import type { BrandProfile } from "@/lib/brands/types";
import type { GenerationJob } from "@/lib/jobs/types";
import type { StoredReference } from "@/lib/references/types";
import { Collection } from "./json-store";

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The most recent prompt, so returning to a project restores context. */
  lastPrompt: string;
  brandProfileId: string | null;
}

/**
 * The persistence surface. Everything the app stores goes through these four
 * collections; nothing else touches the JSON store directly.
 */
export const projects = new Collection<Project>("projects");
export const references = new Collection<StoredReference>("references");
export const jobs = new Collection<GenerationJob>("jobs");
/** User-defined brand profiles. Built-ins live in code and are merged on read. */
export const customBrands = new Collection<BrandProfile>("brands");
