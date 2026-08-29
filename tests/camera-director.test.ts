import { describe, expect, it } from "vitest";
import { selectCamera, type CameraSelectionInput } from "@/lib/camera/camera-director";
import { CAMERA_PRESETS } from "@/lib/camera/presets";

function input(overrides: Partial<CameraSelectionInput> = {}): CameraSelectionInput {
  return {
    purpose: "product_hero",
    subjectKinds: ["product"],
    archetype: "premium_commercial",
    style: "cinematic_commercial",
    realismLevel: "high",
    durationSec: 5,
    shotIndex: 0,
    usedPresetIds: [],
    ...overrides,
  };
}

describe("camera presets", () => {
  it("keeps every preset within a believable movement budget", () => {
    // The dominant AI-video tell is a camera that flies. No preset may exceed
    // 0.55, and only follow-style presets may exceed 0.4.
    for (const preset of CAMERA_PRESETS) {
      expect(preset.moveIntensity).toBeLessThanOrEqual(0.55);
      if (preset.moveIntensity > 0.4) {
        expect(["follow", "orbit_slow"]).toContain(preset.primaryMove);
      }
    }
  });

  it("has unique ids", () => {
    expect(new Set(CAMERA_PRESETS.map((p) => p.id)).size).toBe(CAMERA_PRESETS.length);
  });
});

describe("selectCamera", () => {
  it("enforces the realism motion ceiling", () => {
    const maximum = selectCamera(input({ realismLevel: "maximum", motionBudget: 1 }));
    expect(maximum.moveIntensity).toBeLessThanOrEqual(0.38);

    const stylised = selectCamera(input({ realismLevel: "stylised", motionBudget: 1 }));
    expect(stylised.moveIntensity).toBeGreaterThanOrEqual(maximum.moveIntensity);
  });

  it("damps movement on very short shots", () => {
    const short = selectCamera(input({ durationSec: 2.5 }));
    const long = selectCamera(input({ durationSec: 8 }));
    expect(short.moveIntensity).toBeLessThan(long.moveIntensity);
  });

  it("collapses to a static move when the budget is near zero", () => {
    const still = selectCamera(input({ motionBudget: 0, realismLevel: "maximum", durationSec: 2.5 }));
    expect(still.moveIntensity).toBeLessThanOrEqual(0.1);
  });

  it("drops the secondary move when movement is minimal", () => {
    const still = selectCamera(input({ motionBudget: 0, durationSec: 2.5, realismLevel: "maximum" }));
    expect(still.secondaryMove).toBeNull();
  });

  it("avoids repeating a preset already used in the video", () => {
    const first = selectCamera(input());
    const second = selectCamera(input({ shotIndex: 1, usedPresetIds: [first.presetId] }));
    expect(second.presetId).not.toBe(first.presetId);
  });

  it("respects a forced preset", () => {
    const forced = selectCamera(input({ forcedPresetId: "walking_follow" }));
    expect(forced.presetId).toBe("walking_follow");
  });

  it("falls back safely when the forced preset does not exist", () => {
    const forced = selectCamera(input({ forcedPresetId: "does_not_exist" }));
    expect(forced.presetId).toBe("subtle_handheld");
  });

  it("chooses a phone camera for creator content and a rig for commercials", () => {
    const ugc = selectCamera(
      input({ archetype: "influencer_ugc", style: "authentic_ugc", purpose: "interaction", subjectKinds: ["human"] }),
    );
    const commercial = selectCamera(input({ archetype: "premium_commercial", style: "luxury_product" }));
    expect(ugc.device).toBe("modern_smartphone");
    expect(commercial.device).not.toBe("modern_smartphone");
  });

  it("tightens depth of field for macro framing", () => {
    const macro = selectCamera(input({ preferredShotSize: "macro" }));
    const wide = selectCamera(input({ preferredShotSize: "wide", purpose: "establishing" }));
    expect(macro.depthOfField).toBe("very_shallow");
    expect(["deep", "moderate"]).toContain(wide.depthOfField);
  });

  it("always explains itself", () => {
    expect(selectCamera(input()).rationale.length).toBeGreaterThan(20);
  });
});
