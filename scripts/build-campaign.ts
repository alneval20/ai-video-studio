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
 *   node --import tsx scripts/build-campaign.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assembleSpec } from "@/lib/director";
import { compileSpec } from "@/lib/prompts/prompt-compiler";
import { getProvider } from "@/lib/providers/registry";
import { getBrand } from "@/lib/brands";
import { CAMPAIGN_BRIEF, resolveCampaignReferences } from "./campaign-brief";

async function main() {
  const provider = getProvider(process.env.CAMPAIGN_PROVIDER ?? "remote-worker");
  if (!provider.capabilities.producesRealVideo) {
    throw new Error("The Cup of Coffee campaign cannot be built with a mock provider.");
  }
  const brand = await getBrand("cup-of-coffee");

  const { references, missing } = await resolveCampaignReferences();

  const { spec, notes } = assembleSpec({
    projectId: "prj_amedspor",
    prompt: "Amedspor maç günlerinde tüm ürünlerde %21 indirim — premium sinematik kafe reklamı",
    director: {
      brief: CAMPAIGN_BRIEF,
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
      supportedGenerationSizes: provider.capabilities.supportedGenerationSizes,
      maxFps: provider.capabilities.maxFps,
      maxClipSeconds: provider.capabilities.maxClipSeconds,
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
    console.log(`\n!!  ASSETS MISSING — restore these files in public/ and re-run:`);
    for (const m of missing) console.log(`      ${m}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
