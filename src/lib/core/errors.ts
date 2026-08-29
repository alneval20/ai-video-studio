/**
 * Typed error taxonomy. Every error carries a machine-readable `code` so the
 * job pipeline can decide whether a failure is retryable, and a `remedy`
 * string so the UI can tell the user what to actually do about it.
 */
export type StudioErrorCode =
  | "INVALID_INPUT"
  | "DIRECTOR_FAILED"
  | "DIRECTOR_INVALID_OUTPUT"
  | "PLANNING_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_FAILED"
  | "GPU_REQUIRED"
  | "REFERENCE_INVALID"
  | "QUALITY_REJECTED"
  | "COMPOSE_FAILED"
  | "TOOL_MISSING"
  | "NOT_FOUND"
  | "STORAGE_FAILED";

const RETRYABLE: ReadonlySet<StudioErrorCode> = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_FAILED",
  "QUALITY_REJECTED",
  "DIRECTOR_INVALID_OUTPUT",
]);

export class StudioError extends Error {
  readonly code: StudioErrorCode;
  /** Human-actionable next step. Surfaced verbatim in the UI. */
  readonly remedy?: string;
  readonly details?: unknown;

  constructor(
    code: StudioErrorCode,
    message: string,
    options: { remedy?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioError";
    this.code = code;
    this.remedy = options.remedy;
    this.details = options.details;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      remedy: this.remedy,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function isStudioError(e: unknown): e is StudioError {
  return e instanceof StudioError;
}

/** Normalises anything thrown into a serialisable shape for jobs/API responses. */
export function describeError(e: unknown): {
  code: StudioErrorCode | "UNKNOWN";
  message: string;
  remedy?: string;
  retryable: boolean;
} {
  if (isStudioError(e)) {
    return { code: e.code, message: e.message, remedy: e.remedy, retryable: e.retryable };
  }
  return {
    code: "UNKNOWN",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
  };
}
