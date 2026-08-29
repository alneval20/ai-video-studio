"use client";

import { useState, type ReactNode } from "react";

/** Small shared presentational pieces. Kept together to avoid file sprawl. */

export function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-5">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--fg)]">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-[var(--fg-muted)]">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Disclosure({
  label,
  defaultOpen = false,
  badge,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  badge?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium
                   uppercase tracking-[0.12em] text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {label}
          {badge ? <span className="chip normal-case tracking-normal">{badge}</span> : null}
        </span>
        <span aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </button>
      {open ? <div className="border-t border-[var(--border)] p-4">{children}</div> : null}
    </div>
  );
}

const TONE_STYLES = {
  info: "border-[var(--info)]/40 bg-[var(--info)]/10 text-[var(--fg)]",
  warning: "border-[var(--warning)]/45 bg-[var(--warning)]/10 text-[var(--fg)]",
  danger: "border-[var(--danger)]/45 bg-[var(--danger)]/10 text-[var(--fg)]",
  success: "border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--fg)]",
} as const;

export function Banner({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof TONE_STYLES;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs leading-relaxed ${TONE_STYLES[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-[var(--fg-muted)]">{children}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
      {hint ? <p className="mt-1.5 text-[11px] text-[var(--fg-subtle)]">{hint}</p> : null}
    </div>
  );
}

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  format,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="field-label mb-0">{label}</label>
        <span className="font-mono text-[11px] text-[var(--fg-muted)]">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
      {hint ? <p className="mt-1.5 text-[11px] text-[var(--fg-subtle)]">{hint}</p> : null}
    </div>
  );
}

/** A labelled key/value row used throughout the plan inspector. */
export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-[var(--fg-subtle)]">
        {label}
      </span>
      <span className="text-right text-xs text-[var(--fg)]">{value}</span>
    </div>
  );
}

export function Meter({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 75 ? "var(--success)" : pct >= 55 ? "var(--warning)" : "var(--danger)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-input)]">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[var(--fg-muted)]">
        {label ?? `${pct}%`}
      </span>
    </div>
  );
}

export function humanise(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
