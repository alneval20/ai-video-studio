import Anthropic from "@anthropic-ai/sdk";
import { checkTools } from "@/lib/compose/ffmpeg";
import { getEnv } from "@/lib/config/env";
import { clamp } from "@/lib/core/result";
import { createLogger } from "@/lib/core/logger";
import { sampleFrames, sampleTimestamps } from "../frame-analysis";
import type {
  AnalyzerContribution,
  AnalyzerScore,
  EvaluationInput,
  QualityAnalyzer,
  QualityDimension,
  QualityIssue,
} from "../types";

const log = createLogger("quality:vision");

/** Hard cap on one perceptual review. */
const VISION_TIMEOUT_MS = 120_000;

/**
 * Vision-model judge — the only analyzer that can see *semantic* defects.
 *
 * The signature analyzer knows the cup is still roughly cup-shaped and
 * cup-coloured. Only this one can tell you the hand has six fingers, the logo
 * now reads "COFEE", or the latte looks like plastic.
 *
 * It samples frames, shows them to a vision model alongside the constraints
 * this specific shot was generated under, and asks for per-dimension scores
 * with concrete defects.
 *
 * Requires ANTHROPIC_API_KEY. Without one it simply sits out — `isAvailable()`
 * returns false and the composite falls back to the measurable analyzers plus
 * priors, exactly as before.
 */

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assessments", "defects", "overallImpression"],
  properties: {
    assessments: {
      type: "array",
      description: "One entry per dimension you were asked to judge. Omit dimensions you cannot see.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "score", "reasoning"],
        properties: {
          dimension: {
            type: "string",
            enum: [
              "humanAnatomy",
              "productConsistency",
              "subjectConsistency",
              "temporalConsistency",
              "cameraQuality",
              "motionPlausibility",
            ],
          },
          score: {
            type: "number",
            description:
              "0 to 1. 1 = indistinguishable from real footage. 0.7 = a viewer would accept it. 0.4 = visibly wrong. 0 = grossly broken.",
          },
          reasoning: { type: "string", description: "One sentence citing what you actually saw." },
        },
      },
    },
    defects: {
      type: "array",
      description: "Specific visible defects. Empty if the footage is clean.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "description", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          description: { type: "string", description: "What is wrong and where you can see it." },
          suggestion: { type: "string", description: "A concrete change that would fix it." },
        },
      },
    },
    overallImpression: {
      type: "string",
      description: "One sentence: would this pass as real footage to an ordinary viewer?",
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a quality-control reviewer for AI-generated video. You are shown frames sampled in order from a single generated clip, plus the constraints it was generated under.

Judge ONLY what you can actually see in the frames. Do not speculate about what happens between them.

Look hardest at the things generative video reliably gets wrong:
- hands and fingers (count, joints, how they contact objects)
- faces changing identity between frames
- text and logos becoming garbled or re-lettered
- objects that change shape, melt, duplicate or float
- food and drink that looks plastic or synthetic
- lighting and shadows that contradict the visible light sources
- the same object differing between the first and last frame

Be strict but fair. A frame that would pass unnoticed in a real social post scores around 0.8. Reserve scores under 0.4 for defects an ordinary viewer would immediately notice.

If a dimension is not visible in these frames — no people, no product, no text — omit it entirely rather than guessing.`;

/** Dimensions this analyzer is allowed to score. Anything else is discarded. */
const JUDGED_DIMENSIONS: ReadonlySet<QualityDimension> = new Set([
  "humanAnatomy",
  "productConsistency",
  "subjectConsistency",
  "temporalConsistency",
  "cameraQuality",
  "motionPlausibility",
]);

export class VisionAnalyzer implements QualityAnalyzer {
  readonly id = "vision-judge";
  readonly label = "Vision model judge";
  readonly capabilities = {
    dimensions: [
      "humanAnatomy" as const,
      "productConsistency" as const,
      "subjectConsistency" as const,
      "temporalConsistency" as const,
      "cameraQuality" as const,
      "motionPlausibility" as const,
    ],
    requiresGpu: false,
    requiresModel: "claude-opus-5",
    description:
      "Shows sampled frames to a vision model and asks for per-dimension scores and concrete visible defects. Requires ANTHROPIC_API_KEY.",
  };

  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(client?: Anthropic) {
    const env = getEnv();
    this.model = env.DIRECTOR_MODEL;
    this.client = client ?? (env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null);
  }

  async isAvailable(input: EvaluationInput): Promise<boolean> {
    if (!this.client) return false;
    // Judging a placeholder slate wastes tokens and tells us nothing.
    if (!input.context.isRealGeneration) return false;
    return (await checkTools()).ffmpeg;
  }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    if (!this.client) {
      return this.empty(["No ANTHROPIC_API_KEY, so no perceptual review was performed."]);
    }

    const timestamps = sampleTimestamps(input.expected.durationSec, 4);
    const frames = await sampleFrames(input.videoPath, timestamps, 512);

    if (frames.length === 0) {
      return this.empty(["No frames could be extracted for perceptual review."]);
    }

    try {
      const verdict = await this.judge(input, frames);
      return this.toContribution(verdict, frames.length);
    } catch (error) {
      const message = describeFailure(error);
      log.warn("Vision review failed.", { message });
      return this.empty([`Perceptual review was unavailable: ${message}`]);
    }
  }

  private async judge(
    input: EvaluationInput,
    frames: Array<{ atSec: number; base64: string }>,
  ): Promise<JudgeVerdict> {
    const content: Anthropic.ContentBlockParam[] = [
      { type: "text", text: this.buildBrief(input, frames.map((f) => f.atSec)) },
    ];

    for (const [index, frame] of frames.entries()) {
      content.push({
        type: "text",
        text: `Frame ${index + 1} of ${frames.length} — ${frame.atSec.toFixed(2)}s:`,
      });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: frame.base64 },
      });
    }

    const response = await this.client!.messages.create(
      {
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: JUDGE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: "user", content }],
      },
      // A quality check must never outlast the generation it is checking.
      { timeout: VISION_TIMEOUT_MS },
    );

    if (response.stop_reason === "refusal") {
      throw new Error("the model declined to review these frames");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (!text.trim()) throw new Error("the model returned an empty response");
    return JSON.parse(text) as JudgeVerdict;
  }

  /** Tells the judge what this shot was *supposed* to be, so it judges intent. */
  private buildBrief(input: EvaluationInput, timestamps: number[]): string {
    const ctx = input.context;
    const present: string[] = [];
    if (ctx.hasHuman) present.push("a person");
    if (ctx.hasHands) present.push("hands in frame");
    if (ctx.hasProduct) present.push("a hero product");
    if (ctx.hasLiquid) present.push("a liquid or drink");
    if (ctx.hasBranding) present.push("visible branding or text");

    return [
      `This clip was generated to show: ${ctx.shotDescription}`,
      "",
      present.length > 0 ? `It should contain: ${present.join(", ")}.` : "",
      ctx.strictDomains.length > 0
        ? `The strictest requirements for this shot were: ${ctx.strictDomains.map((d) => d.replace(/_/g, " ")).join(", ")}.`
        : "",
      ctx.preserveNotes.length > 0
        ? `A reference image was supplied; these must be preserved: ${ctx.preserveNotes.join(", ")}.`
        : "No reference image was supplied.",
      "",
      `Requested realism level: ${ctx.realismLevel}.`,
      `Requested camera movement: ${ctx.cameraMoveIntensity} of 1 (low means the camera should be nearly still).`,
      `Requested subject motion: ${ctx.subjectMotion}.`,
      "",
      `${timestamps.length} frames follow, in chronological order (${timestamps.map((t) => `${t.toFixed(2)}s`).join(", ")}). Compare them against each other as well as judging each one.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private toContribution(verdict: JudgeVerdict, frameCount: number): AnalyzerContribution {
    const scores: AnalyzerScore[] = [];

    for (const assessment of verdict.assessments ?? []) {
      const dimension = assessment.dimension as QualityDimension;
      if (!JUDGED_DIMENSIONS.has(dimension)) continue;

      scores.push({
        dimension,
        score: clamp(Number(assessment.score) || 0, 0, 1),
        measured: true,
        method: `vision review of ${frameCount} frames — ${truncate(assessment.reasoning, 160)}`,
      });
    }

    const issues: QualityIssue[] = (verdict.defects ?? []).map((defect) => ({
      code: "visual_defect",
      // Attribute the defect to the weakest dimension the judge scored, so the
      // repair planner acts on the right lever.
      dimension: weakestDimension(scores),
      severity: normaliseSeverity(defect.severity),
      message: truncate(defect.description, 300),
      suggestion: truncate(defect.suggestion ?? "", 200),
    }));

    return {
      analyzerId: this.id,
      scores,
      issues,
      confidence: "high",
      notCheckedNotes:
        scores.length === 0
          ? ["The vision review returned no usable dimension scores."]
          : [],
    };
  }

  private empty(notes: string[]): AnalyzerContribution {
    return {
      analyzerId: this.id,
      scores: [],
      issues: [],
      confidence: "low",
      notCheckedNotes: notes,
    };
  }
}

interface JudgeVerdict {
  assessments?: Array<{ dimension: string; score: number; reasoning: string }>;
  defects?: Array<{ severity: string; description: string; suggestion?: string }>;
  overallImpression?: string;
}

function weakestDimension(scores: AnalyzerScore[]): QualityDimension {
  if (scores.length === 0) return "technicalIntegrity";
  return scores.reduce((worst, s) => (s.score < worst.score ? s : worst)).dimension;
}

function normaliseSeverity(raw: string): QualityIssue["severity"] {
  return raw === "critical" || raw === "warning" || raw === "info" ? raw : "warning";
}

function truncate(text: string, max: number): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function describeFailure(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "the API key was rejected";
  if (error instanceof Anthropic.RateLimitError) return "the model is rate limited";
  if (error instanceof Anthropic.APIConnectionError) return "the API was unreachable";
  if (error instanceof Anthropic.APIError) return `API error ${error.status}`;
  return error instanceof Error ? error.message : String(error);
}
