import { z } from "zod";

/**
 * Controlled vocabularies.
 *
 * Everything the Director may decide is drawn from a closed set. This is what
 * makes the downstream engines (camera, realism, consistency, prompt compiler)
 * deterministic: they switch on enums, never on free-form LLM prose.
 *
 * Free text still exists — but only in clearly marked descriptive fields that
 * no engine branches on.
 */

// --------------------------------------------------------------------------
// Delivery
// --------------------------------------------------------------------------

export const DELIVERY_FORMATS = [
  "instagram_reel",
  "instagram_story",
  "tiktok",
  "youtube_short",
  "instagram_feed",
  "landscape_ad",
] as const;
export const DeliveryFormat = z.enum(DELIVERY_FORMATS);
export type DeliveryFormat = z.infer<typeof DeliveryFormat>;

export const ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"] as const;
export const AspectRatio = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const FORMAT_DEFAULTS: Record<
  DeliveryFormat,
  { aspectRatio: AspectRatio; exportWidth: number; exportHeight: number; maxDurationSec: number }
> = {
  instagram_reel: { aspectRatio: "9:16", exportWidth: 1080, exportHeight: 1920, maxDurationSec: 90 },
  instagram_story: { aspectRatio: "9:16", exportWidth: 1080, exportHeight: 1920, maxDurationSec: 60 },
  tiktok: { aspectRatio: "9:16", exportWidth: 1080, exportHeight: 1920, maxDurationSec: 60 },
  youtube_short: { aspectRatio: "9:16", exportWidth: 1080, exportHeight: 1920, maxDurationSec: 60 },
  instagram_feed: { aspectRatio: "4:5", exportWidth: 1080, exportHeight: 1350, maxDurationSec: 60 },
  landscape_ad: { aspectRatio: "16:9", exportWidth: 1920, exportHeight: 1080, maxDurationSec: 60 },
};

export const ASPECT_RATIO_VALUE: Record<AspectRatio, number> = {
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
  "16:9": 16 / 9,
};

// --------------------------------------------------------------------------
// Creative direction
// --------------------------------------------------------------------------

/** The overarching "who shot this and why" style. Drives camera + grade + realism. */
export const VISUAL_STYLES = [
  "authentic_ugc", // a real person filmed it on a phone, unpolished
  "premium_social", // influencer-grade: phone-native but well-composed and graded
  "cinematic_commercial", // proper camera, controlled lighting, brand-film feel
  "luxury_product", // slow, precise, high-contrast, macro-forward
  "documentary_natural", // observational, natural light, no obvious styling
  "editorial_fashion", // stylised, bold, graphic composition
] as const;
export const VisualStyle = z.enum(VISUAL_STYLES);
export type VisualStyle = z.infer<typeof VisualStyle>;

export const COLOR_GRADES = [
  "natural",
  "warm_film",
  "cool_clean",
  "moody_contrast",
  "social_vibrant",
  "muted_editorial",
] as const;
export const ColorGrade = z.enum(COLOR_GRADES);
export type ColorGrade = z.infer<typeof ColorGrade>;

export const MOODS = [
  "calm",
  "cozy",
  "energetic",
  "premium",
  "playful",
  "intimate",
  "refreshing",
  "nostalgic",
] as const;
export const Mood = z.enum(MOODS);
export type Mood = z.infer<typeof Mood>;

// --------------------------------------------------------------------------
// Scene
// --------------------------------------------------------------------------

export const TIMES_OF_DAY = [
  "dawn",
  "morning",
  "midday",
  "golden_hour",
  "dusk",
  "night",
  "indoor_neutral",
] as const;
export const TimeOfDay = z.enum(TIMES_OF_DAY);
export type TimeOfDay = z.infer<typeof TimeOfDay>;

export const LIGHTING_STYLES = [
  "natural_window", // soft daylight through a window
  "practical_ambient", // in-frame lamps, neon, café pendants
  "soft_diffused", // large soft key, commercial tabletop
  "hard_directional", // sharp shadows, sun or bare source
  "mixed_night_city", // street/neon spill at night
  "studio_controlled", // clean seamless product lighting
] as const;
export const LightingStyle = z.enum(LIGHTING_STYLES);
export type LightingStyle = z.infer<typeof LightingStyle>;

/**
 * Subject kinds. These are the single most important signal in the whole
 * system — the realism engine and consistency engine both dispatch on them.
 */
export const SUBJECT_KINDS = [
  "human",
  "hands",
  "product",
  "food",
  "beverage",
  "liquid",
  "prop",
  "environment",
  "animal",
  "vehicle",
  "text_or_logo",
] as const;
export const SubjectKind = z.enum(SUBJECT_KINDS);
export type SubjectKind = z.infer<typeof SubjectKind>;

export const BACKGROUND_ACTIVITY = ["none", "subtle", "moderate", "busy"] as const;
export const BackgroundActivity = z.enum(BACKGROUND_ACTIVITY);
export type BackgroundActivity = z.infer<typeof BackgroundActivity>;

// --------------------------------------------------------------------------
// Camera
// --------------------------------------------------------------------------

export const SHOT_SIZES = [
  "extreme_close_up",
  "macro",
  "close_up",
  "medium_close_up",
  "medium",
  "wide",
  "establishing",
] as const;
export const ShotSize = z.enum(SHOT_SIZES);
export type ShotSize = z.infer<typeof ShotSize>;

export const CAMERA_ANGLES = [
  "eye_level",
  "high_angle",
  "low_angle",
  "top_down",
  "three_quarter",
  "dutch_slight",
] as const;
export const CameraAngle = z.enum(CAMERA_ANGLES);
export type CameraAngle = z.infer<typeof CameraAngle>;

export const CAMERA_HEIGHTS = ["table_level", "chest", "eye", "overhead", "low_ground"] as const;
export const CameraHeight = z.enum(CAMERA_HEIGHTS);
export type CameraHeight = z.infer<typeof CameraHeight>;

export const CAMERA_DEVICES = [
  "modern_smartphone",
  "mirrorless_prime",
  "cinema_camera",
  "gimbal_rig",
  "macro_rig",
  "action_camera",
] as const;
export const CameraDevice = z.enum(CAMERA_DEVICES);
export type CameraDevice = z.infer<typeof CameraDevice>;

/** Abstract movement primitives. Provider adapters translate these to prose. */
export const CAMERA_MOVES = [
  "static",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "slide_left",
  "slide_right",
  "orbit_slow",
  "follow",
  "handheld_drift",
  "rack_focus",
  "crane_down",
] as const;
export const CameraMove = z.enum(CAMERA_MOVES);
export type CameraMove = z.infer<typeof CameraMove>;

export const FOCUS_BEHAVIORS = [
  "locked",
  "autofocus_natural", // believable phone AF, small hunt
  "rack_to_subject",
  "rack_to_background",
  "breathing_shallow",
] as const;
export const FocusBehavior = z.enum(FOCUS_BEHAVIORS);
export type FocusBehavior = z.infer<typeof FocusBehavior>;

export const DEPTH_OF_FIELD = ["deep", "moderate", "shallow", "very_shallow"] as const;
export const DepthOfField = z.enum(DEPTH_OF_FIELD);
export type DepthOfField = z.infer<typeof DepthOfField>;

// --------------------------------------------------------------------------
// Realism & consistency
// --------------------------------------------------------------------------

export const REALISM_LEVELS = ["stylised", "standard", "high", "maximum"] as const;
export const RealismLevel = z.enum(REALISM_LEVELS);
export type RealismLevel = z.infer<typeof RealismLevel>;

/** How hard a constraint is pushed. `off` means "do not mention this at all". */
export const STRICTNESS = ["off", "light", "normal", "strict"] as const;
export const Strictness = z.enum(STRICTNESS);
export type Strictness = z.infer<typeof Strictness>;

export const STRICTNESS_WEIGHT: Record<Strictness, number> = {
  off: 0,
  light: 0.35,
  normal: 0.65,
  strict: 1,
};

// --------------------------------------------------------------------------
// References
// --------------------------------------------------------------------------

export const REFERENCE_ROLES = [
  "product",
  "logo",
  "character",
  "environment",
  "composition",
  "style",
  "food",
  "clothing",
  "first_frame",
] as const;
export const ReferenceRole = z.enum(REFERENCE_ROLES);
export type ReferenceRole = z.infer<typeof ReferenceRole>;

/** How a reference is technically consumed by a video model. */
export const REFERENCE_USAGE = [
  "init_frame", // image-to-video conditioning frame
  "identity", // subject/product identity conditioning (IP-Adapter style)
  "style", // aesthetic conditioning only
  "layout", // composition / structure conditioning (ControlNet style)
  "descriptive_only", // no model hook available; describe it in the prompt
] as const;
export const ReferenceUsage = z.enum(REFERENCE_USAGE);
export type ReferenceUsage = z.infer<typeof ReferenceUsage>;

/** Which usage each semantic role maps to, and how strongly it should bind. */
export const ROLE_DEFAULTS: Record<
  ReferenceRole,
  { usage: ReferenceUsage; adherence: Strictness; description: string }
> = {
  product: {
    usage: "identity",
    adherence: "strict",
    description: "Geometry, proportions, colour and finish of the hero product must not drift.",
  },
  logo: {
    usage: "identity",
    adherence: "strict",
    description: "Brand mark must stay legible, correctly placed and never re-lettered.",
  },
  character: {
    usage: "identity",
    adherence: "strict",
    description: "Face, hair, body proportions and age must remain the same person.",
  },
  environment: {
    usage: "layout",
    adherence: "normal",
    description: "Room, materials and spatial arrangement guide the setting.",
  },
  composition: {
    usage: "layout",
    adherence: "normal",
    description: "Framing, subject placement and negative space are matched.",
  },
  style: {
    usage: "style",
    adherence: "light",
    description: "Palette, grade and texture only — content is not copied.",
  },
  food: {
    usage: "identity",
    adherence: "strict",
    description: "Dish composition, garnish, portioning and surface texture stay faithful.",
  },
  clothing: {
    usage: "identity",
    adherence: "normal",
    description: "Garment cut, colour and layering remain consistent.",
  },
  first_frame: {
    usage: "init_frame",
    adherence: "strict",
    description: "Used directly as the opening frame for image-to-video generation.",
  },
};

// --------------------------------------------------------------------------
// Social intelligence
// --------------------------------------------------------------------------

export const SOCIAL_ARCHETYPES = [
  "influencer_ugc",
  "creator_pov",
  "food_macro",
  "premium_commercial",
  "lifestyle_morning",
  "night_cafe",
  "unboxing",
  "before_after",
  "ambience_loop",
] as const;
export const SocialArchetype = z.enum(SOCIAL_ARCHETYPES);
export type SocialArchetype = z.infer<typeof SocialArchetype>;

// --------------------------------------------------------------------------
// Shot narrative
// --------------------------------------------------------------------------

export const SHOT_PURPOSES = [
  "establishing",
  "product_hero",
  "detail",
  "interaction",
  "reaction",
  "reveal",
  "atmosphere",
  "payoff",
] as const;
export const ShotPurpose = z.enum(SHOT_PURPOSES);
export type ShotPurpose = z.infer<typeof ShotPurpose>;
