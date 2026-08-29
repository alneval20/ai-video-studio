import fs from "node:fs/promises";
import path from "node:path";
import { fail, ok } from "@/lib/api/http";
import { StudioError } from "@/lib/core/errors";
import { ID } from "@/lib/core/ids";
import { createLogger } from "@/lib/core/logger";
import { inferReferenceRole } from "@/lib/references/reference-manager";
import { sniffImageType } from "@/lib/references/sniff";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_REFERENCES_PER_PROJECT,
  MAX_REFERENCE_BYTES,
  StoredReference,
} from "@/lib/references/types";
import { ReferenceRole } from "@/lib/spec/vocab";
import { ensureDir, extForMime, referencePath, referencesDir, toRelative } from "@/lib/storage/paths";
import { projects, references } from "@/lib/storage/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api:references");

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const all = await references.all();
    return ok({ references: projectId ? all.filter((r) => r.projectId === projectId) : all });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Uploads one or more reference images.
 *
 * Roles may be supplied explicitly (`role` or `role[<index>]` fields) or
 * inferred from the filename. Inference is conservative — an unrecognised name
 * becomes `style`, which binds weakly and cannot corrupt a generation.
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      throw new StudioError("INVALID_INPUT", "No files were uploaded.");
    }

    const projectId = String(form.get("projectId") ?? "") || ID.project();
    await ensureProject(projectId);

    const existing = await references.filter((r) => r.projectId === projectId);
    if (existing.length + files.length > MAX_REFERENCES_PER_PROJECT) {
      throw new StudioError(
        "INVALID_INPUT",
        `A project can hold at most ${MAX_REFERENCES_PER_PROJECT} reference images.`,
      );
    }

    await ensureDir(referencesDir(projectId));
    const stored: StoredReference[] = [];

    for (const [index, file] of files.entries()) {
      // Check size before reading the body into memory.
      if (file.size > MAX_REFERENCE_BYTES) {
        throw new StudioError(
          "REFERENCE_INVALID",
          `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`,
        );
      }
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
        throw new StudioError(
          "REFERENCE_INVALID",
          `"${file.name}" is ${file.type || "an unknown type"}. Upload PNG, JPEG, WebP or AVIF.`,
        );
      }

      const bytes = Buffer.from(await file.arrayBuffer());

      // The declared content type is attacker-controlled. Trust the bytes: the
      // sniffed type decides both what we store and the file extension, so a
      // non-image can never be written with an image extension and later handed
      // to FFmpeg.
      const sniffed = sniffImageType(bytes);
      if (!sniffed) {
        throw new StudioError(
          "REFERENCE_INVALID",
          `"${file.name}" is not a valid PNG, JPEG, WebP or AVIF image, whatever its name or content type says.`,
        );
      }
      if (sniffed !== file.type) {
        log.warn("Upload content type did not match its bytes; trusting the bytes.", {
          filename: file.name,
          declared: file.type,
          actual: sniffed,
        });
      }

      const explicit = form.get(`role[${index}]`) ?? (files.length === 1 ? form.get("role") : null);
      const parsedRole = explicit ? ReferenceRole.safeParse(String(explicit)) : null;
      const inferred = inferReferenceRole(file.name);

      const id = ID.reference();
      const absolute = referencePath(projectId, id, extForMime(sniffed));
      await fs.writeFile(absolute, bytes);

      const record: StoredReference = {
        id,
        projectId,
        filename: file.name,
        mimeType: sniffed,
        bytes: file.size,
        width: null,
        height: null,
        role: parsedRole?.success ? parsedRole.data : inferred.role,
        roleSource: parsedRole?.success ? "user" : "inferred",
        storagePath: toRelative(absolute),
        url: `/api/references/${id}/file`,
        notes: String(form.get(`notes[${index}]`) ?? ""),
        createdAt: new Date().toISOString(),
      };

      await references.insert(StoredReference.parse(record));
      stored.push(record);
      log.info("Stored reference.", { id, role: record.role, source: record.roleSource });
    }

    return ok({ projectId, references: stored }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

async function ensureProject(projectId: string): Promise<void> {
  if (await projects.find(projectId)) return;
  const now = new Date().toISOString();
  await projects.insert({
    id: projectId,
    name: "Untitled project",
    createdAt: now,
    updatedAt: now,
    lastPrompt: "",
    brandProfileId: null,
  });
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new StudioError("INVALID_INPUT", "Pass ?id= to delete a reference.");

    const record = await references.find(id);
    if (record) {
      const { getEnv } = await import("@/lib/config/env");
      await fs.unlink(path.join(getEnv().storageDir, record.storagePath)).catch(() => undefined);
      await references.remove(id);
    }
    return ok({ removed: Boolean(record) });
  } catch (error) {
    return fail(error);
  }
}
