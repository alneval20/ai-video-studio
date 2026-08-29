import { REALISM_DOMAINS, type RealismDirective, type RealismDomain } from "@/lib/spec/spec";
import { STRICTNESS_WEIGHT, type RealismLevel, type Strictness, type SubjectKind } from "@/lib/spec/vocab";
import { REALISM_RULES, type RealismRule } from "./rules";

export interface RealismContext {
  level: RealismLevel;
  /** Subject kinds actually present in this shot (or the whole video). */
  subjectKinds: SubjectKind[];
  /** True when the camera or the subjects meaningfully move. */
  hasMotion: boolean;
  /** True when at least one identity-bearing reference is attached. */
  hasIdentityReference: boolean;
  /** True when the video has more than one shot. */
  multiShot: boolean;
  /** Brand-level overrides, e.g. food_realism: strict. */
  overrides?: Partial<Record<RealismDomain, Strictness>>;
  /** Extra negatives supplied by the user or the brand profile. */
  extraNegatives?: string[];
  /** Cap on emitted rules so prompts stay inside model attention budgets. */
  maxPositives?: number;
  maxNegatives?: number;
}

/** Baseline strictness by realism level, before subject-driven escalation. */
const LEVEL_BASELINE: Record<RealismLevel, Strictness> = {
  stylised: "off",
  standard: "light",
  high: "normal",
  maximum: "strict",
};

/**
 * Which subject kinds escalate which domains.
 *
 * This is the "intelligently choose constraints based on scene content" rule
 * from the brief: food escalates food texture, humans escalate anatomy, and so
 * on. A domain with no present subject stays at the baseline (often `off`).
 */
const KIND_ESCALATIONS: Record<SubjectKind, Partial<Record<RealismDomain, Strictness>>> = {
  human: { human_anatomy: "strict", facial_identity: "strict", hands: "normal" },
  hands: { hands: "strict", human_anatomy: "normal", motion_physics: "normal" },
  product: { product_geometry: "strict", branding_legibility: "normal", material_texture: "normal" },
  food: { food_texture: "strict", material_texture: "normal", lighting_physics: "normal" },
  beverage: { liquid_physics: "strict", product_geometry: "normal", lighting_physics: "normal" },
  liquid: { liquid_physics: "strict", motion_physics: "normal" },
  prop: { material_texture: "normal", motion_physics: "normal" },
  environment: { scene_coherence: "strict", lighting_physics: "normal" },
  animal: { human_anatomy: "normal", motion_physics: "strict" },
  vehicle: { product_geometry: "strict", motion_physics: "strict", material_texture: "normal" },
  text_or_logo: { branding_legibility: "strict" },
};

/** Domains that are always on above `stylised` — these keep video from falling apart. */
const ALWAYS_ON: Partial<Record<RealismDomain, Strictness>> = {
  camera_optics: "normal",
  temporal_stability: "strict",
  motion_physics: "normal",
  lighting_physics: "normal",
};

function maxStrictness(a: Strictness, b: Strictness): Strictness {
  return STRICTNESS_WEIGHT[a] >= STRICTNESS_WEIGHT[b] ? a : b;
}

/**
 * Resolves per-domain strictness for a scene. Exported because the consistency
 * engine and the quality evaluator both key off the same emphasis map.
 */
export function resolveEmphasis(ctx: RealismContext): Record<RealismDomain, Strictness> {
  const baseline = LEVEL_BASELINE[ctx.level];
  const emphasis = {} as Record<RealismDomain, Strictness>;
  for (const domain of REALISM_DOMAINS) emphasis[domain] = baseline;

  if (ctx.level !== "stylised") {
    for (const [domain, strictness] of Object.entries(ALWAYS_ON) as [RealismDomain, Strictness][]) {
      emphasis[domain] = maxStrictness(emphasis[domain], strictness);
    }
  }

  for (const kind of new Set(ctx.subjectKinds)) {
    for (const [domain, strictness] of Object.entries(KIND_ESCALATIONS[kind] ?? {}) as [
      RealismDomain,
      Strictness,
    ][]) {
      emphasis[domain] = maxStrictness(emphasis[domain], strictness);
    }
  }

  // `maximum` pushes every already-active domain to the top.
  if (ctx.level === "maximum") {
    for (const domain of REALISM_DOMAINS) {
      if (emphasis[domain] !== "off") emphasis[domain] = "strict";
    }
  }

  // Explicit overrides (brand profile, Advanced panel) always win, including
  // the ability to turn a domain off entirely.
  for (const [domain, strictness] of Object.entries(ctx.overrides ?? {}) as [RealismDomain, Strictness][]) {
    emphasis[domain] = strictness;
  }

  return emphasis;
}

function ruleApplies(rule: RealismRule, ctx: RealismContext, emphasis: Record<RealismDomain, Strictness>): boolean {
  const active = emphasis[rule.domain];
  if (active === "off") return false;
  if (STRICTNESS_WEIGHT[active] < STRICTNESS_WEIGHT[rule.minStrictness]) return false;

  if (rule.requiresSubjectKinds && rule.requiresSubjectKinds.length > 0) {
    if (!rule.requiresSubjectKinds.some((k) => ctx.subjectKinds.includes(k))) return false;
  }
  if (rule.requiresMotion && !ctx.hasMotion) return false;
  if (rule.requiresIdentityReference && !ctx.hasIdentityReference) return false;
  if (rule.requiresMultiShot && !ctx.multiShot) return false;

  return true;
}

/**
 * Produces the realism directive for a scene or a single shot.
 *
 * Rules are ranked by (domain strictness x rule priority) so that when the
 * budget forces truncation, the constraints that survive are the ones that
 * matter for *this* content — not the first ones in the file.
 */
export function buildRealismDirective(ctx: RealismContext): RealismDirective {
  const emphasis = resolveEmphasis(ctx);

  const scored = REALISM_RULES.filter((r) => ruleApplies(r, ctx, emphasis)).map((rule) => ({
    rule,
    weight: rule.priority * (0.5 + STRICTNESS_WEIGHT[emphasis[rule.domain]] * 0.5),
  }));
  scored.sort((a, b) => b.weight - a.weight);

  const maxPositives = ctx.maxPositives ?? 12;
  const maxNegatives = ctx.maxNegatives ?? 14;

  const positives: string[] = [];
  const negatives: string[] = [];
  const appliedRuleIds: string[] = [];

  for (const { rule } of scored) {
    if (rule.polarity === "positive") {
      if (positives.length >= maxPositives) continue;
      positives.push(rule.text);
    } else {
      if (negatives.length >= maxNegatives) continue;
      negatives.push(rule.text);
    }
    appliedRuleIds.push(rule.id);
  }

  for (const extra of ctx.extraNegatives ?? []) {
    const trimmed = extra.trim();
    if (trimmed && !negatives.includes(trimmed)) negatives.push(trimmed);
  }

  return {
    level: ctx.level,
    emphasis,
    positives,
    negatives,
    appliedRuleIds,
  };
}

/** Domains currently at `strict`. Used by the quality engine to pick checks. */
export function strictDomains(directive: RealismDirective): RealismDomain[] {
  return (Object.entries(directive.emphasis) as [RealismDomain, Strictness][])
    .filter(([, s]) => s === "strict")
    .map(([d]) => d);
}
