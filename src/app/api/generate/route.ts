import { z } from "zod";
import { fail, ok } from "@/lib/api/http";
import { StudioError } from "@/lib/core/errors";
import { ID } from "@/lib/core/ids";
import { normaliseRequest, startJob } from "@/lib/jobs/runner";
import { DeliveryFormat, RealismLevel } from "@/lib/spec/vocab";
import { projects } from "@/lib/storage/repositories";

export const runtime = "nodejs";
/** Generation touches the filesystem and spawns work; never cache it. */
export const dynamic = "force-dynamic";

const Body = z.object({
  prompt: z.string().trim().min(3, "Describe the video you want in a few words.").max(4000),
  projectId: z.string().optional(),
  brandProfileId: z.string().nullable().optional(),
  format: DeliveryFormat.nullable().optional(),
  durationSec: z.number().min(2).max(60).nullable().optional(),
  realismLevel: RealismLevel.nullable().optional(),
  referenceIds: z.array(z.string()).max(12).default([]),
  providerId: z.string().nullable().optional(),
  advanced: z
    .object({
      cameraPresetId: z.string().nullable().optional(),
      shotCount: z.number().int().min(1).max(6).nullable().optional(),
      seed: z.number().int().min(0).nullable().optional(),
      consistencyStrength: z.number().min(0).max(1).nullable().optional(),
      referenceStrength: z.number().min(0).max(1).nullable().optional(),
      motionBudget: z.number().min(0).max(1).nullable().optional(),
      negativePrompt: z.string().max(2000).nullable().optional(),
      directorMode: z.enum(["auto", "llm", "heuristic"]).nullable().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      throw new StudioError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid request.", {
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const projectId = await resolveProject(body.projectId, body.prompt, body.brandProfileId ?? null);

    const job = await startJob(
      projectId,
      normaliseRequest({
        prompt: body.prompt,
        brandProfileId: body.brandProfileId ?? null,
        format: body.format ?? null,
        durationSec: body.durationSec ?? null,
        realismLevel: body.realismLevel ?? null,
        referenceIds: body.referenceIds,
        providerId: body.providerId ?? undefined,
        advanced: {
          cameraPresetId: body.advanced?.cameraPresetId ?? null,
          shotCount: body.advanced?.shotCount ?? null,
          seed: body.advanced?.seed ?? null,
          consistencyStrength: body.advanced?.consistencyStrength ?? null,
          referenceStrength: body.advanced?.referenceStrength ?? null,
          motionBudget: body.advanced?.motionBudget ?? null,
          negativePrompt: body.advanced?.negativePrompt ?? null,
          directorMode: body.advanced?.directorMode ?? null,
        },
      }),
    );

    return ok({ jobId: job.id, projectId, status: job.status });
  } catch (error) {
    return fail(error);
  }
}

/** Reuses the given project, or creates one named after the prompt. */
async function resolveProject(
  projectId: string | undefined,
  prompt: string,
  brandProfileId: string | null,
): Promise<string> {
  const now = new Date().toISOString();

  if (projectId) {
    const existing = await projects.find(projectId);
    if (existing) {
      await projects.update(projectId, (p) => ({
        ...p,
        updatedAt: now,
        lastPrompt: prompt,
        brandProfileId,
      }));
      return projectId;
    }
  }

  const created = await projects.insert({
    id: projectId ?? ID.project(),
    name: prompt.slice(0, 60) + (prompt.length > 60 ? "…" : ""),
    createdAt: now,
    updatedAt: now,
    lastPrompt: prompt,
    brandProfileId,
  });
  return created.id;
}
