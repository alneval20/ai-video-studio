import { fail, ok } from "@/lib/api/http";
import { reconcileStaleJobs } from "@/lib/jobs/runner";
import { toSummary } from "@/lib/jobs/types";
import { jobs } from "@/lib/storage/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);

    // Reclaim jobs abandoned by a previous process before reporting state.
    await reconcileStaleJobs();

    const all = await jobs.all();
    const filtered = projectId ? all.filter((j) => j.projectId === projectId) : all;

    // Summaries only — job records carry the full spec and logs.
    const summaries = filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toSummary);

    return ok({ jobs: summaries });
  } catch (error) {
    return fail(error);
  }
}
