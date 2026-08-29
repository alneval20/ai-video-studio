/**
 * The Amedspor match-day campaign brief and its asset bindings.
 *
 * Shared by `build-campaign.ts` and `build-colab-notebook.ts` so the notebook
 * renders the same brief the app plans from. Duplicating it would let the two
 * drift, and the render would stop reflecting the campaign.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DirectorBrief } from "@/lib/spec/brief";
import type { StoredReference } from "@/lib/references/types";

export const CAMPAIGN_BRIEF: DirectorBrief = DirectorBrief.parse({
  logline:
    "Match-day commercial: a slow cinematic move through the real Cup of Coffee cafe onto the iced drink lineup, with green and red practical light washing across glass and steel.",
  sourceLanguage: "tr",
  format: "instagram_reel",
  socialArchetype: "premium_commercial",
  visualStyle: "cinematic_commercial",
  colorGrade: "moody_contrast",
  mood: "premium",
  realismLevel: "maximum",
  targetDurationSec: 10,
  suggestedShotCount: 3,

  environment: {
    setting:
      "the real Cup of Coffee cafe interior: dark charcoal ribbed counter front, warm butcher-block bar top, black industrial pendant lamps, a dense green living plant wall, exposed grey brick and a polished concrete floor",
    timeOfDay: "night",
    lighting: "practical_ambient",
    backgroundActivity: "subtle",
    atmosphereNotes: [
      "warm pendant lamps glowing against a dark interior",
      "specular highlights travelling across the polished counter",
      "deep green bokeh from the plant wall behind",
      "faint green and red light accents washing across steel and glass",
    ],
  },

  subjects: [
    {
      key: "iced_latte",
      kind: "beverage",
      description:
        "a clear ribbed plastic Cup of Coffee cup of iced latte, layered espresso over milk, large clear ice cubes, beaded condensation on the outside",
      hero: true,
      identityNotes: [
        "the printed Cup of Coffee logo stays crisp and unchanged",
        "clear ribbed plastic cup with a domed lid",
        "layered espresso-over-milk gradient",
        "large transparent ice cubes with internal fracture detail",
      ],
    },
    {
      key: "drink_lineup",
      kind: "product",
      description:
        "a row of five Cup of Coffee iced drinks on dark terrazzo, from pale latte through dark americano to whipped-topped mocha",
      hero: false,
      identityNotes: [
        "identical cup geometry across all five",
        "logo position identical on every cup",
      ],
    },
    {
      key: "counter",
      kind: "environment",
      description: "the polished dark terrazzo counter surface reflecting the pendant lights",
      hero: false,
      identityNotes: [],
    },
  ],

  beats: [
    {
      purpose: "establishing",
      action:
        "The camera drifts slowly through the dark cafe past the glowing pendant lamps, the plant wall dissolving into deep green bokeh behind.",
      featured: ["counter"],
      suggestedShotSize: "medium",
      weight: 1.0,
    },
    {
      purpose: "detail",
      action:
        "Extreme macro inside the iced latte: ice cubes settle and rotate, milk cascades down through the espresso, a condensation droplet runs down the outside of the cup.",
      featured: ["iced_latte"],
      suggestedShotSize: "macro",
      weight: 1.3,
    },
    {
      purpose: "payoff",
      action:
        "The camera glides laterally across the five drinks and settles, focus resolving onto the hero iced latte as green and red rim light traces the cup edges.",
      featured: ["drink_lineup", "iced_latte"],
      suggestedShotSize: "close_up",
      weight: 1.2,
    },
  ],

  expectedReferenceRoles: ["product", "environment", "logo"],

  userAvoidances: [
    "stadium, football pitch, crowd, scarves or team kit",
    "sports poster layout or graphic banners",
    "any text, numbers or lettering rendered inside the footage",
    "slideshow or still-image feel",
  ],

  rationale:
    "Match-day energy is carried entirely by light — green and red practical accents on glass and steel — rather than by sports iconography, so the cafe stays a cafe. Three shots at roughly 3.3s each: fewer, longer takes read as premium and give the video model the temporal room it needs to stay coherent. The final shot settles so the %21 typography can land as a clean compositing layer over held footage.",
});

/**
 * Assets the campaign expects, by semantic role.
 *
 * Matched by pattern rather than exact filename: two of these are
 * export-tool UUIDs, and a re-export silently renames them. An exact-string
 * lookup then reports the reference "missing" and the campaign quietly builds
 * without it — which is precisely the failure this campaign cannot afford.
 */
const WANTED: Array<{
  match: RegExp;
  role: StoredReference["role"];
  note: string;
  /** A campaign built without this asset is not the campaign. Fail, don't warn. */
  required: boolean;
}> = [
  {
    match: /^IMG_0510\.jpe?g$/i,
    role: "environment",
    note: "the real cafe counter, lighting and interior identity",
    required: true,
  },
  {
    match: /^cup_of_coffee_HD_preserved\.png$/i,
    role: "food",
    note: "upright iced drink and dessert reference; prepared as the I2V init frame before generation",
    required: true,
  },
  {
    match: /^da543044-[0-9a-f-]+\.png$/i,
    role: "style",
    note: "drink variety reference only; its weekday/product labels must never be generated into footage",
    required: false,
  },
  {
    match: /^logo\.png$/i,
    role: "logo",
    note: "official transparent logo, overlay compositing only",
    required: true,
  },
];


/** Resolves campaign assets from `public/`, failing on absent required ones. */
export async function resolveCampaignReferences(): Promise<{
  references: StoredReference[];
  missing: string[];
}> {
  const assetDir = path.resolve("public");
  const entries = await fs.readdir(assetDir).catch(() => [] as string[]);

  const references: StoredReference[] = [];
  const missing: string[] = [];

  for (const want of WANTED) {
    const filename = entries.find((e) => want.match.test(e));
    if (!filename) {
      missing.push(`${want.role} (expected ${want.match.source})`);
      continue;
    }
    const stat = await fs.stat(path.join(assetDir, filename));
    references.push({
      id: `ref_${want.role}`,
      projectId: "prj_amedspor",
      filename,
      mimeType: filename.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
      bytes: stat.size,
      width: null,
      height: null,
      role: want.role,
      roleSource: "user",
      source: "public",
      storagePath: filename,
      url: `/${encodeURIComponent(filename)}`,
      notes: want.note,
      createdAt: new Date().toISOString(),
    });
  }

  const missingRequired = WANTED.filter(
    (w) => w.required && !references.some((r) => r.role === w.role),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Required campaign assets are absent from ${assetDir}:\n` +
        missingRequired.map((w) => `  - ${w.role}: expected ${w.match.source}`).join("\n"),
    );
  }

  return { references, missing };
}
