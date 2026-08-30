import {
  referencesForShot,
  type ReferenceDirective,
  type SceneSubject,
  type Shot,
  type VideoGenerationSpec,
} from "@/lib/spec/spec";
import type { AspectRatio, BackgroundActivity, ColorGrade, LightingStyle, TimeOfDay, VisualStyle } from "@/lib/spec/vocab";
import { describeCamera } from "./camera-language";

/**
 * A PromptBlueprint is the *semantic* content of a prompt, before any model's
 * dialect is applied. Provider adapters render it; nothing else constructs
 * prompt strings.
 */
export interface PromptBlueprint {
  shotId: string;
  shotTitle: string;

  /** The single opening sentence that establishes medium, format and place. */
  headline: string;
  /** What is in frame, hero first. */
  subjects: string[];
  /** What happens. */
  action: string[];
  /** How reference images must be honoured. */
  references: string[];
  /** Camera work. */
  camera: string[];
  /** Light and colour. */
  lighting: string[];
  /** Movement and physics. */
  motion: string[];
  /** Environmental texture. */
  atmosphere: string[];
  /** Continuity locks. */
  consistency: string[];
  /** Realism constraints (affirmative). */
  realism: string[];
  /** Aesthetic/format framing. */
  aesthetic: string[];
  /** Negative constraints. */
  negatives: string[];
  /** Condensed keyword list, for models that respond to tags. */
  keywords: string[];
}

const STYLE_MEDIUM: Record<VisualStyle, string> = {
  authentic_ugc: "Authentic smartphone footage",
  premium_social: "Polished vertical social footage",
  cinematic_commercial: "Cinematic commercial footage",
  luxury_product: "High-end product film footage",
  documentary_natural: "Observational documentary footage",
  editorial_fashion: "Editorial fashion film footage",
};

const ASPECT_WORD: Record<AspectRatio, string> = {
  "9:16": "vertical",
  "4:5": "portrait",
  "1:1": "square",
  "16:9": "widescreen",
};

const TIME_WORD: Record<TimeOfDay, string> = {
  dawn: "at first light",
  morning: "in the morning",
  midday: "in the middle of the day",
  golden_hour: "during golden hour",
  dusk: "at dusk",
  night: "at night",
  indoor_neutral: "under even indoor light",
};

const LIGHTING_PHRASE: Record<LightingStyle, string> = {
  natural_window: "Soft daylight comes through a window, wrapping the subject and falling off gradually",
  practical_ambient: "The light comes from lamps and fixtures visible in the scene, pooling warm against darker surroundings",
  soft_diffused: "A large, soft key light wraps the subject with gentle, almost shadowless falloff",
  hard_directional: "A single hard source throws crisp, well-defined shadows",
  mixed_night_city: "Mixed street and neon light spills across the scene in competing colour temperatures",
  studio_controlled: "Controlled studio lighting shapes the subject cleanly against the background",
};

const GRADE_PHRASE: Record<ColorGrade, string> = {
  natural: "Colour is neutral and untreated, the way a phone records it",
  warm_film: "The grade is warm and filmic, with gentle highlight rolloff and rich shadow",
  cool_clean: "The grade is cool and clean, with crisp neutral whites",
  moody_contrast: "The grade is dark and contrasty, with deep shadows and controlled highlights",
  social_vibrant: "The grade is punchy and saturated in the way social video is",
  muted_editorial: "The grade is desaturated and editorial, with muted, restrained colour",
};

const BACKGROUND_PHRASE: Record<BackgroundActivity, string | null> = {
  none: "The background is quiet and uncluttered, with nothing competing for attention",
  subtle: "A few out-of-focus people move slowly in the background, adding life without pulling attention",
  moderate: "There is steady, believable activity behind the subject",
  busy: "The background is full of movement and life",
};

/**
 * Builds the blueprint for one shot.
 *
 * The ordering here matters: video models weight early tokens most heavily, so
 * medium and subject come first, then action, then reference adherence, then
 * craft, then constraints.
 */
export function buildBlueprint(spec: VideoGenerationSpec, shot: Shot): PromptBlueprint {
  const env = spec.scene.environment;
  const subjectsInShot = resolveSubjects(spec, shot);
  const hero = subjectsInShot.find((s) => s.hero) ?? subjectsInShot[0];
  const refs = referencesForShot(spec, shot.id);

  const headline =
    `${STYLE_MEDIUM[spec.creative.visualStyle]}, ${ASPECT_WORD[spec.delivery.aspectRatio]} format, ` +
    `filmed in ${env.setting} ${TIME_WORD[env.timeOfDay]}.`;

  // --- subjects -----------------------------------------------------------
  const subjects: string[] = [];
  if (hero) {
    subjects.push(`${capitalise(hero.description)} is the focus of the frame.`);
    for (const note of hero.identityNotes.slice(0, 4)) {
      subjects.push(`It has ${note}.`);
    }
  }
  for (const other of subjectsInShot.filter((s) => s !== hero)) {
    subjects.push(`Also in frame: ${other.description}.`);
  }

  // --- action -------------------------------------------------------------
  const action = [shot.action];

  // --- references ---------------------------------------------------------
  const references = describeReferences(refs);

  // --- camera -------------------------------------------------------------
  const cameraLanguage = describeCamera(shot.camera);
  const camera = [...cameraLanguage.lines];
  if (shot.camera.framingNotes) camera.push(shot.camera.framingNotes);

  // --- lighting -----------------------------------------------------------
  const lighting = [`${LIGHTING_PHRASE[env.lighting]}.`, `${GRADE_PHRASE[spec.creative.colorGrade]}.`];

  // --- motion -------------------------------------------------------------
  const motion: string[] = [];
  if (shot.motion.notes) motion.push(shot.motion.notes);
  if (shot.motion.physicsTags.length > 0) {
    motion.push(`Physical detail: ${shot.motion.physicsTags.join("; ")}.`);
  }
  const bg = BACKGROUND_PHRASE[shot.motion.environmentMotion];
  if (bg) motion.push(`${bg}.`);
  if (shot.motion.motionBlur !== "none") {
    motion.push(`Motion blur is ${shot.motion.motionBlur.replace(/_/g, " ")} and consistent with the shutter.`);
  }

  // --- atmosphere ---------------------------------------------------------
  const atmosphere = env.atmosphereNotes.map((n) => `${capitalise(n)}.`);

  // --- consistency --------------------------------------------------------
  const consistency = spec.consistency.continuityNotes.slice(0, 6);

  // --- aesthetic ----------------------------------------------------------
  const aesthetic = spec.creative.aestheticTags.slice(0, 4).map((t) => `${capitalise(t)}.`);

  return {
    shotId: shot.id,
    shotTitle: shot.title,
    headline,
    subjects,
    action,
    references,
    camera,
    lighting,
    motion,
    atmosphere,
    consistency,
    realism: shot.realism.positives,
    aesthetic,
    negatives: dedupe(shot.realism.negatives),
    keywords: buildKeywords(spec, shot, subjectsInShot),
  };
}

function resolveSubjects(spec: VideoGenerationSpec, shot: Shot): SceneSubject[] {
  const byKey = new Map(spec.scene.subjects.map((s) => [s.key, s]));
  const found = shot.featuredSubjectKeys
    .map((k) => byKey.get(k))
    .filter((s): s is SceneSubject => Boolean(s));
  return found.length > 0 ? found : spec.scene.subjects.slice(0, 1);
}

function describeReferences(refs: ReferenceDirective[]): string[] {
  const lines: string[] = [];
  for (const ref of refs) {
    const preserve = ref.preserve.slice(0, 4).join(", ");
    switch (ref.usage) {
      case "init_frame":
        lines.push(
          "The supplied image is the opening frame; the shot must begin from it exactly and evolve naturally from there.",
        );
        break;
      case "identity":
        lines.push(
          `Match the supplied ${ref.role.replace(/_/g, " ")} reference ${adverb(ref.adherence)}: ${preserve} must be preserved.`,
        );
        break;
      case "layout":
        lines.push(`Follow the supplied ${ref.role} reference for ${preserve}.`);
        break;
      case "style":
        lines.push(`Take colour palette, contrast and texture from the supplied style reference — content is not copied from it.`);
        break;
      case "descriptive_only":
        // The model has no image hook, so the words have to carry it. Uses the
        // model-facing description, not `notes` — notes explain provider
        // limitations to the operator and would be noise inside a prompt.
        lines.push(
          `Reproduce faithfully: ${ref.promptDescription || ref.label}. Preserve ${preserve}.`,
        );
        break;
    }
  }
  return lines;
}

function adverb(adherence: string): string {
  switch (adherence) {
    case "strict":
      return "exactly";
    case "normal":
      return "closely";
    case "light":
      return "loosely";
    default:
      return "";
  }
}

function buildKeywords(spec: VideoGenerationSpec, shot: Shot, subjects: SceneSubject[]): string[] {
  return dedupe([
    "photorealistic",
    "real footage",
    spec.creative.visualStyle.replace(/_/g, " "),
    spec.creative.colorGrade.replace(/_/g, " "),
    spec.scene.environment.timeOfDay.replace(/_/g, " "),
    spec.scene.environment.lighting.replace(/_/g, " "),
    shot.camera.shotSize.replace(/_/g, " "),
    shot.camera.primaryMove.replace(/_/g, " "),
    shot.camera.depthOfField.replace(/_/g, " ") + " depth of field",
    ...subjects.map((s) => s.description.split(",")[0]),
  ]);
}

/**
 * Trims a blueprint to fit a text-encoder budget.
 *
 * Sections are dropped in reverse importance. The scene, the action and the
 * reference-adherence instructions are never trimmed — losing those changes
 * what is generated, whereas losing an atmosphere note only makes it slightly
 * less textured. Camera and the top realism constraints are protected next,
 * because they are what separate this from a keyword prompt.
 */
export function trimBlueprint(
  blueprint: PromptBlueprint,
  budgetTokens: number,
  /**
   * Measures the *rendered* size. The compiler passes its real renderer, so
   * trimming accounts for the punctuation, labels and separators each dialect
   * adds — measuring the blueprint alone under-counts and overshoots the budget.
   */
  measure: (b: PromptBlueprint) => number = defaultMeasure,
): { blueprint: PromptBlueprint; trimmed: string[] } {
  const trimmed: string[] = [];
  const next: PromptBlueprint = { ...blueprint };
  const size = measure;

  // Ordered least- to most-important. Each step either drops a section or
  // shortens it to a floor that still carries its meaning.
  const steps: Array<{ label: string; apply: () => void }> = [
    { label: "aesthetic notes", apply: () => void (next.aesthetic = []) },
    // Reference prose is the first heavy thing to go on a tight budget. When a
    // reference is genuinely conditioning the model (an init frame) the words
    // are redundant; when it degraded to descriptive_only the words are a weak
    // substitute that costs more tokens than the signal they carry.
    {
      label: "reference detail",
      apply: () =>
        void (next.references = next.references.map((r) => r.split(". Preserve ")[0] + ".")),
    },
    { label: "atmosphere detail", apply: () => void (next.atmosphere = next.atmosphere.slice(0, 1)) },
    { label: "continuity notes", apply: () => void (next.consistency = next.consistency.slice(0, 2)) },
    { label: "physics detail", apply: () => void (next.motion = next.motion.slice(0, 2)) },
    { label: "negative constraints", apply: () => void (next.negatives = next.negatives.slice(0, 10)) },
    { label: "realism constraints", apply: () => void (next.realism = next.realism.slice(0, 8)) },
    { label: "atmosphere", apply: () => void (next.atmosphere = []) },
    { label: "continuity", apply: () => void (next.consistency = next.consistency.slice(0, 1)) },
    { label: "realism constraints", apply: () => void (next.realism = next.realism.slice(0, 5)) },
    { label: "negative constraints", apply: () => void (next.negatives = next.negatives.slice(0, 7)) },
    { label: "lighting detail", apply: () => void (next.lighting = next.lighting.slice(0, 1)) },
    { label: "camera detail", apply: () => void (next.camera = next.camera.slice(0, 3)) },
    { label: "subject detail", apply: () => void (next.subjects = next.subjects.slice(0, 2)) },
    { label: "secondary references", apply: () => void (next.references = next.references.slice(0, 1)) },
    // Below here the budget is genuinely tight (a CLIP-class 77-token encoder,
    // say). Keep cutting rather than let the model truncate arbitrarily.
    { label: "continuity", apply: () => void (next.consistency = []) },
    { label: "physics detail", apply: () => void (next.motion = next.motion.slice(0, 1)) },
    { label: "negative constraints", apply: () => void (next.negatives = next.negatives.slice(0, 5)) },
    { label: "realism constraints", apply: () => void (next.realism = next.realism.slice(0, 3)) },
    { label: "camera detail", apply: () => void (next.camera = next.camera.slice(0, 2)) },
    { label: "subject detail", apply: () => void (next.subjects = next.subjects.slice(0, 1)) },
    { label: "references", apply: () => void (next.references = []) },
    { label: "lighting", apply: () => void (next.lighting = []) },
    { label: "physics detail", apply: () => void (next.motion = []) },
    { label: "negative constraints", apply: () => void (next.negatives = next.negatives.slice(0, 3)) },
    { label: "realism constraints", apply: () => void (next.realism = next.realism.slice(0, 2)) },
    { label: "camera detail", apply: () => void (next.camera = next.camera.slice(0, 1)) },
  ];

  for (const step of steps) {
    if (size(next) <= budgetTokens) break;
    step.apply();
    if (!trimmed.includes(step.label)) trimmed.push(step.label);
  }

  return { blueprint: next, trimmed };
}

/** Crude fallback estimate: ~4 characters per token. */
function defaultMeasure(b: PromptBlueprint): number {
  const text = [
    b.headline,
    ...b.subjects,
    ...b.action,
    ...b.references,
    ...b.camera,
    ...b.lighting,
    ...b.motion,
    ...b.atmosphere,
    ...b.consistency,
    ...b.realism,
    ...b.aesthetic,
    ...b.negatives,
  ].join(" ");
  return Math.ceil(text.length / 4);
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}
