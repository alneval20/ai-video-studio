import { fail, ok } from "@/lib/api/http";
import { listBrands } from "@/lib/brands";
import { listCameraPresets } from "@/lib/camera/presets";
import { checkTools } from "@/lib/compose/ffmpeg";
import { getEnv } from "@/lib/config/env";
import { providerStatuses } from "@/lib/providers/registry";
import { listAnalyzers, listEvaluators } from "@/lib/quality";
import { listArchetypes } from "@/lib/social/aesthetics";
import { DELIVERY_FORMATS, FORMAT_DEFAULTS, REALISM_LEVELS } from "@/lib/spec/vocab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the UI needs to render its controls and tell the user honestly
 * what this installation can currently do.
 */
export async function GET() {
  try {
    const env = getEnv();
    const [brands, providers, tools] = await Promise.all([
      listBrands(),
      providerStatuses(),
      checkTools(true),
    ]);

    return ok({
      director: {
        mode: env.DIRECTOR_MODE,
        model: env.DIRECTOR_MODEL,
        llmAvailable: env.hasDirectorKey,
        note: env.hasDirectorKey
          ? `Using the LLM director (${env.DIRECTOR_MODEL}).`
          : "No ANTHROPIC_API_KEY set — using the offline heuristic director. It works, but it cannot infer as much nuance from your prompt.",
      },
      providers: providers.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.capabilities.description,
        kind: p.capabilities.kind,
        requiresGpu: p.capabilities.requiresGpu,
        producesRealVideo: p.capabilities.producesRealVideo,
        available: p.health.available,
        detail: p.health.detail,
        remedy: p.health.remedy ?? null,
        maxClipSeconds: p.capabilities.maxClipSeconds,
        maxGenerationEdge: p.capabilities.maxGenerationEdge,
      })),
      activeProviderId: env.VIDEO_PROVIDER,
      brands: brands.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        builtIn: b.builtIn,
        defaults: b.defaults,
      })),
      cameraPresets: listCameraPresets().map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        feel: p.feel,
        moveIntensity: p.moveIntensity,
      })),
      archetypes: listArchetypes().map((a) => ({ id: a.id, label: a.label, description: a.description })),
      formats: DELIVERY_FORMATS.map((f) => ({
        id: f,
        label: f.replace(/_/g, " "),
        ...FORMAT_DEFAULTS[f],
      })),
      realismLevels: REALISM_LEVELS,
      evaluators: listEvaluators().map((e) => ({
        id: e.id,
        label: e.label,
        description: e.capabilities.description,
        dimensions: e.capabilities.dimensions,
      })),
      // Which measurement techniques this installation can actually run, and
      // what each one needs. This is how the user learns that installing a key
      // or FFmpeg upgrades quality control from estimates to measurements.
      analyzers: listAnalyzers().map((a) => ({
        id: a.id,
        label: a.label,
        description: a.capabilities.description,
        dimensions: a.capabilities.dimensions,
        requiresModel: a.capabilities.requiresModel,
        available:
          a.id === "vision-judge"
            ? env.hasDirectorKey && tools.ffmpeg
            : a.id === "risk-prior"
              ? true
              : a.id === "technical"
                ? true
                : tools.ffmpeg,
      })),
      tools: {
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        version: tools.version,
        remedy: tools.remedy ?? null,
      },
      maxShots: env.MAX_SHOTS,
    });
  } catch (error) {
    return fail(error);
  }
}
