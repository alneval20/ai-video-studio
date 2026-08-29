import { z } from "zod";
import { RealismDomain } from "@/lib/spec/spec";
import {
  ColorGrade,
  DeliveryFormat,
  Mood,
  RealismLevel,
  SocialArchetype,
  Strictness,
  VisualStyle,
} from "@/lib/spec/vocab";

/**
 * A brand profile is a bundle of *defaults and constraints*, never a script.
 * It biases the director and the engines; it does not replace them.
 */
export const BrandProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),

  defaults: z.object({
    format: DeliveryFormat,
    visualStyle: VisualStyle,
    colorGrade: ColorGrade,
    mood: Mood,
    socialArchetype: SocialArchetype,
    realismLevel: RealismLevel,
    durationSec: z.number().min(2).max(60),
  }),

  /**
   * Per-domain realism overrides applied on top of the resolved emphasis map.
   * Partial by design — a brand names only the domains it cares about.
   */
  realismOverrides: z.partialRecord(RealismDomain, Strictness).default({}),

  camera: z.object({
    /** Presets the camera director should favour for this brand. */
    preferredPresetIds: z.array(z.string()).default([]),
    /** 0..1 — how much camera movement this brand tolerates. */
    motionBudget: z.number().min(0).max(1).default(0.35),
  }),

  consistency: z.object({
    strength: z.number().min(0).max(1).default(0.8),
    /** Adherence applied to references carrying these roles. */
    logoAdherence: Strictness.default("strict"),
    productAdherence: Strictness.default("strict"),
  }),

  /** Hex swatches. Injected as descriptive colour language, not as a LUT. */
  palette: z.array(z.string()).default([]),

  /** Brand-specific negative constraints, appended to the realism negatives. */
  avoid: z.array(z.string()).default([]),

  /** Short phrases the compiler may weave into the positive prompt. */
  signatureNotes: z.array(z.string()).default([]),

  /** True for built-in profiles; user profiles are editable. */
  builtIn: z.boolean().default(false),
});
export type BrandProfile = z.infer<typeof BrandProfile>;
