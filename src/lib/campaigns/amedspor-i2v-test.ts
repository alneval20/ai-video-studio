import fs from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, probeMedia } from "@/lib/compose/ffmpeg";
import { StudioError } from "@/lib/core/errors";
import type { GenerationRequest } from "@/lib/providers/types";
import {
  WAN_I2V_FPS,
  WAN_I2V_PROFILE,
} from "@/lib/providers/remote-worker/remote-worker-provider";

export const AMEDSPOR_TEST_DURATION_SEC = 3;
export const AMEDSPOR_TEST_WIDTH = 720;
export const AMEDSPOR_TEST_HEIGHT = 1280;

export const AMEDSPOR_ASSETS = {
  cafe: path.resolve("public/IMG_0510.jpeg"),
  productDessert: path.resolve("public/cup_of_coffee_HD_preserved.png"),
  drinkLineupReference: path.resolve("public/da543044-fe85-4845-8796-8b667d9594f9.png"),
  logo: path.resolve("public/logo.png"),
} as const;

/**
 * Corrects the source image's EXIF-less sideways storage and makes a native
 * 9:16 init frame. This creates conditioning input only; it never animates or
 * synthesises frames.
 */
export async function prepareAmedsporInitFrame(outputPath: string): Promise<string> {
  await fs.access(AMEDSPOR_ASSETS.productDessert);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const result = await runFfmpeg([
    "-y",
    "-i",
    AMEDSPOR_ASSETS.productDessert,
    "-vf",
    "transpose=1,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1",
    "-frames:v",
    "1",
    outputPath,
  ]);
  if (!result.ok) {
    throw new StudioError("COMPOSE_FAILED", "Could not prepare the native-vertical Wan init frame.", {
      details: result.stderrTail,
      remedy: result.command,
    });
  }

  const info = await probeMedia(outputPath);
  if (info.width !== AMEDSPOR_TEST_WIDTH || info.height !== AMEDSPOR_TEST_HEIGHT) {
    throw new StudioError(
      "REFERENCE_INVALID",
      `Prepared init frame is ${info.width}x${info.height}, not 720x1280.`,
    );
  }
  return outputPath;
}

/** The unchanged campaign's macro beverage shot, shortened to a 3-second proof. */
export function createAmedsporI2vTestRequest(initFramePath: string, outputPath: string): GenerationRequest {
  return {
    requestId: `req_amedspor_i2v_${Date.now()}`,
    projectId: "prj_amedspor",
    specId: "spec_amedspor_match_day_light",
    shotId: "shot_macro_ice_liquid_test",
    attempt: 0,
    prompt: [
      "A single continuous photorealistic premium beverage-commercial take inside the same Cup of Coffee cafe shown by the init frame.",
      "Preserve the exact iced drink, dessert, counter geometry, product proportions, materials, existing packaging marks and cafe layout from the first frame without changing or inventing lettering.",
      "The cinema camera performs one restrained physical tabletop dolly-in with a very small three-quarter orbit, producing real foreground-to-background parallax and continuously changing glass reflections.",
      "Large transparent ice cubes remain genuinely three-dimensional, with refraction, internal fractures, wet surfaces and tiny gravity-driven settling and rotation inside the drink.",
      "The liquid has believable inertia and subtle internal flow, never rubbery; one condensation droplet slowly travels down the outside of the cold cup.",
      "Warm cafe practicals stay physically consistent while faint green and red match-day reflections travel naturally across glass, ice and the polished counter.",
      "Natural 180-degree-shutter motion blur, shallow macro depth of field, stable product identity, high-end commercial lighting, physically based materials.",
    ].join(" "),
    negativePrompt: [
      "still image",
      "frozen frame",
      "slideshow",
      "Ken Burns zoom",
      "2D image transform",
      "animated poster",
      "flat motion graphics",
      "pasted-on product",
      "floating object",
      "morphing cup",
      "warped geometry",
      "rubbery liquid",
      "plastic opaque ice",
      "impossible reflections",
      "camera teleport",
      "flicker",
      "new generated text",
      "changing or garbled packaging marks",
      "campaign typography",
      "discount numbers",
      "percentage sign added to the scene",
      "weekday labels",
      "watermark",
      "stadium",
      "football pitch",
      "sports poster",
    ].join(", "),
    references: [
      {
        id: "ref_product_dessert_init",
        role: "food",
        usage: "init_frame",
        weight: 1,
        path: initFramePath,
        mimeType: "image/png",
        description: "Exact Cup of Coffee iced drink, dessert and cafe material reference.",
      },
      {
        id: "ref_lineup_descriptive_only",
        role: "style",
        usage: "descriptive_only",
        weight: 0,
        path: AMEDSPOR_ASSETS.drinkLineupReference,
        mimeType: "image/png",
        description: "Drink variety only; every printed weekday/product label is explicitly excluded.",
      },
    ],
    width: AMEDSPOR_TEST_WIDTH,
    height: AMEDSPOR_TEST_HEIGHT,
    fps: WAN_I2V_FPS,
    durationSec: AMEDSPOR_TEST_DURATION_SEC,
    seed: 212026,
    camera: {
      presetId: "macro_dolly_orbit",
      presetLabel: "Restrained macro dolly with three-quarter orbit",
      device: "macro_rig",
      shotSize: "macro",
      angle: "three_quarter",
      height: "table_level",
      primaryMove: "push_in",
      secondaryMove: "orbit_slow",
      moveIntensity: 0.28,
      moveSpeed: 0.24,
      stability: 0.96,
      microJitter: 0.02,
      focalLengthMm: 85,
      depthOfField: "very_shallow",
      focusBehavior: "breathing_shallow",
      subjectDistanceM: 0.45,
      parallax: 0.42,
      framingNotes: "Keep the real cup and dessert fully grounded on the counter throughout the take.",
      rationale: "A restrained macro move proves actual camera parallax while protecting product geometry.",
    },
    motion: {
      subjectMotion: "micro",
      environmentMotion: "subtle",
      motionBlur: "natural",
      physicsTags: [
        "ice_refraction",
        "ice_gravity_settle",
        "liquid_inertia",
        "condensation_beading",
        "moving_specular_reflections",
      ],
      notes: "Ice settles by millimetres, liquid responds to inertia, and one condensation droplet travels downward under gravity.",
    },
    guidance: {
      promptAdherence: 0.82,
      referenceAdherence: 1,
      consistencyStrength: 0.96,
    },
    outputPath,
    providerOptions: {
      model_profile: WAN_I2V_PROFILE,
      num_inference_steps: 40,
      guidance_scale: 5,
      guidance_scale_2: 5,
    },
  };
}
