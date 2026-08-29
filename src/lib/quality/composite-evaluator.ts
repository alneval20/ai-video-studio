import { ID } from "@/lib/core/ids";
import { createLogger } from "@/lib/core/logger";
import { PriorAnalyzer } from "./analyzers/prior-analyzer";
import { ReferenceAnalyzer } from "./analyzers/reference-analyzer";
import { TechnicalAnalyzer } from "./analyzers/technical-analyzer";
import { TemporalAnalyzer } from "./analyzers/temporal-analyzer";
import { VisionAnalyzer } from "./analyzers/vision-analyzer";
import {
  CONFIDENCE_RANK,
  weightedOverall,
  type AnalyzerContribution,
  type DimensionScore,
  type EvaluationInput,
  type QualityAnalyzer,
  type QualityDimension,
  type QualityEvaluator,
  type QualityIssue,
  type QualityReport,
} from "./types";

const log = createLogger("quality");

/**
 * The evaluator the pipeline actually calls.
 *
 * It runs every analyzer that can run right now and merges their findings.
 * The merge rules are what make the whole thing honest:
 *
 *   1. A MEASURED score always beats an unmeasured one, no matter the order
 *      analyzers ran in.
 *   2. When two analyzers both measured the same dimension, the LOWER score
 *      wins. A defect found by any technique is still a defect — averaging it
 *      away with a technique that could not see it would hide real problems.
 *   3. Confidence is the best confidence among analyzers that actually
 *      measured something.
 *   4. `notCheckedNotes` describes only what genuinely went unmeasured, so the
 *      report never over- or under-claims.
 *
 * Adding a technique means adding an analyzer to this list. Nothing else
 * changes.
 */
export class CompositeEvaluator implements QualityEvaluator {
  readonly id = "composite";
  readonly label = "Composite quality evaluator";

  private readonly analyzers: QualityAnalyzer[];

  constructor(analyzers?: QualityAnalyzer[]) {
    // Order matters only for logging; merge rules are order-independent.
    this.analyzers = analyzers ?? [
      new TechnicalAnalyzer(),
      new TemporalAnalyzer(),
      new ReferenceAnalyzer(),
      new VisionAnalyzer(),
      new PriorAnalyzer(),
    ];
  }

  get capabilities() {
    const dimensions = new Set<QualityDimension>();
    for (const a of this.analyzers) for (const d of a.capabilities.dimensions) dimensions.add(d);
    return {
      dimensions: [...dimensions],
      requiresGpu: false,
      requiresModel: null,
      description: `Runs whichever of ${this.analyzers.length} analyzers are available and merges their findings, preferring real measurements over estimates.`,
    };
  }

  /** Which analyzers would run for this input — surfaced in the API. */
  async availability(input: EvaluationInput): Promise<Array<{ id: string; label: string; available: boolean }>> {
    return Promise.all(
      this.analyzers.map(async (a) => ({
        id: a.id,
        label: a.label,
        available: await a.isAvailable(input).catch(() => false),
      })),
    );
  }

  async evaluate(input: EvaluationInput): Promise<QualityReport> {
    const contributions = await this.gather(input);

    const scores = mergeScores(contributions);
    const issues = mergeIssues(contributions);
    const overall = weightedOverall(scores);

    // Mock output is a placeholder — there is nothing meaningful to score, so
    // it is never gated. It is still flagged so nobody mistakes it for footage.
    if (!input.context.isRealGeneration) {
      issues.unshift({
        code: "mock_output",
        dimension: "technicalIntegrity",
        severity: "warning",
        message:
          "This clip came from the development/mock provider. It is a placeholder, not generated video, so no meaningful quality assessment is possible.",
        suggestion: "Connect a real generation provider to produce assessable footage.",
      });
    }

    const temporal = scoreFor(scores, "temporalConsistency");
    const subject = scoreFor(scores, "subjectConsistency");

    const passed = !input.context.isRealGeneration
      ? true
      : overall >= input.targets.minOverall &&
        temporal >= input.targets.minTemporalConsistency &&
        subject >= input.targets.minSubjectConsistency &&
        !issues.some((i) => i.severity === "critical");

    const measuredCount = scores.filter((s) => s.measured).length;
    log.debug("Evaluation complete.", {
      shotId: input.shotId,
      overall,
      passed,
      measured: `${measuredCount}/${scores.length}`,
      analyzers: contributions.map((c) => c.analyzerId),
    });

    return {
      id: ID.qualityReport(),
      shotId: input.shotId,
      attempt: input.attempt,
      evaluatorId: this.id,
      evaluatedAt: new Date().toISOString(),
      overall,
      scores,
      issues,
      passed,
      confidence: mergeConfidence(contributions, scores),
      notCheckedNotes: mergeNotes(contributions, scores),
    };
  }

  /** Runs available analyzers; one that throws is skipped, never fatal. */
  private async gather(input: EvaluationInput): Promise<AnalyzerContribution[]> {
    const results: AnalyzerContribution[] = [];

    for (const analyzer of this.analyzers) {
      let available = false;
      try {
        available = await analyzer.isAvailable(input);
      } catch (error) {
        log.warn("Analyzer availability check threw.", {
          analyzer: analyzer.id,
          error: (error as Error).message,
        });
      }
      if (!available) continue;

      try {
        const contribution = await analyzer.analyze(input);
        // Stamp provenance so the merge can attribute scores without guessing
        // from method strings, which used to be matched by prefix.
        results.push({
          ...contribution,
          scores: contribution.scores.map((s) => ({ ...s, analyzerId: analyzer.id })),
        });
      } catch (error) {
        log.warn("Analyzer failed; continuing without it.", {
          analyzer: analyzer.id,
          error: (error as Error).message,
        });
      }
    }

    return results;
  }
}

// --------------------------------------------------------------------------
// Merge rules
// --------------------------------------------------------------------------

export function mergeScores(contributions: AnalyzerContribution[]): DimensionScore[] {
  const best = new Map<QualityDimension, DimensionScore>();

  for (const contribution of contributions) {
    for (const score of contribution.scores) {
      const existing = best.get(score.dimension);

      const candidate: DimensionScore = {
        ...score,
        analyzerId: score.analyzerId ?? contribution.analyzerId,
      };

      if (!existing) {
        best.set(score.dimension, candidate);
        continue;
      }

      // Rule 1: measured always beats unmeasured.
      if (candidate.measured !== existing.measured) {
        if (candidate.measured) best.set(score.dimension, candidate);
        continue;
      }

      // Rule 2: among equals, the more pessimistic score wins.
      if (candidate.score < existing.score) {
        best.set(score.dimension, {
          ...candidate,
          method: `${candidate.method}; also assessed by ${existing.analyzerId || "another analyzer"} at ${existing.score}`,
        });
      }
    }
  }

  return [...best.values()].sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function mergeIssues(contributions: AnalyzerContribution[]): QualityIssue[] {
  const seen = new Set<string>();
  const merged: QualityIssue[] = [];

  for (const contribution of contributions) {
    for (const issue of contribution.issues) {
      const key = `${issue.code}:${issue.message.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(issue);
    }
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  return merged.sort((a, b) => order[a.severity] - order[b.severity]);
}

function mergeConfidence(
  contributions: AnalyzerContribution[],
  scores: DimensionScore[],
): "low" | "medium" | "high" {
  // Confidence describes the report, so only analyzers whose measurements
  // actually survived the merge may raise it. Attribution is by analyzer id,
  // not by matching prefixes of human-readable method strings.
  const survivors = new Set(scores.filter((s) => s.measured).map((s) => s.analyzerId));

  let best: "low" | "medium" | "high" = "low";
  for (const contribution of contributions) {
    if (!survivors.has(contribution.analyzerId)) continue;
    if (CONFIDENCE_RANK[contribution.confidence] > CONFIDENCE_RANK[best]) {
      best = contribution.confidence;
    }
  }
  return best;
}

function mergeNotes(contributions: AnalyzerContribution[], scores: DimensionScore[]): string[] {
  const notes = new Set<string>();
  for (const contribution of contributions) {
    for (const note of contribution.notCheckedNotes) notes.add(note);
  }

  const unmeasured = scores.filter((s) => !s.measured).map((s) => s.dimension);
  if (unmeasured.length > 0) {
    notes.add(
      `Estimated rather than observed: ${unmeasured.join(", ")}. These are risk priors from the shot's content and settings, not measurements.`,
    );
  }

  return [...notes];
}

function scoreFor(scores: DimensionScore[], dimension: QualityDimension): number {
  return scores.find((s) => s.dimension === dimension)?.score ?? 0;
}
