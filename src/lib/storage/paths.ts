import fs from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";

/**
 * All filesystem layout lives here. Nothing else joins paths, so moving to
 * object storage later means replacing this module rather than grepping.
 *
 *   storage/
 *     db/<collection>.json
 *     references/<projectId>/<referenceId>.<ext>
 *   outputs/
 *     <projectId>/<generationId>/<shotId>-a<attempt>.mp4
 *     <projectId>/<generationId>/final.mp4
 */

export function dbDir(): string {
  return path.join(getEnv().storageDir, "db");
}

export function dbFile(collection: string): string {
  return path.join(dbDir(), `${safeSegment(collection)}.json`);
}

export function referencesDir(projectId: string): string {
  return path.join(getEnv().storageDir, "references", safeSegment(projectId));
}

export function referencePath(projectId: string, referenceId: string, ext: string): string {
  return path.join(referencesDir(projectId), `${safeSegment(referenceId)}${normaliseExt(ext)}`);
}

export function generationDir(projectId: string, generationId: string): string {
  return path.join(getEnv().outputDir, safeSegment(projectId), safeSegment(generationId));
}

export function shotOutputPath(
  projectId: string,
  generationId: string,
  shotId: string,
  attempt: number,
): string {
  return path.join(
    generationDir(projectId, generationId),
    `${safeSegment(shotId)}-a${attempt}.mp4`,
  );
}

export function finalOutputPath(projectId: string, generationId: string): string {
  return path.join(generationDir(projectId, generationId), "final.mp4");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guards every path segment we build from user or model input. Ids are
 * generated internally, but reference filenames are not — and a `../` in an
 * upload name must never escape the storage root.
 */
export function safeSegment(segment: string): string {
  const cleaned = segment
    // Anything that is not a safe filename character — including every path
    // separator, so the result can never escape its parent directory.
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    // Collapse dot runs. Separators are already gone so `..` cannot traverse,
    // but flattening them keeps the invariant obvious rather than incidental.
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_");

  if (!cleaned) {
    throw new StudioError("INVALID_INPUT", `Refusing to build a path from "${segment}".`);
  }
  return cleaned;
}

function normaliseExt(ext: string): string {
  if (!ext) return "";
  const cleaned = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return cleaned ? `.${cleaned}` : "";
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? "bin";
}

/** Converts an absolute storage path into something safe to expose over HTTP. */
export function toRelative(absolute: string): string {
  const env = getEnv();
  for (const root of [env.storageDir, env.outputDir]) {
    const rel = path.relative(root, absolute);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return path.basename(absolute);
}
