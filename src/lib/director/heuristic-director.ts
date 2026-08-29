import { clamp } from "@/lib/core/result";
import { DirectorBrief, type BriefBeat, type BriefSubject } from "@/lib/spec/brief";
import type { Mood, ShotPurpose, SubjectKind, TimeOfDay } from "@/lib/spec/vocab";
import { detectArchetype, detectFormat, getArchetype } from "@/lib/social/aesthetics";
import {
  ENVIRONMENT_TERMS,
  MOOD_TERMS,
  SUBJECT_TERMS,
  TIME_TERMS,
  containsTerm,
  detectDurationSec,
  detectLanguage,
} from "./lexicon";
import type { Director, DirectorInput, DirectorOutput } from "./types";

/**
 * The heuristic director.
 *
 * This is not a stub or a placeholder: it is a fully functional director that
 * requires no API key and no network. It is the deterministic floor of the
 * system, the fallback when the LLM director fails validation, and the thing
 * that makes `npm run dev` useful on day one.
 *
 * It is genuinely less nuanced than the LLM director — it cannot invent a
 * narrative the user did not imply — but it never produces an invalid brief.
 */
export class HeuristicDirector implements Director {
  readonly id = "heuristic" as const;

  async direct(input: DirectorInput): Promise<DirectorOutput> {
    const started = Date.now();
    const warnings: string[] = [];
    const text = input.prompt.toLowerCase();

    const language = detectLanguage(input.prompt);
    const detected = detectArchetype(input.prompt);
    const archetype = getArchetype(detected.archetype);
    if (detected.score === 0) {
      warnings.push("No style keywords found; defaulted to an authentic creator aesthetic.");
    }

    const brand = input.brand;
    const format = input.overrides.format ?? detectFormat(input.prompt) ?? brand?.defaults.format ?? "instagram_reel";
    const realismLevel = input.overrides.realismLevel ?? brand?.defaults.realismLevel ?? "high";

    const timeOfDay = detectTime(text) ?? inferTimeFromArchetype(archetype.timeOfDay);
    const environment = detectEnvironment(text);
    const subjects = detectSubjects(text, input);
    if (subjects.length === 0) {
      warnings.push("Could not identify a concrete subject; using a generic hero product.");
    }

    const durationSec = clamp(
      input.overrides.durationSec ?? detectDurationSec(input.prompt) ?? brand?.defaults.durationSec ?? archetype.durationSec,
      2,
      60,
    );

    const beats = buildBeats(subjects, archetype.id, durationSec);
    const shotCount = clamp(input.overrides.shotCount ?? Math.min(archetype.shotCount, beats.length), 1, 6);

    const mood: Mood = detectMood(text) ?? brand?.defaults.mood ?? archetype.mood;

    const candidate = {
      logline: buildLogline(subjects, environment.setting, timeOfDay, archetype.label),
      sourceLanguage: language,
      format,
      socialArchetype: archetype.id,
      visualStyle: brand?.defaults.visualStyle ?? archetype.visualStyle,
      colorGrade: brand?.defaults.colorGrade ?? archetype.colorGrade,
      mood,
      realismLevel,
      targetDurationSec: durationSec,
      suggestedShotCount: shotCount,
      environment: {
        setting: environment.setting,
        timeOfDay,
        lighting: timeOfDay === "night" ? "practical_ambient" : environment.lighting,
        backgroundActivity: archetype.backgroundActivity,
        atmosphereNotes: atmosphereFor(timeOfDay, environment.key),
      },
      subjects,
      beats,
      expectedReferenceRoles: input.referenceRoles,
      userAvoidances: [...(brand?.avoid ?? [])],
      rationale:
        `Heuristic director: matched "${archetype.label}" from ${detected.matched.length} keyword hit(s)` +
        `${detected.matched.length ? ` (${detected.matched.join(", ")})` : ""}; ` +
        `${subjects.length} subject(s) identified; ${durationSec}s across ${shotCount} shot(s).`,
    };

    // The heuristic director validates its own output too — a lexicon change
    // that breaks the schema must fail loudly here, not silently downstream.
    const brief = DirectorBrief.parse(candidate);

    return {
      brief,
      engine: "heuristic",
      model: null,
      fallbackUsed: false,
      warnings,
      elapsedMs: Date.now() - started,
    };
  }
}

function detectTime(text: string): TimeOfDay | null {
  for (const entry of TIME_TERMS) {
    if (entry.terms.some((t) => containsTerm(text, t))) return entry.time;
  }
  return null;
}

function inferTimeFromArchetype(fallback: TimeOfDay): TimeOfDay {
  return fallback;
}

function detectMood(text: string): Mood | null {
  for (const entry of MOOD_TERMS) {
    if (entry.terms.some((t) => containsTerm(text, t))) return entry.mood as Mood;
  }
  return null;
}

function detectEnvironment(text: string): { setting: string; lighting: (typeof ENVIRONMENT_TERMS)[number]["lighting"]; key: string } {
  for (const entry of ENVIRONMENT_TERMS) {
    if (entry.terms.some((t) => containsTerm(text, t))) {
      return { setting: entry.setting, lighting: entry.lighting, key: entry.key };
    }
  }
  return {
    setting: "a clean, softly lit interior with an uncluttered background",
    lighting: "soft_diffused",
    key: "generic",
  };
}

function detectSubjects(text: string, input: DirectorInput): BriefSubject[] {
  const found: BriefSubject[] = [];
  const seenKeys = new Set<string>();

  for (const term of SUBJECT_TERMS) {
    if (!term.terms.some((t) => containsTerm(text, t))) continue;
    if (seenKeys.has(term.key)) continue;
    // Don't add generic "coffee" when the specific "iced latte" already matched.
    if (term.key === "coffee" && seenKeys.has("iced_latte")) continue;
    if (term.key === "drink" && (seenKeys.has("iced_latte") || seenKeys.has("coffee") || seenKeys.has("tea"))) continue;

    seenKeys.add(term.key);
    found.push({
      key: term.key,
      kind: term.kind,
      description: term.description,
      hero: false,
      identityNotes: term.identityNotes ?? [],
    });
    if (found.length >= 5) break;
  }

  // A person filming something implies hands in frame even if unstated.
  const hasPerson = found.some((s) => s.kind === "human");
  const filming = /(film|record|shoot|çek|kaydet|holding|tutuyor)/.test(text);
  if (hasPerson && filming && !seenKeys.has("hands")) {
    found.push({
      key: "hands",
      kind: "hands",
      description: "the person's hand and forearm entering the frame as they hold their phone",
      hero: false,
      identityNotes: [],
    });
  }

  // Reference roles are strong evidence of what is actually in the video.
  if (input.referenceRoles.includes("product") && !found.some((s) => s.kind === "product")) {
    found.push({
      key: "reference_product",
      kind: "product",
      description: "the product shown in the supplied reference image",
      hero: false,
      identityNotes: ["matches the reference image exactly"],
    });
  }

  if (found.length === 0) {
    found.push({
      key: "hero_product",
      kind: "product",
      description: "the hero product presented cleanly as the focus of the frame",
      hero: false,
      identityNotes: [],
    });
  }

  // Elect a hero: prefer product/beverage/food over people — these are brand
  // videos, and the thing being sold is almost always the point.
  const heroPriority: SubjectKind[] = ["beverage", "food", "product", "vehicle", "human", "animal", "hands"];
  const heroIndex = found.reduce((best, subject, i) => {
    const rank = heroPriority.indexOf(subject.kind);
    const bestRank = heroPriority.indexOf(found[best].kind);
    return rank !== -1 && (bestRank === -1 || rank < bestRank) ? i : best;
  }, 0);
  found[heroIndex].hero = true;

  return found;
}

function atmosphereFor(timeOfDay: TimeOfDay, envKey: string): string[] {
  const notes: string[] = [];
  if (timeOfDay === "night") {
    notes.push("warm practical lights glowing against a dark interior", "soft specular highlights on glass surfaces");
  }
  if (timeOfDay === "morning" || timeOfDay === "dawn") {
    notes.push("soft directional daylight from a window", "gentle dust in the light");
  }
  if (envKey === "cafe" || envKey === "restaurant") {
    notes.push("blurred background customers and staff moving slowly");
  }
  if (envKey === "street") notes.push("out-of-focus traffic and signage behind the subject");
  return notes.slice(0, 4);
}

/** Builds a small, coherent narrative from the subjects that were found. */
function buildBeats(subjects: BriefSubject[], archetypeId: string, durationSec: number): BriefBeat[] {
  const hero = subjects.find((s) => s.hero) ?? subjects[0];
  const person = subjects.find((s) => s.kind === "human");
  const hands = subjects.find((s) => s.kind === "hands");

  const beats: BriefBeat[] = [];

  if (durationSec >= 6) {
    beats.push({
      purpose: "establishing" as ShotPurpose,
      action: `The scene is revealed with ${hero.description} sitting naturally on the surface.`,
      featured: [hero.key, ...(person ? [person.key] : [])],
      suggestedShotSize: "medium",
      weight: 1,
    });
  }

  if (person || hands) {
    beats.push({
      purpose: "interaction" as ShotPurpose,
      action: person
        ? `${capitalise(person.description)} casually interacts with ${hero.description} without looking staged.`
        : `Hands reach into frame and interact with ${hero.description}.`,
      featured: [hero.key, ...(person ? [person.key] : []), ...(hands ? [hands.key] : [])],
      suggestedShotSize: "medium_close_up",
      weight: 1.1,
    });
  }

  beats.push({
    purpose: "product_hero" as ShotPurpose,
    action: `${capitalise(hero.description)} holds the frame as the clear focus of the shot.`,
    featured: [hero.key],
    suggestedShotSize: archetypeId === "food_macro" ? "macro" : "close_up",
    weight: 1.4,
  });

  if (durationSec >= 12) {
    beats.push({
      purpose: "detail" as ShotPurpose,
      action: `An extreme close view of ${hero.description}, holding on its surface texture.`,
      featured: [hero.key],
      suggestedShotSize: "macro",
      weight: 0.9,
    });
  }

  return beats.slice(0, 5);
}

function buildLogline(subjects: BriefSubject[], setting: string, timeOfDay: TimeOfDay, archetypeLabel: string): string {
  const hero = subjects.find((s) => s.hero) ?? subjects[0];
  const when = timeOfDay.replace(/_/g, " ");
  const line = `${archetypeLabel} piece: ${hero.description} in ${setting.split(",")[0]} at ${when}.`;
  return line.slice(0, 240);
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
