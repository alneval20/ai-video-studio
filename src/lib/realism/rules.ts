import type { RealismDomain } from "@/lib/spec/spec";
import type { Strictness, SubjectKind } from "@/lib/spec/vocab";

/**
 * The realism rule catalogue.
 *
 * Rules are *conditional*. Nothing here is unconditionally attached to every
 * shot — a macro shot of a coffee cup should never carry "realistic hands and
 * fingers", because naming an absent body part is one of the fastest ways to
 * make a video model hallucinate one.
 */
export interface RealismRule {
  id: string;
  domain: RealismDomain;
  polarity: "positive" | "negative";
  /** The sentence that reaches the prompt compiler. */
  text: string;
  /** Fires only when the domain's resolved strictness is at least this. */
  minStrictness: Exclude<Strictness, "off">;
  /** Higher wins when the prompt budget forces truncation. */
  priority: number;
  /** Fires only if at least one of these subject kinds is present. Empty = any. */
  requiresSubjectKinds?: SubjectKind[];
  /** Fires only when the shot has meaningful camera or subject movement. */
  requiresMotion?: boolean;
  /** Fires only when an identity-bearing reference image is attached. */
  requiresIdentityReference?: boolean;
  /** Fires only in multi-shot videos. */
  requiresMultiShot?: boolean;
}

export const REALISM_RULES: readonly RealismRule[] = [
  // --- global photographic realism ----------------------------------------
  {
    id: "base.photoreal",
    domain: "camera_optics",
    polarity: "positive",
    text: "Photorealistic real-world footage captured on a real camera, not rendered or illustrated.",
    minStrictness: "light",
    priority: 100,
  },
  {
    id: "base.exposure",
    domain: "camera_optics",
    polarity: "positive",
    text: "Authentic camera exposure with natural highlight rolloff and shadow detail.",
    minStrictness: "normal",
    priority: 82,
  },
  {
    id: "base.dof",
    domain: "camera_optics",
    polarity: "positive",
    text: "Natural optical depth of field with a physically plausible focal plane.",
    minStrictness: "normal",
    priority: 80,
  },
  {
    id: "base.grain",
    domain: "camera_optics",
    polarity: "positive",
    text: "Fine sensor noise and lens imperfection consistent with the capture device.",
    minStrictness: "strict",
    priority: 60,
  },
  {
    id: "base.no_cgi",
    domain: "camera_optics",
    polarity: "negative",
    text: "CGI render, 3D animation, video-game look, illustration, cartoon",
    minStrictness: "light",
    priority: 100,
  },
  {
    id: "base.no_overprocess",
    domain: "camera_optics",
    polarity: "negative",
    text: "oversharpened HDR look, plastic skin smoothing, artificial glow",
    minStrictness: "normal",
    priority: 74,
  },

  // --- lighting ------------------------------------------------------------
  {
    id: "light.physics",
    domain: "lighting_physics",
    polarity: "positive",
    text: "Physically believable lighting: shadows, reflections and falloff agree with the visible light sources.",
    minStrictness: "light",
    priority: 95,
  },
  {
    id: "light.reflections",
    domain: "lighting_physics",
    polarity: "positive",
    text: "Reflections on glass, metal and liquid surfaces match the surrounding environment.",
    minStrictness: "normal",
    priority: 78,
    requiresSubjectKinds: ["product", "beverage", "liquid", "vehicle"],
  },
  {
    id: "light.no_impossible",
    domain: "lighting_physics",
    polarity: "negative",
    text: "impossible lighting, shadows pointing the wrong way, missing contact shadows",
    minStrictness: "normal",
    priority: 76,
  },

  // --- human anatomy -------------------------------------------------------
  {
    id: "human.anatomy",
    domain: "human_anatomy",
    polarity: "positive",
    text: "Correct human anatomy and natural body proportions.",
    minStrictness: "light",
    priority: 96,
    requiresSubjectKinds: ["human"],
  },
  {
    id: "human.motion",
    domain: "human_anatomy",
    polarity: "positive",
    text: "Natural, unhurried human movement with believable weight and balance.",
    minStrictness: "normal",
    priority: 88,
    requiresSubjectKinds: ["human"],
    requiresMotion: true,
  },
  {
    id: "human.no_extra_limbs",
    domain: "human_anatomy",
    polarity: "negative",
    text: "extra limbs, missing limbs, twisted joints, distorted body proportions",
    minStrictness: "light",
    priority: 96,
    requiresSubjectKinds: ["human"],
  },
  {
    id: "human.no_uncanny",
    domain: "human_anatomy",
    polarity: "negative",
    text: "uncanny valley faces, waxy skin, dead eyes",
    minStrictness: "normal",
    priority: 70,
    requiresSubjectKinds: ["human"],
  },

  // --- hands ---------------------------------------------------------------
  {
    id: "hands.correct",
    domain: "hands",
    polarity: "positive",
    text: "Realistic hands with five correctly formed fingers and natural grip pressure.",
    minStrictness: "light",
    priority: 97,
    requiresSubjectKinds: ["hands", "human"],
  },
  {
    id: "hands.contact",
    domain: "hands",
    polarity: "positive",
    text: "Hands make real contact with objects — fingers wrap surfaces and deform slightly on touch.",
    minStrictness: "normal",
    priority: 85,
    requiresSubjectKinds: ["hands"],
  },
  {
    id: "hands.no_malformed",
    domain: "hands",
    polarity: "negative",
    text: "malformed hands, fused fingers, six fingers, missing fingers, rubber fingers",
    minStrictness: "light",
    priority: 98,
    requiresSubjectKinds: ["hands", "human"],
  },

  // --- facial identity -----------------------------------------------------
  {
    id: "face.stable",
    domain: "facial_identity",
    polarity: "positive",
    text: "The same face throughout — features, age and hair remain identical frame to frame.",
    minStrictness: "normal",
    priority: 92,
    requiresSubjectKinds: ["human"],
  },
  {
    id: "face.no_morph",
    domain: "facial_identity",
    polarity: "negative",
    text: "shifting facial features, changing face, morphing identity between frames",
    minStrictness: "normal",
    priority: 92,
    requiresSubjectKinds: ["human"],
  },

  // --- food ----------------------------------------------------------------
  {
    id: "food.texture",
    domain: "food_texture",
    polarity: "positive",
    text: "Realistic food texture — visible crumb, grain, moisture and edible surface detail.",
    minStrictness: "light",
    priority: 94,
    requiresSubjectKinds: ["food"],
  },
  {
    id: "food.appetising",
    domain: "food_texture",
    polarity: "positive",
    text: "Food looks freshly prepared and appetising, with natural imperfection rather than symmetry.",
    minStrictness: "normal",
    priority: 80,
    requiresSubjectKinds: ["food"],
  },
  {
    id: "food.no_melt",
    domain: "food_texture",
    polarity: "negative",
    text: "melting or deforming food, plastic-looking food, fake prop food, food merging into the plate",
    minStrictness: "light",
    priority: 94,
    requiresSubjectKinds: ["food"],
  },

  // --- liquids -------------------------------------------------------------
  {
    id: "liquid.physics",
    domain: "liquid_physics",
    polarity: "positive",
    text: "Realistic liquid behaviour: correct surface tension, meniscus, and settled level in the vessel.",
    minStrictness: "light",
    priority: 93,
    requiresSubjectKinds: ["liquid", "beverage"],
  },
  {
    id: "liquid.ice",
    domain: "liquid_physics",
    polarity: "positive",
    text: "Ice floats and refracts correctly; condensation beads and runs down the outside of the glass.",
    minStrictness: "normal",
    priority: 86,
    requiresSubjectKinds: ["liquid", "beverage"],
  },
  {
    id: "liquid.motion",
    domain: "liquid_physics",
    polarity: "positive",
    text: "Liquid responds to movement with subtle, physically correct sloshing.",
    minStrictness: "normal",
    priority: 78,
    requiresSubjectKinds: ["liquid", "beverage"],
    requiresMotion: true,
  },
  {
    id: "liquid.no_impossible",
    domain: "liquid_physics",
    polarity: "negative",
    text: "liquid passing through glass, floating droplets, gel-like or frozen liquid, ice cubes changing shape",
    minStrictness: "light",
    priority: 90,
    requiresSubjectKinds: ["liquid", "beverage"],
  },

  // --- product geometry ----------------------------------------------------
  {
    id: "product.geometry",
    domain: "product_geometry",
    polarity: "positive",
    text: "Product geometry stays rigid and identical throughout — proportions, silhouette and material do not change.",
    minStrictness: "light",
    priority: 95,
    requiresSubjectKinds: ["product", "beverage", "vehicle"],
  },
  {
    id: "product.reference",
    domain: "product_geometry",
    polarity: "positive",
    text: "Match the supplied product reference closely in shape, colour and finish.",
    minStrictness: "normal",
    priority: 99,
    requiresIdentityReference: true,
  },
  {
    id: "product.no_warp",
    domain: "product_geometry",
    polarity: "negative",
    text: "warped packaging, changing product shape, duplicated products, geometry melting, container morphing",
    minStrictness: "light",
    priority: 95,
    requiresSubjectKinds: ["product", "beverage"],
  },

  // --- branding ------------------------------------------------------------
  {
    id: "brand.stable",
    domain: "branding_legibility",
    polarity: "positive",
    text: "Brand mark stays crisp, correctly positioned and unchanged across every frame.",
    minStrictness: "normal",
    priority: 91,
    requiresSubjectKinds: ["text_or_logo", "product"],
  },
  {
    id: "brand.no_gibberish",
    domain: "branding_legibility",
    polarity: "negative",
    text: "garbled text, invented lettering, distorted logo, drifting or flickering branding, misspelled labels",
    minStrictness: "normal",
    priority: 91,
    requiresSubjectKinds: ["text_or_logo", "product"],
  },

  // --- materials -----------------------------------------------------------
  {
    id: "material.texture",
    domain: "material_texture",
    polarity: "positive",
    text: "Materials read correctly: wood grain, brushed metal, fabric weave and ceramic glaze all behave as themselves.",
    minStrictness: "normal",
    priority: 72,
  },
  {
    id: "material.no_plastic",
    domain: "material_texture",
    polarity: "negative",
    text: "plastic-looking surfaces, waxy sheen, texture-less materials",
    minStrictness: "normal",
    priority: 72,
  },

  // --- motion physics ------------------------------------------------------
  {
    id: "motion.blur",
    domain: "motion_physics",
    polarity: "positive",
    text: "Realistic motion blur consistent with the shutter and the speed of what is moving.",
    minStrictness: "normal",
    priority: 79,
    requiresMotion: true,
  },
  {
    id: "motion.gravity",
    domain: "motion_physics",
    polarity: "positive",
    text: "Objects obey gravity and rest solidly on their surfaces with correct contact shadows.",
    minStrictness: "light",
    priority: 89,
  },
  {
    id: "motion.no_floating",
    domain: "motion_physics",
    polarity: "negative",
    text: "floating objects, items sliding without cause, impossible physics, objects passing through each other",
    minStrictness: "light",
    priority: 89,
  },
  {
    id: "motion.no_camera_stunt",
    domain: "motion_physics",
    polarity: "negative",
    text: "unnatural camera motion, flying or swooping camera, sudden zooms, drone-style orbits, gliding through solid objects",
    minStrictness: "light",
    priority: 93,
  },

  // --- temporal stability --------------------------------------------------
  {
    id: "temporal.stable",
    domain: "temporal_stability",
    polarity: "positive",
    text: "Temporal continuity — every element persists coherently from the first frame to the last.",
    minStrictness: "light",
    priority: 97,
  },
  {
    id: "temporal.no_flicker",
    domain: "temporal_stability",
    polarity: "negative",
    text: "flickering, strobing, frame-to-frame jitter, popping textures",
    minStrictness: "light",
    priority: 94,
  },
  {
    id: "temporal.no_morph",
    domain: "temporal_stability",
    polarity: "negative",
    text: "AI morphing, objects transforming into other objects, features drifting over time",
    minStrictness: "light",
    priority: 96,
  },
  {
    id: "temporal.cross_shot",
    domain: "temporal_stability",
    polarity: "positive",
    text: "Continuity with the surrounding shots: same location, same lighting, same styling.",
    minStrictness: "normal",
    priority: 84,
    requiresMultiShot: true,
  },

  // --- scene coherence -----------------------------------------------------
  {
    id: "scene.coherent",
    domain: "scene_coherence",
    polarity: "positive",
    text: "A coherent, real place with consistent architecture, props and spatial layout.",
    minStrictness: "normal",
    priority: 75,
  },
  {
    id: "scene.background_life",
    domain: "scene_coherence",
    polarity: "positive",
    text: "Background elements move subtly and naturally without pulling focus.",
    minStrictness: "normal",
    priority: 66,
  },
  {
    id: "scene.no_duplication",
    domain: "scene_coherence",
    polarity: "negative",
    text: "duplicated objects, repeating background people, inconsistent background between frames",
    minStrictness: "normal",
    priority: 77,
  },
  {
    id: "scene.no_watermark",
    domain: "scene_coherence",
    polarity: "negative",
    text: "watermark, timestamp overlay, subtitles, UI elements, stock-footage branding",
    minStrictness: "light",
    priority: 68,
  },
] as const;

export function getRule(id: string): RealismRule | undefined {
  return REALISM_RULES.find((r) => r.id === id);
}
