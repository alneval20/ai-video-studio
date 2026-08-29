import { z } from "zod";
import {
  BackgroundActivity,
  ColorGrade,
  DeliveryFormat,
  LightingStyle,
  Mood,
  RealismLevel,
  ReferenceRole,
  ShotPurpose,
  ShotSize,
  SocialArchetype,
  SubjectKind,
  TimeOfDay,
  VisualStyle,
} from "./vocab";

/**
 * DirectorBrief — the ONLY thing an LLM is ever allowed to produce.
 *
 * It is deliberately small and highly constrained: every discriminating field
 * is an enum, free text is limited to short descriptive strings, and nothing
 * technical (fps, resolution, seeds, negative prompts, camera parameters,
 * provider settings) appears here at all. Those are derived deterministically
 * by the engines downstream.
 *
 * If the LLM produces garbage, validation fails and we fall back to the
 * heuristic director. The application never consumes unvalidated model output.
 */

export const BriefSubject = z.object({
  /** Stable slug used by the consistency engine to track this entity across shots. */
  key: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9_]+$/, "subject key must be lower_snake_case"),
  kind: SubjectKind,
  /** Short concrete noun phrase, e.g. "tall clear glass of iced latte". */
  description: z.string().trim().min(2).max(220),
  /** Is this the thing the video is actually about? Exactly one should be true. */
  hero: z.boolean().default(false),
  /** Distinguishing details the model must not invent away. */
  identityNotes: z.array(z.string().trim().min(2).max(160)).max(8).default([]),
});
export type BriefSubject = z.infer<typeof BriefSubject>;

export const BriefBeat = z.object({
  purpose: ShotPurpose,
  /** What visibly happens, in one sentence. Present tense, concrete. */
  action: z.string().trim().min(4).max(300),
  /** Subject keys featured in this beat. Must reference `subjects[].key`. */
  featured: z.array(z.string().trim().min(1)).max(6).default([]),
  suggestedShotSize: ShotSize.optional(),
  /** Relative weight for duration allocation, 1 = normal. */
  weight: z.number().min(0.4).max(2.5).default(1),
});
export type BriefBeat = z.infer<typeof BriefBeat>;

export const DirectorBrief = z.object({
  /** One-line creative summary of the video, written for a human. */
  logline: z.string().trim().min(6).max(240),

  /** ISO-639-1 code of the user's prompt. Output prose is always English. */
  sourceLanguage: z.string().trim().min(2).max(8).default("en"),

  format: DeliveryFormat,
  socialArchetype: SocialArchetype,
  visualStyle: VisualStyle,
  colorGrade: ColorGrade,
  mood: Mood,
  realismLevel: RealismLevel,

  /** Total runtime the director thinks the idea needs. */
  targetDurationSec: z.number().min(2).max(60),

  /**
   * How many shots the idea genuinely needs. The planner treats this as a
   * strong suggestion and will refuse to over-cut short social videos.
   */
  suggestedShotCount: z.number().int().min(1).max(6),

  environment: z.object({
    /** e.g. "modern speciality café with wood tables and warm pendant lights" */
    setting: z.string().trim().min(3).max(240),
    timeOfDay: TimeOfDay,
    lighting: LightingStyle,
    backgroundActivity: BackgroundActivity,
    /** Sensory/atmospheric notes: steam, condensation, rain on glass, etc. */
    atmosphereNotes: z.array(z.string().trim().min(2).max(140)).max(6).default([]),
  }),

  subjects: z.array(BriefSubject).min(1).max(6),

  /** Ordered narrative beats. The shot planner turns these into shots. */
  beats: z.array(BriefBeat).min(1).max(6),

  /**
   * Which reference roles the user's attachments should bind to, if the
   * director can tell from the prompt. Optional — the reference manager
   * already infers roles independently.
   */
  expectedReferenceRoles: z.array(ReferenceRole).max(9).default([]),

  /** Things the user explicitly asked to avoid, in plain language. */
  userAvoidances: z.array(z.string().trim().min(2).max(160)).max(10).default([]),

  /** Director's own reasoning, shown in the UI's "plan" panel. Not parsed. */
  rationale: z.string().trim().max(1200).default(""),
});
export type DirectorBrief = z.infer<typeof DirectorBrief>;

/**
 * Structural repairs applied to LLM output *before* validation. These fix the
 * mistakes models actually make, without loosening the schema itself.
 */
export function coerceBriefShape(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const b = { ...(raw as Record<string, unknown>) };

  // Models sometimes emit a single subject/beat object instead of an array.
  if (b.subjects && !Array.isArray(b.subjects)) b.subjects = [b.subjects];
  if (b.beats && !Array.isArray(b.beats)) b.beats = [b.beats];

  if (Array.isArray(b.subjects)) {
    let heroSeen = false;
    const subjects: unknown[] = b.subjects.map((s: unknown, i: number) => {
      if (typeof s !== "object" || s === null) return s;
      const subj = { ...(s as Record<string, unknown>) };
      // Derive a key from the description when the model omits it.
      if (typeof subj.key !== "string" || subj.key.trim() === "") {
        subj.key = slugKey(String(subj.description ?? `subject_${i + 1}`));
      } else {
        subj.key = slugKey(String(subj.key));
      }
      // Enforce exactly one hero: first truthy wins, rest demoted.
      if (subj.hero === true) {
        if (heroSeen) subj.hero = false;
        heroSeen = true;
      }
      return subj;
    });
    if (!heroSeen && subjects.length > 0) {
      const first = subjects[0];
      if (typeof first === "object" && first !== null) {
        (first as Record<string, unknown>).hero = true;
      }
    }
    b.subjects = subjects;
  }

  if (Array.isArray(b.beats)) {
    const keys = new Set(
      Array.isArray(b.subjects)
        ? (b.subjects as unknown[])
            .map((s) => (typeof s === "object" && s !== null ? (s as { key?: unknown }).key : null))
            .filter((k): k is string => typeof k === "string")
        : [],
    );
    b.beats = b.beats.map((raw: unknown) => {
      if (typeof raw !== "object" || raw === null) return raw;
      const beat = { ...(raw as Record<string, unknown>) };
      if (typeof beat.featured === "string") beat.featured = [beat.featured];
      if (Array.isArray(beat.featured)) {
        // Drop dangling references so the planner never chases a missing key.
        beat.featured = beat.featured
          .map((f) => slugKey(String(f)))
          .filter((f) => keys.size === 0 || keys.has(f));
      }
      return beat;
    });
  }

  return b;
}

export function slugKey(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "subject"
  );
}
