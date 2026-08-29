import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TypeScript ↔ Python contract test.
 *
 * The remote-worker adapter and the FastAPI worker exchange JSON over HTTP with
 * no shared type system, so a field renamed on one side is invisible to the
 * other's compiler and fails only at runtime — on a GPU host, mid-generation.
 *
 * These tests read both sources and assert they still agree. They are
 * deliberately source-text based so they run with no Python interpreter, no
 * torch, and no GPU.
 */

const root = path.resolve(__dirname, "..");
const schemasPy = fs.readFileSync(path.join(root, "worker/app/schemas.py"), "utf8");
const mainPy = fs.readFileSync(path.join(root, "worker/app/main.py"), "utf8");
const adapterTs = fs.readFileSync(
  path.join(root, "src/lib/providers/remote-worker/remote-worker-provider.ts"),
  "utf8",
);

/** String values of a Python `str, Enum` class. */
function pythonEnumValues(source: string, className: string): string[] {
  const start = source.indexOf(`class ${className}(`);
  if (start === -1) throw new Error(`No Python enum ${className}`);

  const after = source.slice(start);
  const end = after.indexOf("\nclass ");
  const body = end === -1 ? after : after.slice(0, end);

  return [...body.matchAll(/^\s{4}[A-Z_]+ = "([a-z_]+)"$/gm)].map((m) => m[1]);
}

/** Field names declared on a pydantic model class. */
function pythonFields(source: string, className: string): Set<string> {
  const start = source.indexOf(`class ${className}(`);
  if (start === -1) throw new Error(`No Python class ${className}`);

  const after = source.slice(start);
  const end = after.indexOf("\nclass ");
  const body = end === -1 ? after : after.slice(0, end);

  const fields = new Set<string>();
  for (const match of body.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)) {
    fields.add(match[1]);
  }
  return fields;
}

describe("GenerationRequest: TypeScript sends what Python requires", () => {
  const required = pythonFields(schemasPy, "GenerationRequest");

  it("declares the fields the adapter builds", () => {
    // Sanity: the parser found a real model, not an empty set.
    expect(required.size).toBeGreaterThan(10);
  });

  it.each([...pythonFields(schemasPy, "GenerationRequest")])(
    "adapter sets `%s`",
    (field) => {
      // The adapter builds the payload as an object literal with snake_case keys.
      expect(adapterTs).toMatch(new RegExp(`\\b${field}\\s*:`));
    },
  );

  it("sends guidance under the exact nested keys Python expects", () => {
    for (const field of pythonFields(schemasPy, "Guidance")) {
      expect(adapterTs).toMatch(new RegExp(`\\b${field}\\s*:`));
    }
  });

  it("sends reference images with the fields Python declares", () => {
    for (const field of pythonFields(schemasPy, "ReferenceImage")) {
      expect(adapterTs).toMatch(new RegExp(`\\b${field}\\s*:`));
    }
  });
});

describe("JobState: TypeScript reads what Python returns", () => {
  const returned = pythonFields(schemasPy, "JobState");

  it("mirrors every JobState field in the adapter's result interface", () => {
    const interfaceStart = adapterTs.indexOf("interface WorkerJobResult");
    expect(interfaceStart).toBeGreaterThan(-1);
    const body = adapterTs.slice(interfaceStart, adapterTs.indexOf("}", interfaceStart));

    for (const field of returned) {
      expect(body, `WorkerJobResult is missing "${field}"`).toContain(field);
    }
  });

  it("agrees on the set of job statuses", () => {
    const pythonStatuses = /JobStatus = Literal\[([^\]]+)\]/
      .exec(schemasPy)?.[1]
      .match(/"([a-z_]+)"/g)
      ?.map((s) => s.replaceAll('"', ""));

    expect(pythonStatuses).toBeDefined();
    for (const status of pythonStatuses!) {
      expect(adapterTs, `adapter does not handle status "${status}"`).toContain(`"${status}"`);
    }
  });

  it("agrees on the set of error codes", () => {
    // Scope to the ErrorCode class body — the file declares other enums too.
    const codes = pythonEnumValues(schemasPy, "ErrorCode");
    expect(codes.length).toBeGreaterThanOrEqual(6);

    for (const code of codes) {
      expect(adapterTs, `adapter does not map error code "${code}"`).toContain(`"${code}"`);
    }
  });

  it("marks the same failures retryable on both sides", () => {
    // Python's RETRYABLE_CODES drives the worker's own reporting; the adapter
    // must not contradict it by treating a permanent failure as retryable.
    expect(schemasPy).toContain("ErrorCode.OOM");
    expect(schemasPy).toContain("ErrorCode.TIMEOUT");
    expect(adapterTs).toContain('case "oom"');
    expect(adapterTs).toContain('case "timeout"');
    expect(adapterTs).toContain('case "model_unavailable"');
  });
});

describe("shared vocabularies match", () => {
  const vocabTs = fs.readFileSync(path.join(root, "src/lib/spec/vocab.ts"), "utf8");

  it("ReferenceUsage is identical on both sides", () => {
    const python = pythonEnumValues(schemasPy, "ReferenceUsage").sort();

    const tsBlock = /export const REFERENCE_USAGE = \[([\s\S]*?)\] as const;/.exec(vocabTs)?.[1];
    expect(tsBlock).toBeDefined();
    const typescript = [...tsBlock!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

    // A usage present on one side only would be silently dropped in transit.
    expect(typescript).toEqual(python);
  });
});

describe("endpoints match", () => {
  const pythonRoutes = [...mainPy.matchAll(/@app\.(get|post)\(\s*"([^"]+)"/g)].map((m) => ({
    method: m[1],
    route: m[2],
  }));

  it("exposes the routes the adapter calls", () => {
    const routes = pythonRoutes.map((r) => r.route);
    expect(routes).toContain("/health");
    expect(routes).toContain("/jobs");
    expect(routes).toContain("/jobs/{job_id}");
    expect(routes).toContain("/jobs/{job_id}/artifact");
    expect(routes).toContain("/jobs/{job_id}/cancel");
  });

  it("has a readiness probe distinct from liveness", () => {
    expect(pythonRoutes.map((r) => r.route)).toContain("/ready");
  });

  it("adapter targets each of those paths", () => {
    expect(adapterTs).toContain("/health");
    expect(adapterTs).toContain("/jobs");
    expect(adapterTs).toContain("/artifact");
    expect(adapterTs).toContain("/cancel");
  });

  it("authenticates every job route but leaves liveness open", () => {
    // /health must stay unauthenticated so an orchestrator can probe it.
    const healthBlock = mainPy.slice(mainPy.indexOf('@app.get("/health"'));
    const healthDecorator = healthBlock.slice(0, healthBlock.indexOf("\n"));
    expect(healthDecorator).not.toContain("require_auth");

    for (const marker of ['@app.post("/jobs"', '@app.get("/jobs/{job_id}"']) {
      const block = mainPy.slice(mainPy.indexOf(marker));
      expect(block.slice(0, block.indexOf(")\n"))).toContain("require_auth");
    }
  });
});

describe("worker safety invariants", () => {
  const pipelinePy = fs.readFileSync(path.join(root, "worker/app/pipeline.py"), "utf8");
  const jobsPy = fs.readFileSync(path.join(root, "worker/app/jobs.py"), "utf8");

  it("serialises inference — diffusers pipelines are not thread-safe", () => {
    expect(pipelinePy).toContain("_inference_lock");
    expect(pipelinePy).toContain("with self._inference_lock");
  });

  it("guards model loading against a concurrent double load", () => {
    expect(pipelinePy).toContain("_load_lock");
  });

  it("handles CUDA OOM explicitly and reclaims VRAM", () => {
    expect(pipelinePy).toContain("_is_oom");
    expect(pipelinePy).toContain("empty_cache");
    expect(pipelinePy).toContain("OutOfMemory");
  });

  it("enforces cancellation and a deadline inside the diffusion loop", () => {
    expect(pipelinePy).toContain("callback_on_step_end");
    expect(pipelinePy).toContain("_check_interrupts");
  });

  it("writes artifacts atomically", () => {
    expect(pipelinePy).toContain(".part");
    expect(pipelinePy).toContain("replace(output_path)");
  });

  it("bounds the job registry", () => {
    expect(jobsPy).toContain("max_tracked_jobs");
    expect(jobsPy).toContain("_evict_locked");
  });

  it("uses a constant-time token comparison", () => {
    expect(mainPy).toContain("compare_digest");
  });
});
