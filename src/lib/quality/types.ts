import { z } from "zod";

/**
 * Quality control contracts.
 *
 * The interface is designed for evaluators we do not have yet (a VLM judge, a
 * CLIP/DINO reference-similarity scorer, an optical-flow flicker detector).
 * The evaluator shipped today is honest about that: it reports `confidence` and
 * lists, per dimension, whether it actually measured anything.
 */

export const QUALITY_DIMENSIONS = [
  "temporalConsistency",
  "subjectConsistency",
  "productConsistency",
  "humanAnatomy",
  "cameraQuality",
  "referenceSimilarity",
  "motionPlausibility",
  "technicalIntegrity",
] as const;
export const QualityDimension = z.enum(QUALITY_DIMENSIONS);
export type QualityDimension = z.infer<typeof QualityDimension>;

/** Human-readable labels, used in the UI. */
export const DIMENSION_LABELS: Record<QualityDimension, string> = {
  temporalConsistency: "Temporal consistency",
  subjectConsistency: "Subject consistency",
  productConsistency: "Product consistency",
  humanAnatomy: "Human anatomy",
  cameraQuality: "Camera quality",
  referenceSimilarity: "Reference similarity",
  motionPlausibility: "Motion plausibility",
  technicalIntegrity: "Technical integrity",
};

export const ISSUE_SEVERITIES = ["info", "warning", "critical"] as const;
export const IssueSeverity = z.enum(ISSUE_SEVERITIES);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

export const QualityIssue = z.object({
  code: z.string().min(1),
  dimension: QualityDimension,
  severity: IssueSeverity,
  message: z.string().min(1),
  /** Concrete instruction the repair planner can act on. */
  suggestion: z.string().default(""),
});
export type QualityIssue = z.infer<typeof QualityIssue>;

/**
 * A measured dimension. `measured: false` means no evaluator was capable of
 * assessing it — the score is a prior, not an observation, and the UI says so.
 */
export const DimensionScore = z.object({
  dimension: QualityDimension,
  /** Which analyzer produced this. Set by the composite during the merge. */
  analyzerId: z.string().default(""),
  score: z.number().min(0).max(1),
  measured: z.boolean(),
  method: z.string().default(""),
});
export type DimensionScore = z.infer<typeof DimensionScore>;

export const QualityReport = z.object({
  id: z.string().min(1),
  shotId: z.string().min(1),
  attempt: z.number().int().min(0),
  evaluatorId: z.string().min(1),
  evaluatedAt: z.string().min(1),
  /** Weighted mean of the dimension scores, 0..1. */
  overall: z.number().min(0).max(1),
  scores: z.array(DimensionScore),
  issues: z.array(QualityIssue),
  /** Did this meet the spec's quality targets? */
  passed: z.boolean(),
  /**
   * How much to trust this report. `low` means only technical properties were
   * checked and no perceptual model was involved.
   */
  confidence: z.enum(["low", "medium", "high"]),
  /** What this evaluator explicitly could not check. */
  notCheckedNotes: z.array(z.string()).default([]),
});
export type QualityReport = z.infer<typeof QualityReport>;

export interface EvaluationInput {
  shotId: string;
  attempt: number;
  /** Absolute path to the generated clip. */
  videoPath: string;
  /** What we asked for — an evaluator compares against this. */
  expected: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
  };
  /** Spec context: what matters for this shot. */
  context: {
    realismLevel: string;
    /** Dimensions the realism engine flagged as strict for this shot. */
    strictDomains: string[];
    hasHuman: boolean;
    hasHands: boolean;
    hasProduct: boolean;
    hasLiquid: boolean;
    hasBranding: boolean;
    referencePaths: string[];
    consistencyStrength: number;
    isRealGeneration: boolean;
    /**
     * Camera movement intensity that was requested, 0..1. Lets the temporal
     * analyzer distinguish a deliberately locked-off shot from a frozen
     * generation — the pixels look the same, the intent does not.
     */
    cameraMoveIntensity: number;
    /** Subject motion that was requested. Same purpose. */
    subjectMotion: string;
    /** Human-readable summary of the shot, for a vision model to judge against. */
    shotDescription: string;
    /** What the identity-bearing references are meant to preserve. */
    preserveNotes: string[];
  };
  targets: {
    minOverall: number;
    minTemporalConsistency: number;
    minSubjectConsistency: number;
  };
}

export interface EvaluatorCapabilities {
  dimensions: QualityDimension[];
  requiresGpu: boolean;
  requiresModel: string | null;
  description: string;
}

/**
 * One measurement technique.
 *
 * Analyzers are deliberately narrow — each measures only what it genuinely
 * can, and reports nothing about the rest. The composite evaluator merges
 * them, so adding a new technique never means rewriting an existing one.
 */
export interface QualityAnalyzer {
  readonly id: string;
  readonly label: string;
  readonly capabilities: EvaluatorCapabilities;
  /**
   * Can this analyzer run right now, for this input? Checked before every
   * evaluation — an analyzer needing an API key, ffmpeg, or a reference image
   * simply sits out when those are absent.
   */
  isAvailable(input: EvaluationInput): Promise<boolean>;
  analyze(input: EvaluationInput): Promise<AnalyzerContribution>;
}

/**
 * A score as an analyzer reports it. `analyzerId` is stamped by the composite
 * during the merge, so an analyzer never has to repeat its own identity.
 */
export type AnalyzerScore = Omit<DimensionScore, "analyzerId"> & { analyzerId?: string };

export interface AnalyzerContribution {
  analyzerId: string;
  scores: AnalyzerScore[];
  issues: QualityIssue[];
  confidence: "low" | "medium" | "high";
  /** Things this analyzer explicitly could not assess. */
  notCheckedNotes: string[];
}

/** The top-level evaluator the pipeline calls. */
export interface QualityEvaluator {
  readonly id: string;
  readonly label: string;
  readonly capabilities: EvaluatorCapabilities;
  evaluate(input: EvaluationInput): Promise<QualityReport>;
}

export const CONFIDENCE_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Weights used to collapse dimension scores into `overall`. */
export const DIMENSION_WEIGHTS: Record<QualityDimension, number> = {
  technicalIntegrity: 1.5,
  temporalConsistency: 1.3,
  subjectConsistency: 1.2,
  productConsistency: 1.2,
  humanAnatomy: 1.1,
  motionPlausibility: 1,
  cameraQuality: 0.9,
  referenceSimilarity: 1,
};

export function weightedOverall(scores: DimensionScore[]): number {
  if (scores.length === 0) return 0;
  let total = 0;
  let weight = 0;
  for (const s of scores) {
    // An unmeasured dimension contributes at reduced weight — it is a prior,
    // and it should not dominate a score built from real observations.
    const w = DIMENSION_WEIGHTS[s.dimension] * (s.measured ? 1 : 0.35);
    total += s.score * w;
    weight += w;
  }
  return weight === 0 ? 0 : Number((total / weight).toFixed(4));
}
