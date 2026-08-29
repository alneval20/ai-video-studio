import type { GenerationJob } from "@/lib/jobs/types";
import type { StoredReference } from "@/lib/references/types";
import type { DeliveryFormat, RealismLevel, ReferenceRole } from "@/lib/spec/vocab";

/** Shapes returned by /api/config. Kept explicit so the UI is typed end to end. */
export interface StudioConfig {
  director: { mode: string; model: string; llmAvailable: boolean; note: string };
  providers: Array<{
    id: string;
    label: string;
    description: string;
    kind: string;
    requiresGpu: boolean;
    producesRealVideo: boolean;
    available: boolean;
    detail: string;
    remedy: string | null;
    maxClipSeconds: number;
    maxGenerationEdge: number;
  }>;
  activeProviderId: string;
  brands: Array<{
    id: string;
    name: string;
    description: string;
    builtIn: boolean;
    defaults: { format: DeliveryFormat; durationSec: number; realismLevel: RealismLevel };
  }>;
  cameraPresets: Array<{
    id: string;
    label: string;
    description: string;
    feel: string;
    moveIntensity: number;
  }>;
  archetypes: Array<{ id: string; label: string; description: string }>;
  formats: Array<{
    id: DeliveryFormat;
    label: string;
    aspectRatio: string;
    exportWidth: number;
    exportHeight: number;
    maxDurationSec: number;
  }>;
  realismLevels: readonly RealismLevel[];
  evaluators: Array<{ id: string; label: string; description: string; dimensions: string[] }>;
  analyzers: Array<{
    id: string;
    label: string;
    description: string;
    dimensions: string[];
    requiresModel: string | null;
    available: boolean;
  }>;
  tools: { ffmpeg: boolean; ffprobe: boolean; version: string | null; remedy: string | null };
  maxShots: number;
}

export interface ApiError {
  code: string;
  message: string;
  remedy?: string;
  retryable: boolean;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: ApiError };

async function call<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;

  if (!body) {
    throw Object.assign(new Error(`Request failed (HTTP ${res.status}).`), {
      code: "UNKNOWN",
      retryable: true,
    });
  }
  if (!body.ok) {
    throw Object.assign(new Error(body.error.message), body.error);
  }
  return body.data;
}

export const api = {
  config: () => call<StudioConfig>("/api/config", { cache: "no-store" }),

  uploadReferences: (files: File[], projectId: string | null, roles: Record<number, ReferenceRole>) => {
    const form = new FormData();
    if (projectId) form.set("projectId", projectId);
    files.forEach((file, i) => {
      form.append("files", file);
      const role = roles[i];
      if (role) form.set(`role[${i}]`, role);
    });
    return call<{ projectId: string; references: StoredReference[] }>("/api/references", {
      method: "POST",
      body: form,
    });
  },

  deleteReference: (id: string) =>
    call<{ removed: boolean }>(`/api/references?id=${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Persists a role change. The pipeline reads roles from storage, not from
   *  the client, so this must succeed before Generate is pressed. */
  updateReferenceRole: (id: string, role: ReferenceRole) =>
    call<{ reference: StoredReference }>(`/api/references/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),

  generate: (payload: Record<string, unknown>) =>
    call<{ jobId: string; projectId: string; status: string }>("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),

  job: (id: string) =>
    call<{ job: GenerationJob; running: boolean }>(`/api/jobs/${id}`, { cache: "no-store" }),

  cancel: (id: string) => call<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
};

/** Turns an OUTPUT_DIR-relative path into a URL the browser can load. */
export function mediaUrl(relativePath: string): string {
  return `/api/media/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}
