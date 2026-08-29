/**
 * Cup of Coffee — "Amedspor maç günü, %21 indirim" campaign build.
 *
 * Runs the existing pipeline end to end:
 *   DirectorBrief -> VideoGenerationSpec -> Shot Planner
 *   -> Camera / Realism / Consistency -> Prompt Compiler -> provider request
 *
 * The brief is hand-authored rather than LLM-generated. That is a first-class
 * path, not a shortcut: `DirectorBrief` is a validated schema, so a human
 * creative director can author it and every downstream engine behaves exactly
 * as it would with LLM output — including rejecting it if it is malformed.
 *
 *   npx tsx scripts/build-campaign.ts
 *   CAMPAIGN_PROVIDER=remote-worker npx tsx scripts/build-campaign.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assembleSpec } from "@/lib/director";
import { DirectorBrief } from "@/lib/spec/brief";
import { compileSpec } from "@/lib/prompts/prompt-compiler";
import { getProvider } from "@/lib/providers/registry";
import { getBrand } from "@/lib/brands";
import type { StoredReference } from "@/lib/references/types";

const brief = DirectorBrief.parse({
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

/** Assets the campaign expects, by semantic role. */
const WANTED: Array<{ file: string; role: StoredReference["role"]; note: string }> = [
  { file: "environment-cafe.jpg", role: "environment", note: "the real cafe counter, lighting and interior identity" },
  { file: "product-lineup.jpg", role: "product", note: "the five iced drinks — cup geometry and logo placement" },
  { file: "product-dessert.jpg", role: "food", note: "dessert jar — the campaign covers more than coffee" },
  { file: "logo.png", role: "logo", note: "official transparent logo, overlay compositing only" },
];

async function main() {
  const provider = getProvider(process.env.CAMPAIGN_PROVIDER ?? "mock");
  const brand = await getBrand("cup-of-coffee");
  const assetDir = path.resolve("public/campaign");

  const references: StoredReference[] = [];
  const missing: string[] = [];

  for (const want of WANTED) {
    try {
      const stat = await fs.stat(path.join(assetDir, want.file));
      references.push({
        id: `ref_${want.role}`,
        projectId: "prj_amedspor",
        filename: want.file,
        mimeType: want.file.endsWith(".png") ? "image/png" : "image/jpeg",
        bytes: stat.size,
        width: null,
        height: null,
        role: want.role,
        roleSource: "user",
        storagePath: path.join("..", "public", "campaign", want.file),
        url: `/campaign/${want.file}`,
        notes: want.note,
        createdAt: new Date().toISOString(),
      });
    } catch {
      missing.push(want.file);
    }
  }

  const { spec, notes } = assembleSpec({
    projectId: "prj_amedspor",
    prompt: "Amedspor maç günlerinde tüm ürünlerde %21 indirim — premium sinematik kafe reklamı",
    director: {
      brief,
      engine: "heuristic",
      model: null,
      fallbackUsed: false,
      warnings: [],
      elapsedMs: 0,
    },
    brand,
    references,
    provider: {
      id: provider.capabilities.id,
      supportsInitFrame: provider.capabilities.supportsInitFrame,
      supportedReferenceUsages: provider.capabilities.supportedReferenceUsages,
      maxGenerationEdge: provider.capabilities.maxGenerationEdge,
      maxFps: provider.capabilities.maxFps,
      maxClipSeconds: provider.capabilities.maxClipSeconds,
      maxPromptTokens: provider.capabilities.maxPromptTokens,
    },
    advanced: {
      shotCount: 3,
      // Deliberately restrained: premium beverage work is slow and controlled,
      // and low movement is also what keeps a video model temporally coherent.
      motionBudget: 0.3,
      consistencyStrength: 0.95,
      referenceStrength: 1.0,
      seed: 212026,
      negativePrompt:
        "on-screen text, letters, numbers, captions, watermark, stadium, crowd, football pitch, sports poster, jersey",
      maxShots: 3,
    },
  });

  const compiled = compileSpec(spec, provider.capabilities);

  await fs.mkdir("docs/campaigns", { recursive: true });
  await fs.writeFile(
    "docs/campaigns/amedspor-spec.json",
    JSON.stringify({ spec, compiled }, null, 2),
    "utf8",
  );

  console.log(
    `PROVIDER     ${provider.capabilities.label}  (produces real video: ${provider.capabilities.producesRealVideo})`,
  );
  console.log(
    `REFERENCES   ${references.length} bound${missing.length ? `  —  MISSING: ${missing.join(", ")}` : ""}`,
  );
  console.log(
    `DELIVERY     ${spec.delivery.export.width}x${spec.delivery.export.height} @ ${spec.delivery.export.fps}fps, ${spec.delivery.totalDurationSec}s`,
  );
  console.log(
    `GENERATION   ${spec.delivery.generation.width}x${spec.delivery.generation.height} @ ${spec.delivery.generation.fps}fps`,
  );
  console.log(`REALISM      ${spec.realism.level} — ${spec.realism.appliedRuleIds.length} rules fired`);
  console.log(
    `CONSISTENCY  ${spec.consistency.seedPolicy}, strength ${spec.consistency.strength}, base seed ${spec.consistency.baseSeed}`,
  );

  console.log("\nSHOTS");
  for (const shot of spec.shots) {
    const c = compiled.shots.find((x) => x.shotId === shot.id)!;
    console.log(`  ${shot.index + 1}. ${shot.title}  —  ${shot.durationSec}s`);
    console.log(
      `     camera  ${shot.camera.presetLabel} · ${shot.camera.primaryMove} · intensity ${shot.camera.moveIntensity} · ${shot.camera.focalLengthMm}mm ${shot.camera.shotSize}`,
    );
    console.log(
      `     motion  subject:${shot.motion.subjectMotion}  blur:${shot.motion.motionBlur}  physics:${shot.motion.physicsTags.length} tags`,
    );
    console.log(`     prompt  ${c.approxTokens} tokens, ${c.negative.split(",").length} negative terms`);
  }

  console.log("\nPLANNER DECISIONS");
  for (const note of notes) console.log(`  - ${note}`);

  if (missing.length > 0) {
    console.log(`\n!!  ASSETS MISSING — drop these into public/campaign/ and re-run:`);
    for (const m of missing) console.log(`      ${m}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
