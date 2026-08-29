import { clamp } from "@/lib/core/result";
import type {
  AnalyzerContribution,
  AnalyzerScore,
  EvaluationInput,
  QualityAnalyzer,
} from "../types";

/**
 * Risk priors — the gap filler, and the ONLY analyzer that does not measure.
 *
 * It runs last and every score it emits is marked `measured: false`. Its job is
 * to give the repair loop something to rank by for dimensions no real analyzer
 * could assess (no ffmpeg, no API key, no reference image).
 *
 * The composite always prefers a measured score over one of these, and
 * unmeasured scores carry only 35% weight in the overall. As real analyzers
 * become available this contributes less and less automatically.
 *
 * These are NOT observations, and the UI marks them with an asterisk.
 */
export class PriorAnalyzer implements QualityAnalyzer {
  readonly id = "risk-prior";
  readonly label = "Risk prior (estimate)";
  readonly capabilities = {
    dimensions: [
      "temporalConsistency" as const,
      "subjectConsistency" as const,
      "productConsistency" as const,
      "humanAnatomy" as const,
      "motionPlausibility" as const,
      "cameraQuality" as const,
      "referenceSimilarity" as const,
    ],
    requiresGpu: false,
    requiresModel: null,
    description:
      "Estimates unmeasurable dimensions from the shot's content and realism profile. Never an observation — always superseded by a real measurement.",
  };

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    const ctx = input.context;
    const strict = new Set(ctx.strictDomains);
    const base = 0.72;
    const method = "risk prior from the shot's realism profile (not observed)";

    const risk = (factors: Array<[boolean, number]>): number => {
      let value = base;
      for (const [applies, delta] of factors) if (applies) value -= delta;
      return clamp(Number(value.toFixed(3)), 0.2, 0.9);
    };

    const scores: AnalyzerScore[] = [
      {
        dimension: "temporalConsistency",
        score: risk([
          [input.expected.durationSec > 6, 0.08],
          [ctx.hasLiquid, 0.05],
          [ctx.consistencyStrength < 0.5, 0.06],
        ]),
        measured: false,
        method,
      },
      {
        dimension: "subjectConsistency",
        score: risk([
          [ctx.referencePaths.length === 0, 0.1],
          [ctx.hasHuman, 0.06],
          [ctx.consistencyStrength < 0.5, 0.08],
        ]),
        measured: false,
        method,
      },
      {
        dimension: "productConsistency",
        score: risk([
          [!ctx.hasProduct, -0.1],
          [ctx.hasProduct && ctx.referencePaths.length === 0, 0.12],
          [ctx.hasBranding, 0.06],
        ]),
        measured: false,
        method,
      },
      {
        dimension: "humanAnatomy",
        score: risk([
          [!ctx.hasHuman && !ctx.hasHands, -0.15],
          [ctx.hasHands, 0.1],
          [ctx.hasHuman && !strict.has("human_anatomy"), 0.05],
        ]),
        measured: false,
        method,
      },
      {
        dimension: "motionPlausibility",
        score: risk([
          [ctx.hasLiquid, 0.06],
          [ctx.realismLevel === "stylised", 0.05],
        ]),
        measured: false,
        method,
      },
      {
        dimension: "cameraQuality",
        score: risk([[ctx.realismLevel === "stylised", 0.05]]),
        measured: false,
        method,
      },
      {
        dimension: "referenceSimilarity",
        score: ctx.referencePaths.length === 0 ? 0.5 : risk([[ctx.referencePaths.length > 3, 0.08]]),
        measured: false,
        method:
          ctx.referencePaths.length === 0
            ? "no references attached; neutral placeholder"
            : method,
      },
    ];

    return {
      analyzerId: this.id,
      scores,
      issues: [],
      confidence: "low",
      notCheckedNotes: [],
    };
  }
}

