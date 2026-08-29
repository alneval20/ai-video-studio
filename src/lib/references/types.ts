import { z } from "zod";
import { ReferenceRole } from "@/lib/spec/vocab";

export const StoredReference = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Original upload filename. */
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().min(0),
  width: z.number().int().min(1).nullable().default(null),
  height: z.number().int().min(1).nullable().default(null),
  role: ReferenceRole,
  /** Whether the role was chosen by the user or inferred by the system. */
  roleSource: z.enum(["user", "inferred"]),
  /** Path on disk, relative to STORAGE_DIR. Never an absolute path in the DB. */
  storagePath: z.string().min(1),
  /** URL the UI can render. Served by the references API route. */
  url: z.string().min(1),
  /** Free-text user note, e.g. "this is the exact cup". */
  notes: z.string().default(""),
  createdAt: z.string().min(1),
});
export type StoredReference = z.infer<typeof StoredReference>;

export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
] as const;

export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024; // 12 MB
export const MAX_REFERENCES_PER_PROJECT = 12;
