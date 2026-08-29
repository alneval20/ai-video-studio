import { describe, expect, it } from "vitest";
import { CompositeEvaluator, mergeScores } from "@/lib/quality/composite-evaluator";
import { PriorAnalyzer } from "@/lib/quality/analyzers/prior-analyzer";
import type {
  AnalyzerContribution,
  EvaluationInput,
  QualityAnalyzer,
} from "@/lib/quality/types";
import { evaluationInput } from "./helpers/evaluation-input";

/** A stub analyzer, so merge behaviour can be tested in isolation. */
function stub(
  id: string,
  contribution: Partial<AnalyzerContribution>,
  available = true,
): QualityAnalyzer {
  return {
    id,
    label: id,
    capabilities: { dimensions: [], requiresGpu: false, requiresModel: null, description: id },
    isAvailable: async () => available,
    analyze: async () => ({
      analyzerId: id,
      scores: [],
      issues: [],
      confidence: "low",
      notCheckedNotes: [],
      ...contribution,
    }),
  };
}

describe("mergeScores", () => {
  it("prefers a measured score over an estimate, whatever the order", () => {
    const estimate: AnalyzerContribution = {
      analyzerId: "prior",
      scores: [{ dimension: "temporalConsistency", score: 0.9, measured: false, method: "prior" }],
      issues: [],
      confidence: "low",
      notCheckedNotes: [],
    };
    const measurement: AnalyzerContribution = {
      analyzerId: "real",
      scores: [{ dimension: "temporalConsistency", score: 0.3, measured: true, method: "ffmpeg" }],
      issues: [],
      confidence: "high",
      notCheckedNotes: [],
    };

    for (const order of [[estimate, measurement], [measurement, estimate]]) {
      const merged = mergeScores(order);
      expect(merged).toHaveLength(1);
      expect(merged[0].measured).toBe(true);
      expect(merged[0].score).toBe(0.3);
    }
  });

  it("takes the more pessimistic of two measurements", () => {
    const merged = mergeScores([
      {
        analyzerId: "a",
        scores: [{ dimension: "humanAnatomy", score: 0.9, measured: true, method: "a" }],
        issues: [],
        confidence: "high",
        notCheckedNotes: [],
      },
      {
        analyzerId: "b",
        scores: [{ dimension: "humanAnatomy", score: 0.4, measured: true, method: "b" }],
        issues: [],
        confidence: "high",
        notCheckedNotes: [],
      },
    ]);
    // A defect seen by one technique is still a defect.
    expect(merged[0].score).toBe(0.4);
    expect(merged[0].method).toContain("also assessed");
  });
});

describe("CompositeEvaluator", () => {
  const input: EvaluationInput = evaluationInput("/tmp/does-not-exist.mp4");

  it("skips unavailable analyzers", async () => {
    const evaluator = new CompositeEvaluator([
      stub(
        "off",
        {
          scores: [{ dimension: "cameraQuality", score: 0.01, measured: true, method: "off" }],
        },
        false,
      ),
      new PriorAnalyzer(),
    ]);

    const report = await evaluator.evaluate(input);
    expect(report.scores.find((s) => s.dimension === "cameraQuality")?.score).not.toBe(0.01);
  });

  it("survives an analyzer that throws", async () => {
    const exploding: QualityAnalyzer = {
      id: "boom",
      label: "boom",
      capabilities: { dimensions: [], requiresGpu: false, requiresModel: null, description: "" },
      isAvailable: async () => true,
      analyze: async () => {
        throw new Error("kaboom");
      },
    };

    const evaluator = new CompositeEvaluator([exploding, new PriorAnalyzer()]);
    const report = await evaluator.evaluate(input);
    expect(report.scores.length).toBeGreaterThan(0);
  });

  it("reports low confidence when only priors contributed", async () => {
    const evaluator = new CompositeEvaluator([new PriorAnalyzer()]);
    const report = await evaluator.evaluate(input);

    expect(report.confidence).toBe("low");
    expect(report.scores.every((s) => !s.measured)).toBe(true);
    expect(report.notCheckedNotes.join(" ")).toContain("Estimated rather than observed");
  });

  it("raises confidence when a real measurement survives the merge", async () => {
    const evaluator = new CompositeEvaluator([
      stub("real", {
        scores: [
          { dimension: "temporalConsistency", score: 0.82, measured: true, method: "ffmpeg signal" },
        ],
        confidence: "high",
      }),
      new PriorAnalyzer(),
    ]);

    const report = await evaluator.evaluate(input);
    expect(report.confidence).toBe("high");
    expect(report.scores.find((s) => s.dimension === "temporalConsistency")?.measured).toBe(true);
  });

  it("never gates mock output, but always flags it", async () => {
    const evaluator = new CompositeEvaluator([
      stub("harsh", {
        scores: [{ dimension: "temporalConsistency", score: 0.01, measured: true, method: "x" }],
        issues: [
          {
            code: "severe_flicker",
            dimension: "temporalConsistency",
            severity: "critical",
            message: "broken",
            suggestion: "",
          },
        ],
      }),
    ]);

    const report = await evaluator.evaluate(
      evaluationInput("/tmp/x.mp4", { context: { isRealGeneration: false } }),
    );

    expect(report.passed).toBe(true);
    expect(report.issues[0].code).toBe("mock_output");
  });

  it("fails a real clip with a critical issue regardless of the overall score", async () => {
    const evaluator = new CompositeEvaluator([
      stub("mixed", {
        scores: [
          { dimension: "temporalConsistency", score: 0.95, measured: true, method: "x" },
          { dimension: "subjectConsistency", score: 0.95, measured: true, method: "x" },
          { dimension: "technicalIntegrity", score: 0.95, measured: true, method: "x" },
        ],
        issues: [
          {
            code: "frozen_output",
            dimension: "temporalConsistency",
            severity: "critical",
            message: "frozen",
            suggestion: "",
          },
        ],
      }),
    ]);

    const report = await evaluator.evaluate(input);
    expect(report.overall).toBeGreaterThan(0.9);
    expect(report.passed).toBe(false);
  });

  it("orders issues with critical first", async () => {
    const evaluator = new CompositeEvaluator([
      stub("a", {
        issues: [
          { code: "i1", dimension: "cameraQuality", severity: "info", message: "i", suggestion: "" },
          { code: "c1", dimension: "cameraQuality", severity: "critical", message: "c", suggestion: "" },
          { code: "w1", dimension: "cameraQuality", severity: "warning", message: "w", suggestion: "" },
        ],
      }),
    ]);
    const report = await evaluator.evaluate(input);
    expect(report.issues.map((i) => i.severity)).toEqual(["critical", "warning", "info"]);
  });

  it("deduplicates identical issues from different analyzers", async () => {
    const issue = {
      code: "dup",
      dimension: "temporalConsistency" as const,
      severity: "warning" as const,
      message: "same problem",
      suggestion: "",
    };
    const evaluator = new CompositeEvaluator([
      stub("a", { issues: [issue] }),
      stub("b", { issues: [issue] }),
    ]);
    const report = await evaluator.evaluate(input);
    expect(report.issues.filter((i) => i.code === "dup")).toHaveLength(1);
  });
});
