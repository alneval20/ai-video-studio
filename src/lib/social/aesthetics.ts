import type {
  BackgroundActivity,
  ColorGrade,
  DeliveryFormat,
  LightingStyle,
  Mood,
  SocialArchetype,
  TimeOfDay,
  VisualStyle,
} from "@/lib/spec/vocab";

/**
 * Social video intelligence.
 *
 * This is the layer that turns "make it look like an influencer casually
 * filmed it" into concrete camera/lighting/performance decisions, so the user
 * never has to name a device, a grade or a movement style.
 */
export interface SocialArchetypeProfile {
  id: SocialArchetype;
  label: string;
  description: string;
  visualStyle: VisualStyle;
  colorGrade: ColorGrade;
  mood: Mood;
  lighting: LightingStyle;
  timeOfDay: TimeOfDay;
  backgroundActivity: BackgroundActivity;
  /** Presets the camera director should weight up. */
  preferredPresetIds: string[];
  /** 0..1 default camera movement budget. */
  motionBudget: number;
  /** Typical runtime for this kind of post. */
  durationSec: number;
  /** Shots this format usually needs. Short social work is often 1-3. */
  shotCount: number;
  /** Descriptive phrases the compiler may use for aesthetic framing. */
  aestheticTags: string[];
  /** Words in the user's prompt that select this archetype. */
  triggers: string[];
}

export const SOCIAL_ARCHETYPE_PROFILES: readonly SocialArchetypeProfile[] = [
  {
    id: "influencer_ugc",
    label: "Influencer UGC",
    description: "Looks like a real creator filmed it on their phone between other things.",
    visualStyle: "authentic_ugc",
    colorGrade: "natural",
    mood: "playful",
    lighting: "practical_ambient",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "subtle",
    preferredPresetIds: ["handheld_iphone", "creator_ugc", "over_the_shoulder"],
    motionBudget: 0.45,
    durationSec: 8,
    shotCount: 2,
    aestheticTags: [
      "authentic vertical smartphone footage",
      "unstaged, in-the-moment feel",
      "natural social-media exposure, not colour graded",
    ],
    triggers: [
      "influencer",
      "ugc",
      "casual",
      "phone",
      "iphone",
      "selfie",
      "vlog",
      "real person",
      "gerçekçi",
      "telefonla",
      "günlük",
    ],
  },
  {
    id: "creator_pov",
    label: "Creator POV",
    description: "First-person perspective — the viewer is holding the phone.",
    visualStyle: "authentic_ugc",
    colorGrade: "natural",
    mood: "intimate",
    lighting: "practical_ambient",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "subtle",
    preferredPresetIds: ["over_the_shoulder", "creator_ugc", "handheld_iphone"],
    motionBudget: 0.5,
    durationSec: 8,
    shotCount: 2,
    aestheticTags: ["point-of-view framing", "the creator's hand enters frame naturally"],
    triggers: ["pov", "point of view", "first person", "my hands", "birinci şahıs"],
  },
  {
    id: "food_macro",
    label: "Food Macro",
    description: "Extreme close detail — texture, steam, condensation, pour.",
    visualStyle: "premium_social",
    colorGrade: "warm_film",
    mood: "refreshing",
    lighting: "soft_diffused",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "none",
    preferredPresetIds: ["food_closeup", "product_macro", "rack_focus", "tabletop_slide"],
    motionBudget: 0.22,
    durationSec: 8,
    shotCount: 2,
    aestheticTags: ["appetising macro detail", "razor-thin focus", "steam and condensation read clearly"],
    triggers: ["macro", "close up", "closeup", "food", "texture", "pour", "yakın çekim", "makro"],
  },
  {
    id: "premium_commercial",
    label: "Premium Commercial",
    description: "Brand-film quality: controlled light, deliberate camera, immaculate product.",
    visualStyle: "cinematic_commercial",
    colorGrade: "moody_contrast",
    mood: "premium",
    lighting: "studio_controlled",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "none",
    preferredPresetIds: ["static_luxury", "premium_product", "slow_push_in", "rack_focus"],
    motionBudget: 0.25,
    durationSec: 12,
    shotCount: 3,
    aestheticTags: ["high-end commercial cinematography", "controlled contrast", "deliberate negative space"],
    triggers: ["commercial", "premium", "luxury", "advert", "ad", "brand film", "reklam", "lüks"],
  },
  {
    id: "lifestyle_morning",
    label: "Morning Lifestyle",
    description: "Soft daylight, slow start-of-day energy, home or bright café.",
    visualStyle: "documentary_natural",
    colorGrade: "warm_film",
    mood: "calm",
    lighting: "natural_window",
    timeOfDay: "morning",
    backgroundActivity: "subtle",
    preferredPresetIds: ["subtle_handheld", "slow_push_in", "gentle_pan"],
    motionBudget: 0.3,
    durationSec: 12,
    shotCount: 3,
    aestheticTags: ["soft morning window light", "unhurried pacing", "warm domestic textures"],
    triggers: ["morning", "breakfast", "sunrise", "daylight", "sabah", "kahvaltı"],
  },
  {
    id: "night_cafe",
    label: "Night Café",
    description: "Warm practical lights against dark surroundings; glow and reflection.",
    visualStyle: "premium_social",
    colorGrade: "warm_film",
    mood: "cozy",
    lighting: "practical_ambient",
    timeOfDay: "night",
    backgroundActivity: "subtle",
    preferredPresetIds: ["handheld_iphone", "food_closeup", "subtle_handheld", "slow_push_in"],
    motionBudget: 0.28,
    durationSec: 10,
    shotCount: 2,
    aestheticTags: [
      "warm pendant lights glowing against a dark interior",
      "specular highlights on glass and wet surfaces",
      "shallow, intimate night atmosphere",
    ],
    triggers: ["night", "evening", "nighttime", "gece", "akşam", "neon", "dark"],
  },
  {
    id: "unboxing",
    label: "Unboxing",
    description: "Hands revealing a product; tactile, close, hand-forward.",
    visualStyle: "authentic_ugc",
    colorGrade: "cool_clean",
    mood: "energetic",
    lighting: "soft_diffused",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "none",
    preferredPresetIds: ["over_the_shoulder", "product_macro", "creator_ugc"],
    motionBudget: 0.4,
    durationSec: 10,
    shotCount: 3,
    aestheticTags: ["hands-first tactile reveal", "clean surface, product-centric framing"],
    triggers: ["unbox", "unboxing", "open the box", "reveal", "kutu açılımı"],
  },
  {
    id: "before_after",
    label: "Before / After",
    description: "Two matched states with a hard comparison beat.",
    visualStyle: "premium_social",
    colorGrade: "social_vibrant",
    mood: "energetic",
    lighting: "soft_diffused",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "none",
    preferredPresetIds: ["static_luxury", "rack_focus", "slow_push_in"],
    motionBudget: 0.2,
    durationSec: 10,
    shotCount: 2,
    aestheticTags: ["identical framing across both states", "clean comparison"],
    triggers: ["before after", "before and after", "transformation", "önce sonra"],
  },
  {
    id: "ambience_loop",
    label: "Ambience Loop",
    description: "A single slow, atmospheric shot designed to loop.",
    visualStyle: "documentary_natural",
    colorGrade: "muted_editorial",
    mood: "calm",
    lighting: "natural_window",
    timeOfDay: "indoor_neutral",
    backgroundActivity: "subtle",
    preferredPresetIds: ["static_luxury", "gentle_pan", "subtle_handheld"],
    motionBudget: 0.18,
    durationSec: 8,
    shotCount: 1,
    aestheticTags: ["meditative pacing", "one continuous unbroken take"],
    triggers: ["ambience", "ambient", "loop", "asmr", "relaxing", "atmosfer"],
  },
] as const;

const BY_ID = new Map(SOCIAL_ARCHETYPE_PROFILES.map((p) => [p.id, p]));

export function getArchetype(id: SocialArchetype): SocialArchetypeProfile {
  return BY_ID.get(id) ?? BY_ID.get("influencer_ugc")!;
}

export function listArchetypes(): readonly SocialArchetypeProfile[] {
  return SOCIAL_ARCHETYPE_PROFILES;
}

/** Platform words -> delivery format. Used by the heuristic director. */
export const FORMAT_TRIGGERS: ReadonlyArray<{ format: DeliveryFormat; triggers: string[] }> = [
  { format: "instagram_reel", triggers: ["reel", "reels", "instagram", "insta", "ig"] },
  { format: "instagram_story", triggers: ["story", "stories", "hikaye"] },
  { format: "tiktok", triggers: ["tiktok", "tik tok"] },
  { format: "youtube_short", triggers: ["short", "shorts", "youtube"] },
  { format: "instagram_feed", triggers: ["feed post", "grid post", "4:5"] },
  { format: "landscape_ad", triggers: ["landscape", "16:9", "youtube ad", "tv spot"] },
];

/**
 * Scores every archetype against the prompt and returns the winner.
 * Ties break toward `influencer_ugc`, which is the safest social default.
 */
export function detectArchetype(prompt: string): { archetype: SocialArchetype; score: number; matched: string[] } {
  const text = prompt.toLowerCase();
  let best: { archetype: SocialArchetype; score: number; matched: string[] } = {
    archetype: "influencer_ugc",
    score: 0,
    matched: [],
  };

  for (const profile of SOCIAL_ARCHETYPE_PROFILES) {
    const matched = profile.triggers.filter((t) => text.includes(t));
    // Multi-word triggers are far more specific than single words.
    const score = matched.reduce((sum, t) => sum + (t.includes(" ") ? 2.5 : 1), 0);
    if (score > best.score) best = { archetype: profile.id, score, matched };
  }
  return best;
}

export function detectFormat(prompt: string): DeliveryFormat | null {
  const text = prompt.toLowerCase();
  for (const entry of FORMAT_TRIGGERS) {
    if (entry.triggers.some((t) => text.includes(t))) return entry.format;
  }
  return null;
}
