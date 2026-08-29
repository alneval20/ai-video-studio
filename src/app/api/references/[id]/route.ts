import { z } from "zod";
import { fail, ok } from "@/lib/api/http";
import { StudioError } from "@/lib/core/errors";
import { StoredReference } from "@/lib/references/types";
import { ReferenceRole } from "@/lib/spec/vocab";
import { references } from "@/lib/storage/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z.object({
  role: ReferenceRole.optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Updates a reference's semantic role.
 *
 * This exists because the role is the single most consequential thing about a
 * reference — it decides whether the image conditions the model's identity
 * understanding, its layout, or only its palette. The picker in the UI must
 * therefore write through to storage; the generation pipeline reads roles from
 * the database, so a role held only in React state would be silently discarded
 * at Generate time.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const parsed = Patch.safeParse(await request.json());
    if (!parsed.success) {
      throw new StudioError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid update.");
    }

    const updated = await references.update(id, (current) =>
      StoredReference.parse({
        ...current,
        role: parsed.data.role ?? current.role,
        // An explicit choice is authoritative; it must not be re-inferred later.
        roleSource: parsed.data.role ? "user" : current.roleSource,
        notes: parsed.data.notes ?? current.notes,
      }),
    );

    return ok({ reference: updated });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return ok({ reference: await references.require(id) });
  } catch (error) {
    return fail(error);
  }
}
