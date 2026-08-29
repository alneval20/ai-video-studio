import type { BrandProfile } from "@/lib/brands/types";
import type { DirectorBrief } from "@/lib/spec/brief";
import type { DeliveryFormat, RealismLevel, ReferenceRole } from "@/lib/spec/vocab";

export interface DirectorInput {
  /** The user's raw, casual prompt. Never re-parsed downstream. */
  prompt: string;
  brand: BrandProfile | null;
  /** Roles of the attached references — the director should account for them. */
  referenceRoles: ReferenceRole[];
  /** Explicit UI selections that override anything the director infers. */
  overrides: {
    format?: DeliveryFormat | null;
    durationSec?: number | null;
    realismLevel?: RealismLevel | null;
    shotCount?: number | null;
  };
}

export interface DirectorOutput {
  brief: DirectorBrief;
  engine: "llm" | "heuristic";
  model: string | null;
  fallbackUsed: boolean;
  warnings: string[];
  elapsedMs: number;
}

export interface Director {
  readonly id: "llm" | "heuristic";
  direct(input: DirectorInput): Promise<DirectorOutput>;
}
