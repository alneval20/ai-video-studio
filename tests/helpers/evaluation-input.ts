import type { EvaluationInput } from "@/lib/quality/types";

/** Builds an EvaluationInput with sensible defaults for tests. */
export function evaluationInput(
  videoPath: string,
  overrides: {
    expected?: Partial<EvaluationInput["expected"]>;
    context?: Partial<EvaluationInput["context"]>;
    targets?: Partial<EvaluationInput["targets"]>;
  } = {},
): EvaluationInput {
  return {
    shotId: "shot_test",
    attempt: 0,
    videoPath,
    expected: {
      durationSec: 3,
      width: 256,
      height: 256,
      fps: 12,
      ...overrides.expected,
    },
    context: {
      realismLevel: "high",
      strictDomains: [],
      hasHuman: false,
      hasHands: false,
      hasProduct: false,
      hasLiquid: false,
      hasBranding: false,
      referencePaths: [],
      consistencyStrength: 0.8,
      isRealGeneration: true,
      cameraMoveIntensity: 0.25,
      subjectMotion: "natural",
      shotDescription: "A test shot.",
      preserveNotes: [],
      ...overrides.context,
    },
    targets: {
      minOverall: 0.7,
      minTemporalConsistency: 0.65,
      minSubjectConsistency: 0.6,
      ...overrides.targets,
    },
  };
}
