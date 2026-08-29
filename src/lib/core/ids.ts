import { randomUUID, randomBytes } from "node:crypto";

/** Short, URL-safe, sortable-ish id with a domain prefix (e.g. `prj_k3n8x2q1`). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function newUuid(): string {
  return randomUUID();
}

export const ID = {
  project: () => newId("prj"),
  generation: () => newId("gen"),
  job: () => newId("job"),
  shot: () => newId("shot"),
  reference: () => newId("ref"),
  spec: () => newId("spec"),
  providerJob: () => newId("pjob"),
  qualityReport: () => newId("qr"),
  attempt: () => newId("att"),
} as const;

/**
 * Deterministic 32-bit seed derived from a string. Used so that a re-run of
 * the same spec produces the same seed unless the user asks for variation.
 */
export function seedFromString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Keep it positive and inside the range most samplers accept.
  return Math.abs(h) % 2_147_483_647;
}
