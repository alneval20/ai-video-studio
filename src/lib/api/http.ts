import { NextResponse } from "next/server";
import { describeError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";

const log = createLogger("api");

/** Consistent success envelope. */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

/**
 * Consistent error envelope. Every failure carries a machine code and, where we
 * know one, a `remedy` the UI can show verbatim — "GPU required" is useless
 * without "here is how to connect one".
 */
export function fail(error: unknown, status?: number): NextResponse {
  const described = describeError(error);
  log.warn("Request failed.", described);
  return NextResponse.json(
    { ok: false, error: described },
    { status: status ?? statusFor(described.code) },
  );
}

function statusFor(code: string): number {
  switch (code) {
    case "INVALID_INPUT":
    case "REFERENCE_INVALID":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "PROVIDER_NOT_CONFIGURED":
    case "GPU_REQUIRED":
    case "TOOL_MISSING":
      return 503;
    default:
      return 500;
  }
}
