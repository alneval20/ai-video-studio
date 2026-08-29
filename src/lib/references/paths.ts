import path from "node:path";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import type { StoredReference } from "./types";

/** Resolve a reference against its declared root without permitting traversal. */
export function resolveReferencePath(reference: Pick<StoredReference, "source" | "storagePath">): string {
  const root = path.resolve(reference.source === "public" ? path.join(process.cwd(), "public") : getEnv().storageDir);
  const absolute = path.resolve(root, reference.storagePath);
  const relative = path.relative(root, absolute);

  if (!reference.storagePath || path.isAbsolute(reference.storagePath) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StudioError("NOT_FOUND", "Reference is outside its declared asset root.");
  }

  return absolute;
}
