/** Minimal Result type for operations where failure is an expected outcome. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Clamp a number into [min, max]. Used constantly by the camera/realism engines. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Round to a given number of decimals — keeps generated JSON readable. */
export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function unique<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}
