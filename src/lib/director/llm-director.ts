import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/lib/config/env";
import { StudioError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";
import { DirectorBrief, coerceBriefShape } from "@/lib/spec/brief";
import { DIRECTOR_BRIEF_JSON_SCHEMA, DIRECTOR_SYSTEM_PROMPT } from "./brief-schema";
import { HeuristicDirector } from "./heuristic-director";
import type { Director, DirectorInput, DirectorOutput } from "./types";

const log = createLogger("director:llm");

/**
 * The LLM director.
 *
 * Deterministic boundary, per the architecture rules:
 *
 *   natural language -> LLM -> JSON -> zod validation -> VideoGenerationSpec
 *
 * Nothing downstream ever sees unvalidated model output. If the model returns
 * malformed JSON, violates the schema, or refuses, we degrade to the heuristic
 * director rather than failing the generation.
 */
export class LlmDirector implements Director {
  readonly id = "llm" as const;

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallback: HeuristicDirector;

  constructor(client?: Anthropic) {
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY && !client) {
      throw new StudioError("DIRECTOR_FAILED", "The LLM director requires an Anthropic API key.", {
        remedy: "Set ANTHROPIC_API_KEY in .env.local, or set DIRECTOR_MODE=heuristic to run without one.",
      });
    }
    this.client = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.model = env.DIRECTOR_MODEL;
    this.fallback = new HeuristicDirector();
  }

  async direct(input: DirectorInput): Promise<DirectorOutput> {
    const started = Date.now();
    const warnings: string[] = [];

    try {
      const raw = await this.requestBrief(input);
      const repaired = coerceBriefShape(raw);
      const parsed = DirectorBrief.safeParse(repaired);

      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
        log.warn("Director output failed validation; falling back to heuristics.", { issues });
        return this.degrade(input, started, [
          "The AI director returned a brief that did not match the required schema.",
          ...issues,
        ]);
      }

      // Overrides from the UI always win over anything the model decided.
      const brief = applyOverrides(parsed.data, input, warnings);

      log.info("Director brief produced.", {
        archetype: brief.socialArchetype,
        shots: brief.suggestedShotCount,
        durationSec: brief.targetDurationSec,
        subjects: brief.subjects.length,
      });

      return {
        brief,
        engine: "llm",
        model: this.model,
        fallbackUsed: false,
        warnings,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      const message = describeApiFailure(error);
      log.warn("Director call failed; falling back to heuristics.", { message });
      return this.degrade(input, started, [message]);
    }
  }

  private async requestBrief(input: DirectorInput): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      system: DIRECTOR_SYSTEM_PROMPT,
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: DIRECTOR_BRIEF_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    // A refusal is a successful HTTP response with empty/partial content —
    // reading content[0] blindly would throw.
    if (response.stop_reason === "refusal") {
      throw new StudioError("DIRECTOR_FAILED", "The director model declined this prompt.", {
        remedy: "Rephrase the video idea, or set DIRECTOR_MODE=heuristic to use the offline director.",
        details: response.stop_details,
      });
    }
    if (response.stop_reason === "max_tokens") {
      throw new StudioError("DIRECTOR_INVALID_OUTPUT", "The director's response was cut off.", {
        remedy: "Try a shorter prompt.",
      });
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (!text.trim()) {
      throw new StudioError("DIRECTOR_INVALID_OUTPUT", "The director returned an empty response.");
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new StudioError("DIRECTOR_INVALID_OUTPUT", "The director returned text that was not valid JSON.");
    }
  }

  /** Runs the heuristic director and records why the LLM path was abandoned. */
  private async degrade(input: DirectorInput, started: number, warnings: string[]): Promise<DirectorOutput> {
    const result = await this.fallback.direct(input);
    return {
      ...result,
      engine: "heuristic",
      model: this.model,
      fallbackUsed: true,
      warnings: [...warnings, ...result.warnings, "Fell back to the offline heuristic director."],
      elapsedMs: Date.now() - started,
    };
  }
}

function buildUserMessage(input: DirectorInput): string {
  const parts: string[] = [`The user's idea:\n"""\n${input.prompt.trim()}\n"""`];

  if (input.referenceRoles.length > 0) {
    parts.push(
      `They attached reference images with these roles: ${input.referenceRoles.join(", ")}. ` +
        `Assume those exact things appear on screen and must be preserved faithfully.`,
    );
  } else {
    parts.push("They attached no reference images, so every subject must be described well enough to be generated from text alone.");
  }

  if (input.brand) {
    const b = input.brand;
    parts.push(
      [
        `Brand profile: ${b.name}.`,
        b.description,
        `House style: ${b.defaults.visualStyle.replace(/_/g, " ")}, ${b.defaults.colorGrade.replace(/_/g, " ")} grade, ${b.defaults.mood} mood.`,
        b.signatureNotes.length ? `Signature details: ${b.signatureNotes.join("; ")}.` : "",
        b.avoid.length ? `This brand avoids: ${b.avoid.join("; ")}.` : "",
        "Follow the house style unless the user's idea clearly asks for something else.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  const hard: string[] = [];
  if (input.overrides.format) hard.push(`format must be "${input.overrides.format}"`);
  if (input.overrides.durationSec) hard.push(`targetDurationSec must be ${input.overrides.durationSec}`);
  if (input.overrides.realismLevel) hard.push(`realismLevel must be "${input.overrides.realismLevel}"`);
  if (input.overrides.shotCount) hard.push(`suggestedShotCount must be ${input.overrides.shotCount}`);
  if (hard.length > 0) {
    parts.push(`The user has fixed these settings explicitly — honour them exactly: ${hard.join("; ")}.`);
  }

  return parts.join("\n\n");
}

/**
 * UI selections are non-negotiable. The model is asked to respect them, but we
 * enforce them here too rather than trusting it.
 */
function applyOverrides(brief: DirectorBrief, input: DirectorInput, warnings: string[]): DirectorBrief {
  const next = { ...brief };
  const { format, durationSec, realismLevel, shotCount } = input.overrides;

  if (format && next.format !== format) {
    warnings.push(`Director chose ${next.format}; overridden to ${format} by your Format setting.`);
    next.format = format;
  }
  if (durationSec && next.targetDurationSec !== durationSec) {
    next.targetDurationSec = durationSec;
  }
  if (realismLevel && next.realismLevel !== realismLevel) {
    next.realismLevel = realismLevel;
  }
  if (shotCount && next.suggestedShotCount !== shotCount) {
    next.suggestedShotCount = shotCount;
  }
  return next;
}

function describeApiFailure(error: unknown): string {
  if (error instanceof StudioError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The director model is rate limited right now.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model "${getEnv().DIRECTOR_MODEL}" was not found. Check DIRECTOR_MODEL.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API (network error).";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
