import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fail } from "@/lib/api/http";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves generated media out of OUTPUT_DIR.
 *
 * The path comes from the URL, so it is untrusted: it is resolved and then
 * checked to be inside the output root before anything is read.
 */
export async function GET(request: Request, context: { params: Promise<{ segments: string[] }> }) {
  try {
    const { segments } = await context.params;
    const root = path.resolve(getEnv().outputDir);
    const absolute = path.resolve(root, ...segments.map(decodeURIComponent));

    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new StudioError("NOT_FOUND", "Refusing to serve a file outside the output directory.");
    }

    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat?.isFile()) {
      throw new StudioError("NOT_FOUND", "No such media file.");
    }

    const ext = path.extname(absolute).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const range = request.headers.get("range");

    // Range support so <video> can seek without downloading the whole clip.
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : stat.size - 1;

      if (start >= stat.size || end >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}` },
        });
      }

      const stream = Readable.toWeb(
        fs.createReadStream(absolute, { start, end }),
      ) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "content-type": contentType,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
        },
      });
    }

    const stream = Readable.toWeb(fs.createReadStream(absolute)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type": contentType,
        "content-length": String(stat.size),
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=600",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
