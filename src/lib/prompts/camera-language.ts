import { describeIntensity } from "@/lib/planner/motion";
import type { CameraDirective } from "@/lib/spec/spec";
import type {
  CameraAngle,
  CameraDevice,
  CameraHeight,
  CameraMove,
  DepthOfField,
  FocusBehavior,
  ShotSize,
} from "@/lib/spec/vocab";

/**
 * Turns the numeric camera directive into prose.
 *
 * This is the only place camera enums become English. Keeping it isolated means
 * a new provider that prefers a different dialect gets a new renderer, not a
 * rewrite of the camera director.
 */

const DEVICE_PHRASES: Record<CameraDevice, string> = {
  modern_smartphone: "Shot on a modern smartphone, with the slight wide-angle perspective and computational look of a phone camera",
  mirrorless_prime: "Shot on a mirrorless camera with a fast prime lens",
  cinema_camera: "Shot on a cinema camera with a cine prime",
  gimbal_rig: "Shot on a gimbal-stabilised rig",
  macro_rig: "Shot on a macro lens on a locked-off rig",
  action_camera: "Shot on a compact action camera with a wide field of view",
};

const SHOT_SIZE_PHRASES: Record<ShotSize, string> = {
  macro: "an extreme macro frame filling the image with a single surface",
  extreme_close_up: "an extreme close-up",
  close_up: "a close-up",
  medium_close_up: "a medium close-up",
  medium: "a medium shot",
  wide: "a wide shot",
  establishing: "a wide establishing shot",
};

const ANGLE_PHRASES: Record<CameraAngle, string> = {
  eye_level: "at eye level with the subject",
  high_angle: "looking slightly down at the subject",
  low_angle: "looking slightly up at the subject",
  top_down: "directly overhead, looking straight down",
  three_quarter: "at a three-quarter angle to the subject",
  dutch_slight: "with a barely perceptible tilt to the horizon",
};

const HEIGHT_PHRASES: Record<CameraHeight, string> = {
  table_level: "the lens sitting just above the table surface",
  chest: "the camera held around chest height",
  eye: "the camera at standing eye height",
  overhead: "the camera held above the scene",
  low_ground: "the camera down near ground level",
};

const MOVE_PHRASES: Record<CameraMove, (intensity: string) => string> = {
  static: () => "The camera does not move",
  push_in: (i) => `The camera makes a ${i}, continuous push toward the subject`,
  pull_out: (i) => `The camera draws ${i} back away from the subject`,
  pan_left: (i) => `The camera pans ${i} to the left`,
  pan_right: (i) => `The camera pans ${i} to the right`,
  tilt_up: (i) => `The camera tilts ${i} upward`,
  tilt_down: (i) => `The camera tilts ${i} downward`,
  slide_left: (i) => `The camera glides ${i} to the left, parallel to the subject`,
  slide_right: (i) => `The camera glides ${i} to the right, parallel to the subject`,
  orbit_slow: (i) => `The camera arcs ${i} around the subject through a short angle, no more than a quarter turn`,
  follow: (i) => `The camera travels with the subject at a ${i} pace, keeping them the same size in frame`,
  handheld_drift: (i) => `The camera drifts ${i} as a real hand would, never settling completely`,
  rack_focus: () => "The focus shifts between two planes while the framing holds still",
  crane_down: (i) => `The camera descends ${i} toward the subject`,
};

const DOF_PHRASES: Record<DepthOfField, string> = {
  deep: "Most of the scene stays acceptably sharp",
  moderate: "The background falls gently out of focus behind the subject",
  shallow: "A shallow depth of field isolates the subject against a soft background",
  very_shallow: "A razor-thin plane of focus holds only the subject; everything else dissolves into bokeh",
};

const FOCUS_PHRASES: Record<FocusBehavior, string> = {
  locked: "Focus stays locked on the subject throughout",
  autofocus_natural: "Autofocus behaves like a real phone — it settles onto the subject with a small, believable adjustment",
  rack_to_subject: "Focus pulls from the foreground onto the subject",
  rack_to_background: "Focus pulls from the subject back into the environment",
  breathing_shallow: "Focus breathes very slightly as the operator moves, always recovering onto the subject",
};

/** Lens character, derived from focal length rather than named explicitly. */
function lensPhrase(focalLengthMm: number): string {
  if (focalLengthMm <= 20) return "a very wide field of view with visible perspective stretch toward the edges";
  if (focalLengthMm <= 30) return "a wide, natural field of view";
  if (focalLengthMm <= 45) return "a normal field of view close to human vision";
  if (focalLengthMm <= 70) return "a slightly compressed, flattering perspective";
  if (focalLengthMm <= 105) return "noticeable telephoto compression that flattens the background";
  return "strong telephoto compression, stacking the background right behind the subject";
}

export interface CameraLanguage {
  /** "Shot on a modern smartphone…" */
  device: string;
  /** "A medium close-up at eye level, the camera held around chest height." */
  framing: string;
  /** "The camera makes a gentle, continuous push toward the subject." */
  movement: string;
  /** Handheld texture, only present when the shot is genuinely handheld. */
  handling: string | null;
  /** Optics: depth of field + focus behaviour + lens character. */
  optics: string;
  /** All of the above, in the order a DP would say them. */
  lines: string[];
}

export function describeCamera(camera: CameraDirective): CameraLanguage {
  const intensity = describeIntensity(camera.moveIntensity);

  const device = `${DEVICE_PHRASES[camera.device]}, giving ${lensPhrase(camera.focalLengthMm)}.`;

  const framing =
    `The shot is ${SHOT_SIZE_PHRASES[camera.shotSize]} ${ANGLE_PHRASES[camera.angle]}, ` +
    `with ${HEIGHT_PHRASES[camera.height]}.`;

  const primary = MOVE_PHRASES[camera.primaryMove](intensity);
  const secondary =
    camera.secondaryMove && camera.secondaryMove !== camera.primaryMove
      ? `, while ${MOVE_PHRASES[camera.secondaryMove]("subtle").replace(/^The camera /, "it ")}`
      : "";
  const speed = camera.moveSpeed < 0.25 ? " The movement is slow and even" : camera.moveSpeed > 0.55 ? " The movement is brisk but controlled" : "";
  const movement = `${primary}${secondary}.${speed}${speed ? "." : ""}`;

  // Only describe handheld texture when the rig is actually loose — telling a
  // model a locked-off tripod shot has "micro-shake" produces jitter artefacts.
  const handling =
    camera.stability < 0.75 && camera.microJitter > 0.3
      ? `There is constant, small handheld motion — the tiny weight shifts and breathing of a person holding the camera — but never a jolt, whip or shake.`
      : camera.stability >= 0.9
        ? `The camera is completely steady, with no handheld shake.`
        : null;

  const optics = `${DOF_PHRASES[camera.depthOfField]}. ${FOCUS_PHRASES[camera.focusBehavior]}.`;

  return {
    device,
    framing,
    movement,
    handling,
    optics,
    lines: [device, framing, movement, handling, optics].filter((l): l is string => Boolean(l)),
  };
}

/** Compact key=value form, for providers that take structured camera fields. */
export function cameraFields(camera: CameraDirective): Record<string, string | number> {
  return {
    shot_size: camera.shotSize,
    angle: camera.angle,
    height: camera.height,
    move: camera.primaryMove,
    move_secondary: camera.secondaryMove ?? "none",
    move_intensity: camera.moveIntensity,
    move_speed: camera.moveSpeed,
    stability: camera.stability,
    handheld_jitter: camera.microJitter,
    focal_length_mm: camera.focalLengthMm,
    depth_of_field: camera.depthOfField,
    focus: camera.focusBehavior,
    subject_distance_m: camera.subjectDistanceM,
  };
}
