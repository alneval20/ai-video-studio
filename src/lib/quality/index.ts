import { PriorAnalyzer } from "./analyzers/prior-analyzer";
import { ReferenceAnalyzer } from "./analyzers/reference-analyzer";
import { TechnicalAnalyzer } from "./analyzers/technical-analyzer";
import { TemporalAnalyzer } from "./analyzers/temporal-analyzer";
import { VisionAnalyzer } from "./analyzers/vision-analyzer";
import { CompositeEvaluator } from "./composite-evaluator";
import type { QualityAnalyzer, QualityEvaluator } from "./types";

/**
 * Quality control entry point.
 *
 * The composite evaluator runs every analyzer that can run in the current
 * environment. What is actually measured therefore scales with what is
 * installed and configured:
 *
 *   nothing            → file existence only, everything else estimated
 *   + FFmpeg (bundled) → technical integrity, temporal stability, reference
 *                        similarity and subject drift all genuinely measured
 *   + ANTHROPIC_API_KEY → plus a vision-model review of anatomy, branding,
 *                         material realism and cross-frame identity
 *
 * Nothing here fabricates a measurement it did not take.
 */
const evaluators = new Map<string, QualityEvaluator>();

function register(evaluator: QualityEvaluator): void {
  evaluators.set(evaluator.id, evaluator);
}

register(new CompositeEvaluator());

export function getEvaluator(id?: string): QualityEvaluator {
  return (id ? evaluators.get(id) : undefined) ?? evaluators.get("composite")!;
}

export function listEvaluators(): QualityEvaluator[] {
  return [...evaluators.values()];
}

/** Every analyzer, for the UI's capability panel. */
export function listAnalyzers(): QualityAnalyzer[] {
  return [
    new TechnicalAnalyzer(),
    new TemporalAnalyzer(),
    new ReferenceAnalyzer(),
    new VisionAnalyzer(),
    new PriorAnalyzer(),
  ];
}

export {
  CompositeEvaluator,
  PriorAnalyzer,
  ReferenceAnalyzer,
  TechnicalAnalyzer,
  TemporalAnalyzer,
  VisionAnalyzer,
};
export * from "./types";
export * from "./repair-planner";
export * from "./frame-analysis";
