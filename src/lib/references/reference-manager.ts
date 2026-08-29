import { clamp } from "@/lib/core/result";
import type { ReferenceDirective, SceneSubject, Shot } from "@/lib/spec/spec";
import {
  ROLE_DEFAULTS,
  STRICTNESS_WEIGHT,
  type ReferenceRole,
  type ReferenceUsage,
  type Strictness,
  type SubjectKind,
} from "@/lib/spec/vocab";
import type { StoredReference } from "./types";

/**
 * Filename hints for role inference. Deliberately conservative — a wrong guess
 * is worse than `style`, which binds weakly and cannot corrupt a generation.
 */
const FILENAME_HINTS: ReadonlyArray<{ role: ReferenceRole; patterns: RegExp }> = [
  { role: "logo", patterns: /(logo|wordmark|brandmark|icon|amblem)/i },
  { role: "product", patterns: /(product|packshot|bottle|cup|can|package|urun|ürün|pack)/i },
  { role: "character", patterns: /(model|person|girl|man|woman|face|portrait|talent|kişi|karakter)/i },
  { role: "food", patterns: /(food|dish|plate|latte|coffee|drink|meal|yemek|kahve)/i },
  { role: "environment", patterns: /(cafe|room|interior|location|background|scene|mekan|ortam)/i },
  { role: "clothing", patterns: /(outfit|clothing|shirt|dress|wardrobe|kıyafet)/i },
  { role: "composition", patterns: /(layout|composition|framing|storyboard|kompozisyon)/i },
  { role: "style", patterns: /(style|mood|moodboard|grade|look|referans|stil)/i },
  { role: "first_frame", patterns: /(first[_-]?frame|start[_-]?frame|opening|init)/i },
];

/** Best-effort role inference from filename. Falls back to `style`. */
export function inferReferenceRole(filename: string): { role: ReferenceRole; confident: boolean } {
  for (const hint of FILENAME_HINTS) {
    if (hint.patterns.test(filename)) return { role: hint.role, confident: true };
  }
  return { role: "style", confident: false };
}

/** Roles whose usage actually conditions the model on identity. */
const IDENTITY_ROLES: ReadonlySet<ReferenceRole> = new Set([
  "product",
  "logo",
  "character",
  "food",
  "clothing",
  "first_frame",
]);

export function isIdentityReference(ref: { role: ReferenceRole }): boolean {
  return IDENTITY_ROLES.has(ref.role);
}

/** Subject kinds that a reference of a given role is relevant to. */
const ROLE_TO_SUBJECT_KINDS: Record<ReferenceRole, SubjectKind[]> = {
  product: ["product", "beverage", "prop"],
  logo: ["text_or_logo", "product"],
  character: ["human", "hands"],
  environment: ["environment"],
  composition: [],
  style: [],
  food: ["food", "beverage", "liquid"],
  clothing: ["human"],
  first_frame: [],
};

export interface ResolveReferencesInput {
  references: StoredReference[];
  subjects: SceneSubject[];
  shots: Pick<Shot, "id" | "featuredSubjectKeys" | "index">[];
  /** 0..1 global dial from Advanced settings ("reference strength"). */
  referenceStrength: number;
  /** Per-role adherence overrides from the brand profile. */
  brandAdherence?: Partial<Record<ReferenceRole, Strictness>>;
  /** True when the chosen provider can actually consume an init frame. */
  providerSupportsInitFrame: boolean;
  /** Usages the provider supports. Unsupported ones degrade to descriptive_only. */
  supportedUsages: ReferenceUsage[];
}

/**
 * Turns raw uploads into a binding contract.
 *
 * Two things matter here and are easy to get wrong:
 *
 *  1. A reference is bound to *shots*, not to the whole video, whenever the
 *     subject it anchors is not in every shot. Pushing a character reference
 *     into a macro product shot is how you get a face appearing in a coffee cup.
 *
 *  2. When the provider cannot honour a usage, we degrade it explicitly to
 *     `descriptive_only` rather than silently dropping it — the prompt compiler
 *     then describes the reference in words instead.
 */
export function resolveReferences(input: ResolveReferencesInput): ReferenceDirective[] {
  const strength = clamp(input.referenceStrength, 0, 1);
  const subjectByKind = new Map<SubjectKind, string[]>();
  for (const s of input.subjects) {
    subjectByKind.set(s.kind, [...(subjectByKind.get(s.kind) ?? []), s.key]);
  }

  // Only one reference may act as the init frame; the strongest one wins.
  let initFrameClaimed = false;
  const ordered = [...input.references].sort(
    (a, b) => rolePriority(b.role) - rolePriority(a.role),
  );

  return ordered.map((ref) => {
    const defaults = ROLE_DEFAULTS[ref.role];
    const adherence = input.brandAdherence?.[ref.role] ?? defaults.adherence;

    let usage: ReferenceUsage = defaults.usage;
    const notes: string[] = [];

    if (usage === "init_frame") {
      if (initFrameClaimed) {
        usage = "identity";
        notes.push("Demoted to identity conditioning — another image is already the opening frame.");
      } else if (!input.providerSupportsInitFrame) {
        usage = "descriptive_only";
        notes.push("Provider has no image-to-video input; this reference is described in the prompt instead.");
      } else {
        initFrameClaimed = true;
      }
    }

    if (!input.supportedUsages.includes(usage) && usage !== "descriptive_only") {
      notes.push(
        `Provider does not support ${usage} conditioning; falling back to a written description of this image.`,
      );
      usage = "descriptive_only";
    }

    const weight = clamp(STRICTNESS_WEIGHT[adherence] * (0.55 + strength * 0.45), 0, 1);

    return {
      referenceId: ref.id,
      label: ref.filename,
      role: ref.role,
      usage,
      adherence,
      weight: Number(weight.toFixed(3)),
      shotIds: shotScope(ref.role, input),
      preserve: preservationList(ref.role),
      notes: [defaults.description, ref.notes, ...notes].filter(Boolean).join(" "),
    } satisfies ReferenceDirective;
  });
}

function rolePriority(role: ReferenceRole): number {
  const order: ReferenceRole[] = [
    "first_frame",
    "product",
    "character",
    "food",
    "logo",
    "clothing",
    "environment",
    "composition",
    "style",
  ];
  return order.length - order.indexOf(role);
}

/**
 * `null` means "every shot". Otherwise we restrict the reference to the shots
 * that actually feature a matching subject.
 */
function shotScope(role: ReferenceRole, input: ResolveReferencesInput): string[] | null {
  // Style, composition and environment set the look of the whole piece.
  if (role === "style" || role === "composition" || role === "environment") return null;
  // The init frame only conditions the opening shot.
  if (role === "first_frame") {
    const first = input.shots.find((s) => s.index === 0) ?? input.shots[0];
    return first ? [first.id] : null;
  }

  const kinds = ROLE_TO_SUBJECT_KINDS[role];
  if (kinds.length === 0) return null;

  const relevantKeys = new Set(
    input.subjects.filter((s) => kinds.includes(s.kind)).map((s) => s.key),
  );
  if (relevantKeys.size === 0) return null;

  const matching = input.shots
    .filter((shot) => shot.featuredSubjectKeys.some((k) => relevantKeys.has(k)))
    .map((s) => s.id);

  // If it matches every shot, express that as `null` — cleaner downstream.
  if (matching.length === 0 || matching.length === input.shots.length) return null;
  return matching;
}

/** What specifically must survive from each kind of reference. */
function preservationList(role: ReferenceRole): string[] {
  switch (role) {
    case "product":
      return ["silhouette and proportions", "surface finish and colour", "label placement", "lid and vessel geometry"];
    case "logo":
      return ["exact letterforms", "mark proportions", "placement on the product", "colour"];
    case "character":
      return ["facial structure", "skin tone", "hair colour and cut", "apparent age", "build"];
    case "food":
      return ["portioning and layering", "garnish placement", "surface texture", "colour and doneness"];
    case "clothing":
      return ["garment cut", "colour and pattern", "layering"];
    case "environment":
      return ["room layout", "materials and finishes", "light source positions"];
    case "composition":
      return ["subject placement in frame", "negative space", "horizon and eyeline"];
    case "style":
      return ["colour palette", "contrast and grade", "grain and texture"];
    case "first_frame":
      return ["the entire opening frame"];
  }
}

/** Convenience for the realism engine's `hasIdentityReference` flag. */
export function hasIdentityReference(directives: ReferenceDirective[]): boolean {
  return directives.some((d) => isIdentityReference(d) && d.usage !== "descriptive_only");
}
