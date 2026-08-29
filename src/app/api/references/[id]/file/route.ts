import fs from "node:fs/promises";
import { fail } from "@/lib/api/http";
import { resolveReferencePath } from "@/lib/references/paths";
import { references } from "@/lib/storage/repositories";

export const runtime = "nodejs";

/** Serves a stored reference image. Paths come from the DB, never the URL. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const record = await references.require(id);

    const absolute = resolveReferencePath(record);

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
