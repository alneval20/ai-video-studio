import path from "node:path";
import { describe, expect, it } from "vitest";
import { linkedSignal, sleep } from "@/lib/core/abort";
import { sniffImageType } from "@/lib/references/sniff";
import { escapeDrawText, wrapText } from "@/lib/compose/drawtext";
import { safeSegment } from "@/lib/storage/paths";
import { computeProgress, TERMINAL_JOB_STATUSES } from "@/lib/jobs/types";
import type { GenerationJob } from "@/lib/jobs/types";

/** Regression tests for the production-hardening pass. */

describe("upload sniffing", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

  it("identifies real image bytes", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");

    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageType(webp)).toBe("image/webp");

    const avif = new Uint8Array(16);
    avif.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    avif.set([0x61, 0x76, 0x69, 0x66], 8); // "avif"
    expect(sniffImageType(avif)).toBe("image/avif");
  });

  it("rejects a non-image however it is labelled", () => {
    // A shell script or HTML page with a declared image/png content type.
    const script = new TextEncoder().encode("#!/bin/sh\nrm -rf /\n");
    expect(sniffImageType(script)).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html></html>"))).toBeNull();
  });

  it("rejects truncated data that only starts to look like an image", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe("path safety", () => {
  const root = "/srv/storage";

  /** The invariant that actually matters: a segment can never escape its root. */
  function staysInside(raw: string): boolean {
    const resolved = path.resolve(root, safeSegment(raw));
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  it("keeps every hostile segment inside the root", () => {
    for (const evil of [
      "../../etc/passwd",
      "..",
      "../..",
      "....//....//etc",
      "/etc/passwd",
      "..\\..\\windows",
      "%2e%2e%2f",
    ]) {
      expect(staysInside(evil), `"${evil}" escaped`).toBe(true);
    }
  });

  it("strips traversal syntax outright", () => {
    expect(safeSegment("../../etc/passwd")).not.toContain("..");
    expect(safeSegment("../../etc/passwd")).not.toContain("/");
  });

  it("strips separators and shell metacharacters", () => {
    for (const evil of ["a/b", "a\\b", "a;rm -rf b", "a$(whoami)", "a\0b"]) {
      const safe = safeSegment(evil);
      expect(safe).not.toMatch(/[/\\;$()\0]/);
    }
  });

  it("keeps ordinary ids intact", () => {
    expect(safeSegment("job_c3ff4ec3f668")).toBe("job_c3ff4ec3f668");
  });

  it("refuses an empty segment", () => {
    expect(() => safeSegment("")).toThrow();
  });

  it("sanitises a separator-only segment to something inert", () => {
    const safe = safeSegment("///");
    expect(safe).not.toContain("/");
    expect(staysInside("///")).toBe(true);
  });
});

describe("drawtext escaping", () => {
  it("neutralises filter-graph metacharacters", () => {
    // Prompt and caption text reaches a filter string; an unescaped colon,
    // comma or bracket would break or redirect the graph.
    const escaped = escapeDrawText("a:b,c[d]e;f%g'h");
    expect(escaped).not.toMatch(/(?<!\\)[:,%]/);
    expect(escaped).not.toContain("[");
    expect(escaped).not.toContain("]");
    expect(escaped).not.toContain("'");
  });

  it("collapses newlines that would terminate the filter", () => {
    expect(escapeDrawText("line one\nline two")).not.toContain("\n");
  });

  it("escapes backslashes before anything else", () => {
    expect(escapeDrawText("a\\b")).toBe("a\\\\b");
  });

  it("wraps text without losing words", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
    expect(lines.join(" ").split(/\s+/)).toEqual(
      "the quick brown fox jumps over the lazy dog".split(" "),
    );
    expect(lines.every((l) => l.length <= 20)).toBe(true);
  });
});

describe("abort linkage", () => {
  it("aborts when the caller's signal aborts, before the timeout", async () => {
    const controller = new AbortController();
    const signal = linkedSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("still aborts on timeout with no caller signal", async () => {
    const signal = linkedSignal(5);
    expect(signal.aborted).toBe(false);
    // Wait for the abort event itself rather than sleeping a guessed interval:
    // a fixed sleep makes this fail under CI load rather than on a real bug.
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(signal.aborted).toBe(true);
  });

  it("interruptible sleep rejects on abort instead of waiting out the interval", async () => {
    const controller = new AbortController();
    // A 10s sleep with a 5s test timeout: if abort did not short-circuit it,
    // this test times out. That is the assertion — no wall-clock comparison,
    // which would be load-sensitive and flaky.
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("sleep rejects synchronously when already aborted", async () => {
    await expect(sleep(10, AbortSignal.abort())).rejects.toThrow();
  });
});

describe("job state machine", () => {
  function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
    return {
      id: "job_1",
      projectId: "prj_1",
      status: "generating",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      request: {
        prompt: "x",
        brandProfileId: null,
        format: null,
        durationSec: null,
        realismLevel: null,
        referenceIds: [],
        providerId: null,
        advanced: {
          cameraPresetId: null,
          shotCount: null,
          seed: null,
          consistencyStrength: null,
          referenceStrength: null,
          motionBudget: null,
          negativePrompt: null,
          directorMode: null,
        },
      },
      spec: null,
      compiled: null,
      planNotes: [],
      provider: null,
      shots: [],
      output: null,
      progress: 0,
      logs: [],
      ...overrides,
    };
  }

  it("treats cancelled as terminal", () => {
    expect(TERMINAL_JOB_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_JOB_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_JOB_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_JOB_STATUSES.has("generating")).toBe(false);
  });

  it("never reports full progress before completion", () => {
    const generating = computeProgress(
      job({
        status: "generating",
        shots: [
          { shotId: "a", index: 0, title: "a", status: "completed", progress: 1, durationSec: 3, attempts: [], outputPath: "a.mp4", quality: null },
        ],
      }),
    );
    expect(generating).toBeLessThan(1);
    expect(computeProgress(job({ status: "completed" }))).toBe(1);
  });

  it("progress rises monotonically with completed shots", () => {
    const shot = (status: "pending" | "completed") => ({
      shotId: Math.random().toString(),
      index: 0,
      title: "s",
      status,
      progress: status === "completed" ? 1 : 0,
      durationSec: 3,
      attempts: [],
      outputPath: null,
      quality: null,
    });

    const none = computeProgress(job({ shots: [shot("pending"), shot("pending")] }));
    const half = computeProgress(job({ shots: [shot("completed"), shot("pending")] }));
    const all = computeProgress(job({ shots: [shot("completed"), shot("completed")] }));

    expect(none).toBeLessThan(half);
    expect(half).toBeLessThan(all);
  });
});
