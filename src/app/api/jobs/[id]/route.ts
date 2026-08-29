import { fail, ok } from "@/lib/api/http";
import { isRunning, reconcileStaleJobs } from "@/lib/jobs/runner";
import { jobs } from "@/lib/storage/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await reconcileStaleJobs();
    const job = await jobs.require(id);
    return ok({ job, running: isRunning(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const removed = await jobs.remove(id);
    return ok({ removed });
  } catch (error) {
    return fail(error);
  }
}
