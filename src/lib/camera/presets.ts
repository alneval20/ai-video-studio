import type {
  CameraAngle,
  CameraDevice,
  CameraHeight,
  CameraMove,
  DepthOfField,
  FocusBehavior,
  ShotPurpose,
  ShotSize,
  SocialArchetype,
  SubjectKind,
  VisualStyle,
} from "@/lib/spec/vocab";

/**
 * A camera preset is a parameter set, not a label.
 *
 * The prompt compiler never injects `preset.id` into a prompt — it reads these
 * numbers and produces model-appropriate prose. That is what stops the system
 * degrading into "cinematic shot, dolly zoom, 8k" keyword soup.
 */
export interface CameraPreset {
  id: string;
  label: string;
  /** One line for the Advanced panel. */
  description: string;

  device: CameraDevice;
  defaultShotSize: ShotSize;
  angle: CameraAngle;
  height: CameraHeight;

  primaryMove: CameraMove;
  secondaryMove: CameraMove | null;

  /** 0 = imperceptible drift, 1 = dramatic. Deliberately low across the board. */
  moveIntensity: number;
  /** 0 = glacial, 1 = fast. */
  moveSpeed: number;
  /** 1 = tripod-locked, 0 = loose handheld. */
  stability: number;
  /** Human breathing/micro-shake. The single biggest "is this real?" signal. */
  microJitter: number;

  focalLengthMm: number;
  depthOfField: DepthOfField;
  focusBehavior: FocusBehavior;
  subjectDistanceM: number;
  parallax: number;

  /** Where this preset belongs tonally. */
  feel: "social" | "commercial" | "documentary";

  framingNotes: string;

  /** Scoring hints used by the camera director. */
  affinity: {
    purposes: ShotPurpose[];
    subjectKinds: SubjectKind[];
    archetypes: SocialArchetype[];
    styles: VisualStyle[];
  };
}

/**
 * Design note on movement budgets:
 *
 * The dominant failure mode of generative video is a camera that flies, orbits
 * or swoops in ways no operator could produce, which instantly reads as AI.
 * So every preset here caps `moveIntensity` at 0.55, and only `walking_follow`
 * and `orbit`-flavoured presets exceed 0.4. Realism comes from restraint plus
 * micro-jitter, not from big moves.
 */
export const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    id: "handheld_iphone",
    label: "Handheld iPhone",
    description: "Phone held in one hand, natural micro-shake, believable autofocus.",
    device: "modern_smartphone",
    defaultShotSize: "medium_close_up",
    angle: "eye_level",
    height: "chest",
    primaryMove: "handheld_drift",
    secondaryMove: "push_in",
    moveIntensity: 0.22,
    moveSpeed: 0.3,
    stability: 0.45,
    microJitter: 0.75,
    focalLengthMm: 26,
    depthOfField: "moderate",
    focusBehavior: "autofocus_natural",
    subjectDistanceM: 0.8,
    parallax: 0.35,
    feel: "social",
    framingNotes: "Subject slightly off-centre, casual headroom, occasional small reframe.",
    affinity: {
      purposes: ["establishing", "interaction", "reaction", "atmosphere"],
      subjectKinds: ["human", "hands", "beverage", "food", "product"],
      archetypes: ["influencer_ugc", "creator_pov", "night_cafe", "lifestyle_morning"],
      styles: ["authentic_ugc", "premium_social", "documentary_natural"],
    },
  },
  {
    id: "creator_ugc",
    label: "Creator UGC",
    description: "Arm's-length phone footage, unstaged energy, slight tilt as the hand moves.",
    device: "modern_smartphone",
    defaultShotSize: "medium",
    angle: "three_quarter",
    height: "chest",
    primaryMove: "handheld_drift",
    secondaryMove: "tilt_down",
    moveIntensity: 0.3,
    moveSpeed: 0.4,
    stability: 0.35,
    microJitter: 0.85,
    focalLengthMm: 24,
    depthOfField: "moderate",
    focusBehavior: "autofocus_natural",
    subjectDistanceM: 0.6,
    parallax: 0.4,
    feel: "social",
    framingNotes: "Imperfect framing, subject drifts within frame, no rule-of-thirds precision.",
    affinity: {
      purposes: ["interaction", "reaction", "reveal"],
      subjectKinds: ["human", "hands", "product"],
      archetypes: ["influencer_ugc", "creator_pov", "unboxing"],
      styles: ["authentic_ugc", "premium_social"],
    },
  },
  {
    id: "subtle_handheld",
    label: "Subtle Handheld",
    description: "Operator-steady handheld — alive but controlled. The safe default.",
    device: "mirrorless_prime",
    defaultShotSize: "medium_close_up",
    angle: "eye_level",
    height: "chest",
    primaryMove: "handheld_drift",
    secondaryMove: null,
    moveIntensity: 0.15,
    moveSpeed: 0.25,
    stability: 0.7,
    microJitter: 0.45,
    focalLengthMm: 35,
    depthOfField: "shallow",
    focusBehavior: "breathing_shallow",
    subjectDistanceM: 1.2,
    parallax: 0.25,
    feel: "documentary",
    framingNotes: "Steady composition with faint life in the frame edges.",
    affinity: {
      purposes: ["establishing", "atmosphere", "interaction", "detail"],
      subjectKinds: ["human", "product", "food", "beverage", "environment"],
      archetypes: ["lifestyle_morning", "night_cafe", "ambience_loop", "premium_commercial"],
      styles: ["premium_social", "documentary_natural", "cinematic_commercial"],
    },
  },
  {
    id: "slow_push_in",
    label: "Slow Push In",
    description: "Gradual, gentle move toward the subject. Builds focus without drama.",
    device: "gimbal_rig",
    defaultShotSize: "medium_close_up",
    angle: "eye_level",
    height: "table_level",
    primaryMove: "push_in",
    secondaryMove: null,
    moveIntensity: 0.28,
    moveSpeed: 0.2,
    stability: 0.9,
    microJitter: 0.12,
    focalLengthMm: 50,
    depthOfField: "shallow",
    focusBehavior: "locked",
    subjectDistanceM: 0.9,
    parallax: 0.5,
    feel: "commercial",
    framingNotes: "Subject centred, framing tightens by roughly 15% over the shot.",
    affinity: {
      purposes: ["product_hero", "reveal", "payoff", "detail"],
      subjectKinds: ["product", "food", "beverage", "text_or_logo"],
      archetypes: ["premium_commercial", "food_macro", "night_cafe"],
      styles: ["cinematic_commercial", "premium_social", "luxury_product"],
    },
  },
  {
    id: "slow_pull_out",
    label: "Slow Pull Out",
    description: "Gentle retreat revealing context around the subject.",
    device: "gimbal_rig",
    defaultShotSize: "medium",
    angle: "eye_level",
    height: "chest",
    primaryMove: "pull_out",
    secondaryMove: null,
    moveIntensity: 0.3,
    moveSpeed: 0.22,
    stability: 0.88,
    microJitter: 0.14,
    focalLengthMm: 35,
    depthOfField: "moderate",
    focusBehavior: "locked",
    subjectDistanceM: 1.4,
    parallax: 0.55,
    feel: "commercial",
    framingNotes: "Starts tight on the subject, widens to include the environment.",
    affinity: {
      purposes: ["establishing", "payoff", "atmosphere"],
      subjectKinds: ["environment", "product", "human"],
      archetypes: ["premium_commercial", "lifestyle_morning", "ambience_loop"],
      styles: ["cinematic_commercial", "documentary_natural", "editorial_fashion"],
    },
  },
  {
    id: "product_macro",
    label: "Product Macro",
    description: "Extremely close, razor-thin focus plane, near-static. Texture is the subject.",
    device: "macro_rig",
    defaultShotSize: "macro",
    angle: "three_quarter",
    height: "table_level",
    primaryMove: "push_in",
    secondaryMove: null,
    moveIntensity: 0.1,
    moveSpeed: 0.12,
    stability: 0.96,
    microJitter: 0.05,
    focalLengthMm: 100,
    depthOfField: "very_shallow",
    focusBehavior: "locked",
    subjectDistanceM: 0.18,
    parallax: 0.7,
    feel: "commercial",
    framingNotes: "Fills the frame with one surface — condensation, crema, grain, stitching.",
    affinity: {
      purposes: ["detail", "product_hero"],
      subjectKinds: ["product", "food", "beverage", "liquid", "text_or_logo"],
      archetypes: ["food_macro", "premium_commercial", "unboxing"],
      styles: ["luxury_product", "cinematic_commercial", "editorial_fashion"],
    },
  },
  {
    id: "food_closeup",
    label: "Food Close-Up",
    description: "Appetising near-macro with a slow drift and warm falloff.",
    device: "mirrorless_prime",
    defaultShotSize: "close_up",
    angle: "three_quarter",
    height: "table_level",
    primaryMove: "slide_left",
    secondaryMove: "push_in",
    moveIntensity: 0.18,
    moveSpeed: 0.18,
    stability: 0.85,
    microJitter: 0.18,
    focalLengthMm: 65,
    depthOfField: "very_shallow",
    focusBehavior: "rack_to_subject",
    subjectDistanceM: 0.35,
    parallax: 0.6,
    feel: "commercial",
    framingNotes: "Hero item on the near focal plane, everything else dissolving.",
    affinity: {
      purposes: ["detail", "product_hero", "payoff"],
      subjectKinds: ["food", "beverage", "liquid"],
      archetypes: ["food_macro", "night_cafe", "premium_commercial"],
      styles: ["premium_social", "cinematic_commercial", "luxury_product"],
    },
  },
  {
    id: "tabletop_slide",
    label: "Tabletop Slide",
    description: "Low lateral glide across a table surface, strong foreground parallax.",
    device: "gimbal_rig",
    defaultShotSize: "close_up",
    angle: "eye_level",
    height: "table_level",
    primaryMove: "slide_right",
    secondaryMove: null,
    moveIntensity: 0.32,
    moveSpeed: 0.28,
    stability: 0.92,
    microJitter: 0.08,
    focalLengthMm: 40,
    depthOfField: "shallow",
    focusBehavior: "locked",
    subjectDistanceM: 0.4,
    parallax: 0.8,
    feel: "commercial",
    framingNotes: "Objects pass through the near foreground as the camera travels.",
    affinity: {
      purposes: ["establishing", "product_hero", "atmosphere"],
      subjectKinds: ["product", "food", "beverage", "prop"],
      archetypes: ["premium_commercial", "food_macro", "night_cafe"],
      styles: ["cinematic_commercial", "luxury_product"],
    },
  },
  {
    id: "over_the_shoulder",
    label: "Over The Shoulder",
    description: "Framed past a person's shoulder onto what they're looking at.",
    device: "mirrorless_prime",
    defaultShotSize: "medium",
    angle: "three_quarter",
    height: "eye",
    primaryMove: "handheld_drift",
    secondaryMove: "push_in",
    moveIntensity: 0.2,
    moveSpeed: 0.25,
    stability: 0.6,
    microJitter: 0.5,
    focalLengthMm: 45,
    depthOfField: "shallow",
    focusBehavior: "rack_to_subject",
    subjectDistanceM: 1.1,
    parallax: 0.45,
    feel: "documentary",
    framingNotes: "Soft shoulder/arm occupies one third of the frame in the foreground.",
    affinity: {
      purposes: ["interaction", "reveal", "reaction"],
      subjectKinds: ["human", "hands", "product", "food"],
      archetypes: ["creator_pov", "influencer_ugc", "unboxing"],
      styles: ["authentic_ugc", "documentary_natural", "premium_social"],
    },
  },
  {
    id: "rack_focus",
    label: "Rack Focus",
    description: "Focus shifts between two planes — foreground detail to hero, or back.",
    device: "cinema_camera",
    defaultShotSize: "close_up",
    angle: "eye_level",
    height: "table_level",
    primaryMove: "static",
    secondaryMove: "rack_focus",
    moveIntensity: 0.06,
    moveSpeed: 0.35,
    stability: 0.95,
    microJitter: 0.06,
    focalLengthMm: 85,
    depthOfField: "very_shallow",
    focusBehavior: "rack_to_subject",
    subjectDistanceM: 0.6,
    parallax: 0.2,
    feel: "commercial",
    framingNotes: "Composition holds still; only the focal plane moves.",
    affinity: {
      purposes: ["reveal", "detail", "product_hero"],
      subjectKinds: ["product", "food", "beverage", "text_or_logo", "human"],
      archetypes: ["premium_commercial", "food_macro", "before_after"],
      styles: ["cinematic_commercial", "luxury_product", "editorial_fashion"],
    },
  },
  {
    id: "gentle_pan",
    label: "Gentle Pan",
    description: "Slow horizontal sweep across a scene from a fixed position.",
    device: "gimbal_rig",
    defaultShotSize: "wide",
    angle: "eye_level",
    height: "chest",
    primaryMove: "pan_right",
    secondaryMove: null,
    moveIntensity: 0.26,
    moveSpeed: 0.2,
    stability: 0.9,
    microJitter: 0.12,
    focalLengthMm: 28,
    depthOfField: "deep",
    focusBehavior: "locked",
    subjectDistanceM: 3,
    parallax: 0.3,
    feel: "documentary",
    framingNotes: "Environment reads first; the hero enters frame as the pan settles.",
    affinity: {
      purposes: ["establishing", "atmosphere"],
      subjectKinds: ["environment", "human", "prop"],
      archetypes: ["night_cafe", "lifestyle_morning", "ambience_loop"],
      styles: ["documentary_natural", "cinematic_commercial", "premium_social"],
    },
  },
  {
    id: "walking_follow",
    label: "Walking Follow",
    description: "Camera travels with a moving subject. The most motion this system allows.",
    device: "gimbal_rig",
    defaultShotSize: "medium",
    angle: "eye_level",
    height: "chest",
    primaryMove: "follow",
    secondaryMove: "handheld_drift",
    moveIntensity: 0.55,
    moveSpeed: 0.5,
    stability: 0.65,
    microJitter: 0.5,
    focalLengthMm: 30,
    depthOfField: "moderate",
    focusBehavior: "autofocus_natural",
    subjectDistanceM: 1.6,
    parallax: 0.75,
    feel: "documentary",
    framingNotes: "Subject held at a constant size while the background streams past.",
    affinity: {
      purposes: ["interaction", "establishing", "payoff"],
      subjectKinds: ["human", "animal", "vehicle"],
      archetypes: ["creator_pov", "lifestyle_morning", "influencer_ugc"],
      styles: ["documentary_natural", "authentic_ugc", "cinematic_commercial"],
    },
  },
  {
    id: "static_luxury",
    label: "Static Luxury",
    description: "Locked off, immaculate, almost still — the product does the work.",
    device: "cinema_camera",
    defaultShotSize: "medium_close_up",
    angle: "eye_level",
    height: "table_level",
    primaryMove: "static",
    secondaryMove: null,
    moveIntensity: 0.03,
    moveSpeed: 0.05,
    stability: 1,
    microJitter: 0.02,
    focalLengthMm: 85,
    depthOfField: "shallow",
    focusBehavior: "locked",
    subjectDistanceM: 1,
    parallax: 0.1,
    feel: "commercial",
    framingNotes: "Perfectly balanced, generous negative space, nothing moves but the subject.",
    affinity: {
      purposes: ["product_hero", "payoff", "detail"],
      subjectKinds: ["product", "text_or_logo", "food", "beverage"],
      archetypes: ["premium_commercial", "before_after"],
      styles: ["luxury_product", "cinematic_commercial", "editorial_fashion"],
    },
  },
  {
    id: "premium_product",
    label: "Premium Product",
    description: "Slow arc around a hero object, controlled and short — never a full orbit.",
    device: "gimbal_rig",
    defaultShotSize: "close_up",
    angle: "three_quarter",
    height: "table_level",
    primaryMove: "orbit_slow",
    secondaryMove: null,
    moveIntensity: 0.38,
    moveSpeed: 0.22,
    stability: 0.94,
    microJitter: 0.06,
    focalLengthMm: 60,
    depthOfField: "shallow",
    focusBehavior: "locked",
    subjectDistanceM: 0.5,
    parallax: 0.65,
    feel: "commercial",
    framingNotes: "Arc of roughly 20-30 degrees only, so highlights travel across the surface.",
    affinity: {
      purposes: ["product_hero", "reveal", "payoff"],
      subjectKinds: ["product", "beverage", "text_or_logo"],
      archetypes: ["premium_commercial", "unboxing", "food_macro"],
      styles: ["luxury_product", "cinematic_commercial"],
    },
  },
] as const;

const BY_ID = new Map(CAMERA_PRESETS.map((p) => [p.id, p]));

export function getCameraPreset(id: string): CameraPreset | undefined {
  return BY_ID.get(id);
}

export function listCameraPresets(): readonly CameraPreset[] {
  return CAMERA_PRESETS;
}

export const DEFAULT_PRESET_ID = "subtle_handheld";
