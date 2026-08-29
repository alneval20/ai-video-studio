import { fail, ok } from "@/lib/api/http";
import { cancelJob } from "@/lib/jobs/runner";
import { jobs } from "@/lib/storage/repositories";
import { TERMINAL_JOB_STATUSES } from "@/lib/jobs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const job = await jobs.require(id);

    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      return ok({ cancelled: false, reason: `Job is already ${job.status}.` });
    }

    const cancelled = cancelJob(id);
    await jobs.update(id, (j) => ({
      ...j,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    return ok({ cancelled });
  } catch (error) {
    return fail(error);
  }
}
