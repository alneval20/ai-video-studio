import { describe, expect, it } from "vitest";
import { allocateDurations, MAX_SHOT_SEC, MIN_SHOT_SEC, planShots, resolveShotCount } from "@/lib/planner/shot-planner";
import { getArchetype } from "@/lib/social/aesthetics";
import type { DirectorBrief } from "@/lib/spec/brief";

function brief(overrides: Partial<DirectorBrief> = {}): DirectorBrief {
  return {
    logline: "A test video.",
    sourceLanguage: "en",
    format: "instagram_reel",
    socialArchetype: "night_cafe",
    visualStyle: "premium_social",
    colorGrade: "warm_film",
    mood: "cozy",
    realismLevel: "high",
    targetDurationSec: 12,
    suggestedShotCount: 3,
    environment: {
      setting: "a modern cafe",
      timeOfDay: "night",
      lighting: "practical_ambient",
      backgroundActivity: "subtle",
      atmosphereNotes: [],
    },
    subjects: [
      { key: "iced_latte", kind: "beverage", description: "an iced latte", hero: true, identityNotes: [] },
      { key: "person", kind: "human", description: "a young woman", hero: false, identityNotes: [] },
    ],
    beats: [
      { purpose: "establishing", action: "The cafe is revealed.", featured: ["iced_latte"], weight: 1 },
      { purpose: "interaction", action: "She films the drink.", featured: ["person", "iced_latte"], weight: 1.2 },
      { purpose: "product_hero", action: "The latte holds the frame.", featured: ["iced_latte"], weight: 1.4 },
    ],
    expectedReferenceRoles: [],
    userAvoidances: [],
    rationale: "",
    ...overrides,
  };
}

const baseInput = {
  archetype: getArchetype("night_cafe"),
  maxShots: 6,
  motionBudget: 0.35,
  hasIdentityReference: false,
};

describe("resolveShotCount", () => {
  it("refuses to over-cut a very short video", () => {
    const { count } = resolveShotCount({
      ...baseInput,
      brief: brief({ suggestedShotCount: 4 }),
      totalDurationSec: 4,
    });
    expect(count).toBe(1);
  });

  it("keeps every shot above the minimum readable length", () => {
    const { count } = resolveShotCount({
      ...baseInput,
      brief: brief({ suggestedShotCount: 6 }),
      totalDurationSec: 8,
    });
    expect(8 / count).toBeGreaterThanOrEqual(MIN_SHOT_SEC);
  });

  it("caps authentic UGC at two shots regardless of the director's request", () => {
    const { count } = resolveShotCount({
      ...baseInput,
      archetype: getArchetype("influencer_ugc"),
      brief: brief({ suggestedShotCount: 5, socialArchetype: "influencer_ugc" }),
      totalDurationSec: 20,
    });
    expect(count).toBeLessThanOrEqual(2);
  });

  it("honours an explicit user override", () => {
    const { count } = resolveShotCount({
      ...baseInput,
      brief: brief(),
      totalDurationSec: 20,
      forcedShotCount: 4,
    });
    expect(count).toBe(4);
  });

  it("never exceeds the configured ceiling", () => {
    const { count } = resolveShotCount({
      ...baseInput,
      brief: brief({ suggestedShotCount: 6 }),
      totalDurationSec: 60,
      maxShots: 2,
    });
    expect(count).toBeLessThanOrEqual(2);
  });
});

describe("allocateDurations", () => {
  it("distributes runtime by weight and sums to the target", () => {
    const durations = allocateDurations(12, [1, 1, 2]);
    expect(durations).toHaveLength(3);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(12, 1);
    expect(durations[2]).toBeGreaterThan(durations[0]);
  });

  it("clamps every shot into the readable range", () => {
    const durations = allocateDurations(40, [1, 20, 1]);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(MIN_SHOT_SEC);
      expect(d).toBeLessThanOrEqual(MAX_SHOT_SEC);
    }
  });

  it("handles a single shot", () => {
    expect(allocateDurations(6, [1])).toEqual([6]);
  });
});

describe("planShots", () => {
  it("produces ordered shots with camera, motion and realism resolved", () => {
    const { shots } = planShots({ ...baseInput, brief: brief(), totalDurationSec: 12 });

    expect(shots.length).toBeGreaterThan(0);
    shots.forEach((shot, i) => {
      expect(shot.index).toBe(i);
      expect(shot.camera.presetId).toBeTruthy();
      expect(shot.realism.positives.length).toBeGreaterThan(0);
      expect(shot.motion.notes).toBeTruthy();
    });
  });

  it("varies the camera preset across a multi-shot piece", () => {
    const { shots } = planShots({
      ...baseInput,
      brief: brief({ suggestedShotCount: 3 }),
      totalDurationSec: 15,
    });
    if (shots.length > 1) {
      expect(new Set(shots.map((s) => s.camera.presetId)).size).toBeGreaterThan(1);
    }
  });

  it("honours a forced camera preset on every shot", () => {
    const { shots } = planShots({
      ...baseInput,
      brief: brief(),
      totalDurationSec: 15,
      forcedCameraPresetId: "static_luxury",
    });
    expect(shots.every((s) => s.camera.presetId === "static_luxury")).toBe(true);
  });
});
