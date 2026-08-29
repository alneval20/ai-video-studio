import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TemporalAnalyzer } from "@/lib/quality/analyzers/temporal-analyzer";
import { ReferenceAnalyzer } from "@/lib/quality/analyzers/reference-analyzer";
import { TechnicalAnalyzer } from "@/lib/quality/analyzers/technical-analyzer";
import {
  imageSignature,
  measureTemporalSignal,
  sampleTimestamps,
  signatureSimilarity,
} from "@/lib/quality/frame-analysis";
import {
  cleanupFixtures,
  flickerClip,
  frozenClip,
  fixturesAvailable,
  movingClip,
  productClip,
  productImage,
  unrelatedClip,
} from "./helpers/fixtures";
import { evaluationInput } from "./helpers/evaluation-input";

/**
 * These run against REAL rendered video, not mocks. The whole point of the
 * analyzers is that they measure pixels, so mocking the measurement would
 * verify nothing about whether the thresholds discriminate.
 */

let available = false;

beforeAll(async () => {
  available = await fixturesAvailable();
}, 60_000);

afterAll(async () => {
  await cleanupFixtures();
});

describe("temporal signal", () => {
  it("separates frozen, moving and flickering clips", async () => {
    if (!available) return;

    const [frozen, moving, flicker] = await Promise.all([
      measureTemporalSignal(await frozenClip()),
      measureTemporalSignal(await movingClip()),
      measureTemporalSignal(await flickerClip()),
    ]);

    expect(frozen).not.toBeNull();
    expect(moving).not.toBeNull();
    expect(flicker).not.toBeNull();

    // The ordering is the property that matters — thresholds hang off it.
    expect(frozen!.meanDelta).toBeLessThan(moving!.meanDelta);
    expect(moving!.meanDelta).toBeLessThan(flicker!.meanDelta);

    expect(frozen!.meanDelta).toBeLessThan(0.35);
    expect(flicker!.meanDelta).toBeGreaterThan(45);
  }, 120_000);
});

describe("TemporalAnalyzer", () => {
  const analyzer = new TemporalAnalyzer();

  it("flags a frozen clip as critical", async () => {
    if (!available) return;
    const result = await analyzer.analyze(evaluationInput(await frozenClip()));

    const frozen = result.issues.find((i) => i.code === "frozen_output");
    expect(frozen).toBeDefined();
    expect(frozen!.severity).toBe("critical");

    const temporal = result.scores.find((s) => s.dimension === "temporalConsistency")!;
    expect(temporal.measured).toBe(true);
    expect(temporal.score).toBeLessThan(0.6);
  }, 120_000);

  it("does not flag a deliberately locked-off static shot", async () => {
    if (!available) return;
    // Same pixels, different intent — the spec said hold completely still.
    const result = await analyzer.analyze(
      evaluationInput(await frozenClip(), {
        context: { cameraMoveIntensity: 0.03, subjectMotion: "none" },
      }),
    );
    expect(result.issues.some((i) => i.code === "frozen_output")).toBe(false);
  }, 120_000);

  it("flags severe flicker as critical", async () => {
    if (!available) return;
    const result = await analyzer.analyze(evaluationInput(await flickerClip()));
    const issue = result.issues.find((i) => i.code === "severe_flicker");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("critical");
  }, 120_000);

  it("passes a healthy moving clip", async () => {
    if (!available) return;
    const result = await analyzer.analyze(evaluationInput(await movingClip()));
    const temporal = result.scores.find((s) => s.dimension === "temporalConsistency")!;

    expect(temporal.score).toBeGreaterThan(0.65);
    expect(result.issues.some((i) => i.severity === "critical")).toBe(false);
    expect(result.confidence).toBe("high");
  }, 120_000);

  it("reports every score it emits as genuinely measured", async () => {
    if (!available) return;
    const result = await analyzer.analyze(evaluationInput(await movingClip()));
    expect(result.scores.length).toBeGreaterThan(0);
    expect(result.scores.every((s) => s.measured)).toBe(true);
  }, 120_000);
});

describe("signature similarity", () => {
  it("scores identical images at 1 and unrelated ones near 0", async () => {
    if (!available) return;
    const productPath = await productImage();
    const signature = await imageSignature(productPath);
    expect(signature).not.toBeNull();

    expect(signatureSimilarity(signature!, signature!)).toBeCloseTo(1, 3);

    const inverted = signature!.map((v) => 255 - v);
    expect(signatureSimilarity(signature!, inverted)).toBe(0);
  }, 120_000);
});

describe("ReferenceAnalyzer", () => {
  const analyzer = new ReferenceAnalyzer();

  it("scores a matching clip far above an unrelated one", async () => {
    if (!available) return;
    const reference = await productImage();

    const [match, mismatch] = await Promise.all([
      analyzer.analyze(
        evaluationInput(await productClip(), {
          expected: { durationSec: 2 },
          context: { referencePaths: [reference], hasProduct: true },
        }),
      ),
      analyzer.analyze(
        evaluationInput(await unrelatedClip(), {
          expected: { durationSec: 2 },
          context: { referencePaths: [reference], hasProduct: true },
        }),
      ),
    ]);

    const scoreOf = (r: typeof match) =>
      r.scores.find((s) => s.dimension === "referenceSimilarity")?.score ?? 0;

    expect(scoreOf(match)).toBeGreaterThan(scoreOf(mismatch));
    expect(mismatch.issues.some((i) => i.code === "reference_mismatch")).toBe(true);
    expect(match.issues.some((i) => i.code === "reference_mismatch")).toBe(false);
  }, 180_000);

  it("measures drift with no reference attached", async () => {
    if (!available) return;
    const result = await analyzer.analyze(
      evaluationInput(await productClip(), { expected: { durationSec: 2 } }),
    );

    const subject = result.scores.find((s) => s.dimension === "subjectConsistency");
    expect(subject?.measured).toBe(true);
    // A static product clip should show almost no drift.
    expect(subject!.score).toBeGreaterThan(0.8);
    expect(result.notCheckedNotes.join(" ")).toContain("No identity reference");
  }, 120_000);

  it("is honest that it cannot resolve branding detail", async () => {
    if (!available) return;
    const result = await analyzer.analyze(
      evaluationInput(await productClip(), {
        expected: { durationSec: 2 },
        context: { hasProduct: true },
      }),
    );
    expect(result.notCheckedNotes.join(" ")).toContain("branding");
    expect(result.confidence).toBe("medium");
  }, 120_000);
});

describe("TechnicalAnalyzer", () => {
  const analyzer = new TechnicalAnalyzer();

  it("reports a missing file as critical without throwing", async () => {
    const result = await analyzer.analyze(evaluationInput("/nonexistent/never.mp4"));
    expect(result.issues[0].code).toBe("missing_output");
    expect(result.scores[0].score).toBe(0);
  });

  it("detects a duration mismatch against the request", async () => {
    if (!available) return;
    const result = await analyzer.analyze(
      // The fixture is 3s; claim we asked for 10.
      evaluationInput(await movingClip(), { expected: { durationSec: 10 } }),
    );
    expect(result.issues.some((i) => i.code === "duration_mismatch")).toBe(true);
  }, 120_000);

  it("accepts a clip that matches the request", async () => {
    if (!available) return;
    const result = await analyzer.analyze(
      evaluationInput(await movingClip(), { expected: { durationSec: 3, width: 256, height: 256, fps: 12 } }),
    );
    expect(result.issues.some((i) => i.severity === "critical")).toBe(false);
    expect(result.scores[0].measured).toBe(true);
  }, 120_000);
});

describe("sampleTimestamps", () => {
  it("spreads samples across the clip without hitting the edges", () => {
    const stamps = sampleTimestamps(5, 4);
    expect(stamps).toHaveLength(4);
    expect(stamps[0]).toBeGreaterThan(0);
    expect(stamps[stamps.length - 1]).toBeLessThan(5);
    // strictly increasing
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  });

  it("returns the midpoint for a single sample", () => {
    expect(sampleTimestamps(4, 1)).toEqual([2]);
  });
});
