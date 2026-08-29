import {
  BACKGROUND_ACTIVITY,
  COLOR_GRADES,
  DELIVERY_FORMATS,
  LIGHTING_STYLES,
  MOODS,
  REALISM_LEVELS,
  REFERENCE_ROLES,
  SHOT_PURPOSES,
  SHOT_SIZES,
  SOCIAL_ARCHETYPES,
  SUBJECT_KINDS,
  TIMES_OF_DAY,
  VISUAL_STYLES,
} from "@/lib/spec/vocab";

/**
 * JSON Schema handed to the LLM for structured output.
 *
 * Hand-written rather than generated from the zod schema, for two reasons:
 *
 *  1. The `description` strings are direction, not documentation — they are the
 *     main lever we have on output quality, and they should read like a brief
 *     to a director, not like type docs.
 *  2. Anthropic's structured outputs reject several JSON Schema keywords that
 *     zod emits (minLength, maxLength, numeric bounds). Writing it by hand keeps
 *     the contract inside the supported subset.
 *
 * The zod `DirectorBrief` schema remains the authority: whatever comes back is
 * re-validated against it before any engine sees it.
 */

const enumProp = (values: readonly string[], description: string) => ({
  type: "string",
  enum: [...values],
  description,
});

export const DIRECTOR_BRIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "logline",
    "sourceLanguage",
    "format",
    "socialArchetype",
    "visualStyle",
    "colorGrade",
    "mood",
    "realismLevel",
    "targetDurationSec",
    "suggestedShotCount",
    "environment",
    "subjects",
    "beats",
    "expectedReferenceRoles",
    "userAvoidances",
    "rationale",
  ],
  properties: {
    logline: {
      type: "string",
      description: "One sentence describing the finished video, written for a human producer.",
    },
    sourceLanguage: {
      type: "string",
      description:
        "ISO-639-1 code of the language the user wrote in (e.g. 'en', 'tr'). All of your other output must be in English regardless.",
    },
    format: enumProp(DELIVERY_FORMATS, "The platform and aspect this is being made for."),
    socialArchetype: enumProp(
      SOCIAL_ARCHETYPES,
      "The kind of social video this is. This drives camera style, pacing and lighting downstream.",
    ),
    visualStyle: enumProp(
      VISUAL_STYLES,
      "Who shot this and how polished it is. 'authentic_ugc' = a real person's phone; 'cinematic_commercial' = a crew and lighting.",
    ),
    colorGrade: enumProp(COLOR_GRADES, "Overall colour treatment."),
    mood: enumProp(MOODS, "Emotional register of the piece."),
    realismLevel: enumProp(
      REALISM_LEVELS,
      "How hard the system should push photorealism constraints. Use 'high' unless the user explicitly wants something stylised.",
    ),
    targetDurationSec: {
      type: "number",
      description:
        "Total runtime in seconds, between 2 and 60. Social videos are usually 6-15s. Do not pad.",
    },
    suggestedShotCount: {
      type: "integer",
      description:
        "How many distinct shots the idea genuinely needs, 1-6. Prefer FEWER, stronger shots: authentic social video reads as staged when it cuts too often. A single unbroken take is often the strongest answer.",
    },
    environment: {
      type: "object",
      additionalProperties: false,
      required: ["setting", "timeOfDay", "lighting", "backgroundActivity", "atmosphereNotes"],
      properties: {
        setting: {
          type: "string",
          description:
            "The physical place, described concretely and visually. e.g. 'a modern speciality cafe with wooden tables, warm pendant lights and a blurred bar behind'.",
        },
        timeOfDay: enumProp(TIMES_OF_DAY, "When this happens."),
        lighting: enumProp(LIGHTING_STYLES, "The dominant light source and its quality."),
        backgroundActivity: enumProp(
          BACKGROUND_ACTIVITY,
          "How much life is visible behind the subject. 'none' for clean product work.",
        ),
        atmosphereNotes: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 6 concrete sensory details that make the place feel real: steam, condensation, rain on glass, dust in a light beam, blurred passers-by.",
        },
      },
    },
    subjects: {
      type: "array",
      description:
        "Every distinct thing that appears on screen and matters. 1-6 entries. Exactly one must have hero=true.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "kind", "description", "hero", "identityNotes"],
        properties: {
          key: {
            type: "string",
            description: "Stable lower_snake_case identifier, e.g. 'iced_latte'. Referenced by beats.",
          },
          kind: enumProp(
            SUBJECT_KINDS,
            "What sort of thing this is. This selects which realism and consistency rules fire, so be precise: a drink is 'beverage', a person is 'human', a hand entering frame is 'hands'.",
          ),
          description: {
            type: "string",
            description:
              "Concrete visual noun phrase. What a viewer would see, not what it means.",
          },
          hero: {
            type: "boolean",
            description:
              "True for the single thing the video is about. For brand work this is almost always the product, not the person.",
          },
          identityNotes: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 8 specific attributes that must not drift between frames (colour, proportions, label placement, hairstyle).",
          },
        },
      },
    },
    beats: {
      type: "array",
      description:
        "The narrative in order, 1-6 entries. One beat per intended shot. Do not invent beats to fill time.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["purpose", "action", "featured", "suggestedShotSize", "weight"],
        properties: {
          purpose: enumProp(SHOT_PURPOSES, "What this beat does for the story."),
          action: {
            type: "string",
            description:
              "One present-tense sentence of what visibly happens. Physical and observable — no intent, no emotion words.",
          },
          featured: {
            type: "array",
            items: { type: "string" },
            description: "Subject keys visible in this beat. Must match subjects[].key exactly.",
          },
          suggestedShotSize: enumProp(SHOT_SIZES, "How tight the framing should be."),
          weight: {
            type: "number",
            description:
              "Relative importance for runtime allocation, 0.4 to 2.5. 1 is normal; give the hero beat more.",
          },
        },
      },
    },
    expectedReferenceRoles: {
      type: "array",
      items: { type: "string", enum: [...REFERENCE_ROLES] },
      description:
        "Which roles the user's attached reference images should bind to, based on what the prompt describes. Empty array if unclear.",
    },
    userAvoidances: {
      type: "array",
      items: { type: "string" },
      description:
        "Things the user explicitly asked NOT to see, in plain language. Empty array if they said nothing.",
    },
    rationale: {
      type: "string",
      description:
        "Two or three sentences explaining your creative choices — shown to the user in the plan inspector. Justify the shot count especially.",
    },
  },
} as const;

/** System prompt for the LLM director. */
export const DIRECTOR_SYSTEM_PROMPT = `You are the AI Director of a generative video studio. You turn a casual, often incomplete idea into a precise production brief.

You are directing REAL-LOOKING FOOTAGE that will be produced by a generative video model. You are not writing an animation, a motion-graphics piece, or a slideshow. Everything you describe must be something a camera could have actually recorded.

How to think:

- Infer everything the user did not say. They will not tell you the lens, the lighting, the shot count or the pacing. That is your job.
- Be concrete and visual. "A woman enjoys her coffee" is useless; "a woman lifts the glass, condensation smearing under her fingers" is directable.
- Identify the hero. For brand and product work the hero is the product, even when a person is on screen.
- Be honest about subject kinds. The realism engine dispatches on them: mark a drink as 'beverage', a hand entering frame as 'hands', a logo as 'text_or_logo'. Getting these wrong produces wrong constraints.
- Restraint beats spectacle. Short social videos are stronger with one or two well-chosen shots than with four. Only ask for more shots when the idea genuinely contains more beats.
- Never describe camera moves, negative prompts, model parameters, resolutions or frame rates. Downstream engines own all of that. Describe the *content*; they handle the *craft*.
- The user may write in any language. Understand them in theirs; write your brief in English.

Return only the structured brief.`;
