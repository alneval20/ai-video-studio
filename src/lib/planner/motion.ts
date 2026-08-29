import type { CameraDirective, MotionDirective, MotionBlur, SubjectMotion } from "@/lib/spec/spec";
import type { BackgroundActivity, ShotPurpose, SubjectKind, TimeOfDay } from "@/lib/spec/vocab";

/**
 * Concrete physical behaviours to name in the prompt, keyed by subject kind.
 *
 * Naming specific physics ("condensation beads and runs down the glass") is
 * dramatically more effective than abstract instructions ("realistic physics"),
 * because it gives the model something to actually render.
 */
const PHYSICS_BY_KIND: Record<SubjectKind, string[]> = {
  human: ["natural weight shift", "subtle breathing", "micro head movement"],
  hands: ["fingers deform slightly on contact", "tendons move under the skin"],
  product: ["stays firmly planted on its surface", "highlights travel across the finish"],
  food: ["steam rises and dissipates", "surface glistens without running"],
  beverage: ["condensation beads and runs down the glass", "ice settles slowly", "liquid surface finds its level"],
  liquid: ["surface tension holds the meniscus", "subtle sloshing follows movement"],
  prop: ["rests solidly with a contact shadow"],
  environment: ["ambient air movement in fabric and foliage"],
  animal: ["natural gait and tail movement", "ear and eye micro-motion"],
  vehicle: ["suspension responds to the surface", "reflections sweep across the body"],
  text_or_logo: ["remains perfectly fixed to its surface"],
};

const TIME_ATMOSPHERE: Partial<Record<TimeOfDay, string[]>> = {
  night: ["practical lights flare gently in the lens", "warm pools of light against deep shadow"],
  golden_hour: ["long warm shadows shift almost imperceptibly"],
  morning: ["soft light drifts as clouds pass the window"],
};

export interface MotionPlanInput {
  purpose: ShotPurpose;
  subjectKinds: SubjectKind[];
  camera: CameraDirective;
  backgroundActivity: BackgroundActivity;
  timeOfDay: TimeOfDay;
  durationSec: number;
  /** The director's action line for this beat. */
  action: string;
}

export function planMotion(input: MotionPlanInput): MotionDirective {
  const subjectMotion = resolveSubjectMotion(input);
  const motionBlur = resolveMotionBlur(input, subjectMotion);

  const physicsTags: string[] = [];
  for (const kind of new Set(input.subjectKinds)) {
    physicsTags.push(...(PHYSICS_BY_KIND[kind] ?? []));
  }
  if (input.backgroundActivity !== "none") {
    physicsTags.push(...(TIME_ATMOSPHERE[input.timeOfDay] ?? []));
  }

  return {
    subjectMotion,
    // Detail/macro shots deliberately quieten the background so the hero reads.
    environmentMotion:
      input.purpose === "detail" || input.camera.shotSize === "macro" ? "none" : input.backgroundActivity,
    motionBlur,
    physicsTags: dedupe(physicsTags).slice(0, 6),
    notes: describeMotion(input, subjectMotion),
  };
}

function resolveSubjectMotion(input: MotionPlanInput): SubjectMotion {
  // Macro and hero product shots should be almost still — movement in a macro
  // frame is the single fastest route to visible AI warping.
  if (input.camera.shotSize === "macro" || input.camera.shotSize === "extreme_close_up") return "micro";
  if (input.purpose === "product_hero" || input.purpose === "detail") return "micro";

  const hasPeople = input.subjectKinds.some((k) => k === "human" || k === "hands" || k === "animal");
  if (!hasPeople) return input.backgroundActivity === "none" ? "micro" : "natural";

  if (input.purpose === "interaction" || input.purpose === "reveal") return "natural";
  if (input.purpose === "reaction") return "natural";
  // Very short shots cannot contain a large gesture without looking sped up.
  return input.durationSec < 3 ? "micro" : "natural";
}

function resolveMotionBlur(input: MotionPlanInput, subjectMotion: SubjectMotion): MotionBlur {
  const cameraMoving = input.camera.moveIntensity > 0.2;
  if (subjectMotion === "none") return "none";
  if (subjectMotion === "micro" && !cameraMoving) return "subtle";
  if (subjectMotion === "pronounced" || (cameraMoving && input.camera.moveSpeed > 0.5)) return "pronounced";
  return "natural";
}

function describeMotion(input: MotionPlanInput, subjectMotion: SubjectMotion): string {
  const pace =
    subjectMotion === "micro"
      ? "Almost nothing moves — only the smallest live details"
      : subjectMotion === "natural"
        ? "Movement is unhurried and unchoreographed"
        : "Movement is deliberate and clearly visible";
  const camera =
    input.camera.moveIntensity < 0.08
      ? "the camera holds still"
      : `the camera performs a ${describeIntensity(input.camera.moveIntensity)} ${input.camera.primaryMove.replace(/_/g, " ")}`;
  return `${pace}; ${camera} over ${input.durationSec.toFixed(1)} seconds.`;
}

export function describeIntensity(intensity: number): string {
  if (intensity < 0.1) return "barely perceptible";
  if (intensity < 0.2) return "very subtle";
  if (intensity < 0.35) return "gentle";
  if (intensity < 0.5) return "measured";
  return "pronounced";
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
