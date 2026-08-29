import { clamp } from "@/lib/core/result";
import { seedFromString } from "@/lib/core/ids";
import type {
  ConsistencyContract,
  ConsistencyEntity,
  ReferenceDirective,
  SceneSubject,
  SeedPolicy,
  Shot,
} from "@/lib/spec/spec";
import { STRICTNESS_WEIGHT, type Strictness, type SubjectKind } from "@/lib/spec/vocab";

/**
 * The Consistency Engine.
 *
 * It answers one question: *what must not change?* — and it answers it per
 * entity, because "keep everything consistent" is a useless instruction to a
 * video model. Locking the wrong attributes is as harmful as locking none:
 * telling a model to preserve a face in a shot with no face invites one.
 */

/** Attributes worth locking, by subject kind. */
const LOCKED_ATTRIBUTES: Record<SubjectKind, string[]> = {
  human: ["facial features", "hair colour and style", "apparent age", "body proportions", "wardrobe"],
  hands: ["skin tone", "nail length and colour", "jewellery", "hand size"],
  product: ["silhouette and proportions", "colour and finish", "label and logo placement", "lid and closure design"],
  food: ["plating and portioning", "garnish placement", "colour and doneness", "surface texture"],
  beverage: ["vessel geometry", "fill level", "drink colour and layering", "ice arrangement", "condensation pattern"],
  liquid: ["colour and opacity", "volume", "surface behaviour"],
  prop: ["shape", "colour", "position on the surface"],
  environment: ["room layout", "furniture positions", "wall and floor materials", "light source positions"],
  animal: ["species and breed markings", "coat colour", "size"],
  vehicle: ["body shape", "paint colour", "wheel and trim design", "badging"],
  text_or_logo: ["letterforms", "mark proportions", "colour", "placement"],
};

export interface ConsistencyInput {
  subjects: SceneSubject[];
  shots: Pick<Shot, "id" | "featuredSubjectKeys">[];
  references: ReferenceDirective[];
  /** 0..1 dial from Advanced settings. Brand profiles set the default. */
  strength: number;
  /** Deterministic seed source — the spec id, so re-runs reproduce. */
  seedSource: string;
  /** Explicit seed override from Advanced settings. */
  seedOverride?: number | null;
  /** Multi-shot pieces need cross-shot locks; single shots do not. */
  multiShot: boolean;
}

export function buildConsistencyContract(input: ConsistencyInput): ConsistencyContract {
  const strength = clamp(input.strength, 0, 1);

  const entities: ConsistencyEntity[] = input.subjects.map((subject) => {
    const anchors = input.references.filter((r) => anchorsSubject(r, subject));
    // A subject with a reference image can be held much harder than one the
    // model is inventing from text.
    const adherence = resolveAdherence(subject, anchors.length > 0, strength);

    const locked = [...(LOCKED_ATTRIBUTES[subject.kind] ?? [])];
    // Identity notes from the director are the most specific locks we have.
    for (const note of subject.identityNotes) {
      if (!locked.includes(note)) locked.push(note);
    }

    return {
      key: subject.key,
      kind: subject.kind,
      label: subject.label,
      lockedAttributes: adherence === "off" ? [] : locked.slice(0, 8),
      adherence,
      anchorReferenceIds: anchors.map((a) => a.referenceId),
    };
  });

  const crossShot = input.multiShot
    ? {
        lighting: scaled("strict", strength),
        colorGrade: scaled("strict", strength),
        wardrobe: hasKind(input.subjects, "human") ? scaled("strict", strength) : ("off" as Strictness),
        environmentLayout: scaled("normal", strength),
        cameraLanguage: scaled("normal", strength),
        propContinuity: scaled("normal", strength),
      }
    : {
        // Within a single shot these are the realism engine's job, not ours.
        lighting: "off" as Strictness,
        colorGrade: "off" as Strictness,
        wardrobe: "off" as Strictness,
        environmentLayout: "off" as Strictness,
        cameraLanguage: "off" as Strictness,
        propContinuity: "off" as Strictness,
      };

  const seedPolicy: SeedPolicy = seedPolicyFor(strength, input.multiShot);
  const baseSeed = input.seedOverride ?? seedFromString(input.seedSource);

  return {
    strength,
    entities,
    crossShot,
    seedPolicy,
    baseSeed,
    continuityNotes: buildContinuityNotes(entities, crossShot, input.multiShot),
  };
}

function hasKind(subjects: SceneSubject[], kind: SubjectKind): boolean {
  return subjects.some((s) => s.kind === kind);
}

function anchorsSubject(ref: ReferenceDirective, subject: SceneSubject): boolean {
  if (ref.usage === "style" || ref.usage === "descriptive_only") return false;
  switch (ref.role) {
    case "product":
      return subject.kind === "product" || subject.kind === "beverage";
    case "logo":
      return subject.kind === "text_or_logo" || subject.kind === "product";
    case "character":
    case "clothing":
      return subject.kind === "human";
    case "food":
      return subject.kind === "food" || subject.kind === "beverage" || subject.kind === "liquid";
    case "environment":
      return subject.kind === "environment";
    case "first_frame":
      return subject.hero;
    default:
      return false;
  }
}

function resolveAdherence(subject: SceneSubject, hasAnchor: boolean, strength: number): Strictness {
  if (strength < 0.15) return "off";
  // Hero subjects and anchored subjects are the ones users notice drifting.
  const base: Strictness = subject.hero || hasAnchor ? "strict" : "normal";
  return scaled(base, strength);
}

/** Scale a target strictness down when the global strength dial is low. */
function scaled(target: Strictness, strength: number): Strictness {
  const effective = STRICTNESS_WEIGHT[target] * (0.4 + strength * 0.6);
  if (effective >= 0.8) return "strict";
  if (effective >= 0.5) return "normal";
  if (effective >= 0.2) return "light";
  return "off";
}

/**
 * Seed strategy. Sharing a seed across shots is the cheapest cross-shot
 * consistency lever available on virtually every open-source video model, so
 * high strength uses it; low strength lets each shot vary.
 */
function seedPolicyFor(strength: number, multiShot: boolean): SeedPolicy {
  if (!multiShot) return "shared";
  if (strength >= 0.7) return "shared";
  if (strength >= 0.3) return "per_shot";
  return "random";
}

function buildContinuityNotes(
  entities: ConsistencyEntity[],
  crossShot: ConsistencyContract["crossShot"],
  multiShot: boolean,
): string[] {
  const notes: string[] = [];

  for (const entity of entities) {
    if (entity.adherence === "off" || entity.lockedAttributes.length === 0) continue;
    const verb = entity.adherence === "strict" ? "must not change" : "should stay consistent";
    notes.push(`${entity.label}: ${entity.lockedAttributes.slice(0, 4).join(", ")} ${verb}.`);
  }

  if (multiShot) {
    if (crossShot.lighting !== "off") {
      notes.push("Every shot shares the same location, light sources and time of day.");
    }
    if (crossShot.colorGrade !== "off") {
      notes.push("Colour, contrast and white balance match across all shots.");
    }
    if (crossShot.wardrobe !== "off") {
      notes.push("The same person wears the same clothing in every shot.");
    }
    if (crossShot.propContinuity !== "off") {
      notes.push("Props keep their positions between shots unless the action moves them.");
    }
  }

  return notes;
}

/** Resolve the seed for one shot according to the contract's policy. */
export function seedForShot(contract: ConsistencyContract, shotIndex: number, attempt = 0): number {
  switch (contract.seedPolicy) {
    case "shared":
      // Attempts must vary, or a repair pass regenerates the identical clip.
      return (contract.baseSeed + attempt * 7919) % 2_147_483_647;
    case "per_shot":
      return (contract.baseSeed + shotIndex * 104_729 + attempt * 7919) % 2_147_483_647;
    case "random":
      return Math.floor(Math.random() * 2_147_483_647);
  }
}
