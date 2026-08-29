import type { BrandProfile } from "./types";

/**
 * Built-in brand profiles. "Cup of Coffee" is one entry in a general system —
 * nothing in the engines knows this brand exists.
 */
export const BUILT_IN_BRANDS: readonly BrandProfile[] = [
  {
    id: "cup-of-coffee",
    name: "Cup of Coffee",
    description:
      "Speciality coffee brand. Real café footage over studio polish; the drink is always the hero and the branding must never wobble.",
    defaults: {
      format: "instagram_reel",
      visualStyle: "premium_social",
      colorGrade: "warm_film",
      mood: "cozy",
      socialArchetype: "night_cafe",
      realismLevel: "high",
      durationSec: 12,
    },
    realismOverrides: {
      food_texture: "strict",
      liquid_physics: "strict",
      product_geometry: "strict",
      branding_legibility: "strict",
      hands: "strict",
      temporal_stability: "strict",
    },
    camera: {
      preferredPresetIds: ["handheld_iphone", "food_closeup", "slow_push_in", "subtle_handheld", "product_macro"],
      motionBudget: 0.3,
    },
    consistency: {
      strength: 0.85,
      logoAdherence: "strict",
      productAdherence: "strict",
    },
    palette: ["#2B1B12", "#C9A227", "#F3EAE0", "#0E0B09"],
    avoid: [
      "obvious CGI or 3D product renders",
      "generic stock-video look",
      "template motion graphics",
      "fake or plastic-looking coffee",
      "spilled or messy presentation",
    ],
    signatureNotes: [
      "condensation and crema read as real, freshly made coffee",
      "warm practical café light with visible pendant sources",
      "the cup sits solidly on a real table surface",
    ],
    builtIn: true,
  },
  {
    id: "generic-premium",
    name: "Premium Product (generic)",
    description: "Controlled, slow, high-contrast commercial look for any hero object.",
    defaults: {
      format: "instagram_reel",
      visualStyle: "luxury_product",
      colorGrade: "moody_contrast",
      mood: "premium",
      socialArchetype: "premium_commercial",
      realismLevel: "high",
      durationSec: 10,
    },
    realismOverrides: {
      product_geometry: "strict",
      branding_legibility: "strict",
      material_texture: "strict",
      lighting_physics: "strict",
    },
    camera: {
      preferredPresetIds: ["static_luxury", "premium_product", "product_macro", "rack_focus"],
      motionBudget: 0.25,
    },
    consistency: { strength: 0.9, logoAdherence: "strict", productAdherence: "strict" },
    palette: [],
    avoid: ["cheap lighting", "cluttered background", "handheld shake"],
    signatureNotes: ["deep shadows with a single controlled highlight travelling across the surface"],
    builtIn: true,
  },
  {
    id: "generic-ugc",
    name: "Creator UGC (generic)",
    description: "Unpolished phone footage that reads as a real person's post.",
    defaults: {
      format: "tiktok",
      visualStyle: "authentic_ugc",
      colorGrade: "natural",
      mood: "playful",
      socialArchetype: "influencer_ugc",
      realismLevel: "high",
      durationSec: 8,
    },
    realismOverrides: {
      hands: "strict",
      human_anatomy: "strict",
      camera_optics: "strict",
    },
    camera: {
      preferredPresetIds: ["creator_ugc", "handheld_iphone", "over_the_shoulder"],
      motionBudget: 0.45,
    },
    consistency: { strength: 0.7, logoAdherence: "normal", productAdherence: "strict" },
    palette: [],
    avoid: ["studio lighting", "colour-graded commercial look", "perfect framing"],
    signatureNotes: ["framing is slightly imperfect, as if held in one hand while talking"],
    builtIn: true,
  },
] as const;

export function getBuiltInBrand(id: string): BrandProfile | undefined {
  return BUILT_IN_BRANDS.find((b) => b.id === id);
}
