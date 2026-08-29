import fs from "node:fs/promises";
import path from "node:path";
import { fail } from "@/lib/api/http";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { references } from "@/lib/storage/repositories";

export const runtime = "nodejs";

/** Serves a stored reference image. Paths come from the DB, never the URL. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const record = await references.require(id);

    const absolute = path.join(getEnv().storageDir, record.storagePath);
    // Defence in depth: the stored path is ours, but confirm it stays in root.
    const root = path.resolve(getEnv().storageDir);
    if (!path.resolve(absolute).startsWith(root)) {
      throw new StudioError("NOT_FOUND", "Reference is outside the storage root.");
    }

    const bytes = await fs.readFile(absolute);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": record.mimeType,
        "cache-control": "private, max-age=3600",
        "content-length": String(bytes.byteLength),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
