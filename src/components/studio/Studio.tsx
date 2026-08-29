"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerationJob } from "@/lib/jobs/types";
import type { StoredReference } from "@/lib/references/types";
import type { DeliveryFormat, RealismLevel } from "@/lib/spec/vocab";
import { api, type StudioConfig } from "./api";
import { PlanInspector } from "./PlanInspector";
import { ReferencePanel } from "./ReferencePanel";
import { ResultPanel } from "./ResultPanel";
import { Banner, Disclosure, Field, Section, Slider, humanise } from "./primitives";

const POLL_MS = 1200;

/**
 * The creation screen.
 *
 * The default path is deliberately four controls: references, prompt, brand,
 * Generate. Everything else — camera preset, shot count, seed, provider,
 * consistency and reference strength, negative constraints — lives behind
 * Advanced, because the whole premise is that the user should not have to know
 * any of it.
 */
export function Studio() {
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [references, setReferences] = useState<StoredReference[]>([]);
  const [brandId, setBrandId] = useState<string>("");
  const [format, setFormat] = useState<DeliveryFormat>("instagram_reel");
  const [durationMode, setDurationMode] = useState<"auto" | "fixed">("auto");
  const [durationSec, setDurationSec] = useState(12);
  const [realism, setRealism] = useState<RealismLevel>("high");

  const [advanced, setAdvanced] = useState({
    cameraPresetId: "",
    shotCount: 0,
    seed: "",
    consistencyStrength: 0.8,
    referenceStrength: 0.8,
    motionBudget: 0.35,
    negativePrompt: "",
    providerId: "",
    directorMode: "" as "" | "auto" | "llm" | "heuristic",
  });

  const [job, setJob] = useState<GenerationJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; remedy?: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((e: Error) => setConfigError(e.message));
  }, []);

  // Poll the job until it reaches a terminal state.
  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { job: latest } = await api.job(jobId);
        setJob(latest);
        if (["completed", "failed", "cancelled"].includes(latest.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* transient; keep polling */
      }
    }, POLL_MS);
  }, []);

  useEffect(() => () => void (pollRef.current && clearInterval(pollRef.current)), []);

  const busy = submitting || (job !== null && !["completed", "failed", "cancelled"].includes(job.status));

  async function generate() {
    if (prompt.trim().length < 3) {
      setError({ message: "Describe the video you want, in your own words." });
      return;
    }
    setSubmitting(true);
    setError(null);
    setJob(null);

    try {
      const result = await api.generate({
        prompt,
        projectId: projectId ?? undefined,
        brandProfileId: brandId || null,
        format,
        durationSec: durationMode === "fixed" ? durationSec : null,
        realismLevel: realism,
        referenceIds: references.map((r) => r.id),
        providerId: advanced.providerId || null,
        advanced: {
          cameraPresetId: advanced.cameraPresetId || null,
          shotCount: advanced.shotCount || null,
          seed: advanced.seed ? Number(advanced.seed) : null,
          consistencyStrength: advanced.consistencyStrength,
          referenceStrength: advanced.referenceStrength,
          motionBudget: advanced.motionBudget,
          negativePrompt: advanced.negativePrompt || null,
          directorMode: advanced.directorMode || null,
        },
      });

      setProjectId(result.projectId);
      const { job: created } = await api.job(result.jobId);
      setJob(created);
      startPolling(result.jobId);
    } catch (e) {
      const err = e as Error & { remedy?: string };
      setError({ message: err.message, remedy: err.remedy });
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    await api.cancel(job.id).catch(() => undefined);
    const { job: latest } = await api.job(job.id);
    setJob(latest);
  }

  const activeProvider = config?.providers.find(
    (p) => p.id === (advanced.providerId || config.activeProviderId),
  );

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AI Video Studio</h1>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            Describe an idea. The director handles the cinematography.
          </p>
        </div>
        {config ? (
          <div className="flex flex-wrap gap-1.5">
            <span className="chip">
              Director: {config.director.llmAvailable ? "LLM" : "heuristic"}
            </span>
            <span className={`chip ${activeProvider?.producesRealVideo ? "" : "border-[var(--warning)]/40 text-[var(--warning)]"}`}>
              Provider: {activeProvider?.label ?? config.activeProviderId}
            </span>
            {!config.tools.ffmpeg ? (
              <span className="chip border-[var(--warning)]/40 text-[var(--warning)]">No FFmpeg</span>
            ) : null}
          </div>
        ) : null}
      </header>

      {configError ? (
        <div className="mb-6">
          <Banner tone="danger" title="Could not load the studio configuration">
            {configError}
          </Banner>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ---------------- creation column ---------------- */}
        <div className="space-y-4">
          <Section title="Reference images" subtitle="Optional, but the strongest quality lever you have.">
            <ReferencePanel
              references={references}
              projectId={projectId}
              onChange={setReferences}
              onProjectId={setProjectId}
              disabled={busy}
            />
          </Section>

          <Section title="What do you want to create?">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              rows={5}
              placeholder="Create a realistic Instagram Reel for Cup of Coffee. An iced latte is sitting on a cafe table at night while a woman casually records it with her phone. Make it feel like a real influencer video."
              className="input resize-y leading-relaxed"
            />

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Brand">
                <select
                  value={brandId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setBrandId(id);
                    const brand = config?.brands.find((b) => b.id === id);
                    if (brand) {
                      setFormat(brand.defaults.format);
                      setRealism(brand.defaults.realismLevel);
                    }
                  }}
                  disabled={busy}
                  className="input"
                >
                  <option value="">No brand profile</option>
                  {config?.brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Format">
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as DeliveryFormat)}
                  disabled={busy}
                  className="input"
                >
                  {config?.formats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {humanise(f.id)} · {f.aspectRatio}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Duration">
                <div className="flex gap-2">
                  <select
                    value={durationMode}
                    onChange={(e) => setDurationMode(e.target.value as "auto" | "fixed")}
                    disabled={busy}
                    className="input"
                  >
                    <option value="auto">Auto</option>
                    <option value="fixed">Fixed</option>
                  </select>
                  {durationMode === "fixed" ? (
                    <input
                      type="number"
                      min={2}
                      max={60}
                      value={durationSec}
                      onChange={(e) => setDurationSec(Number(e.target.value))}
                      disabled={busy}
                      className="input w-24"
                    />
                  ) : null}
                </div>
              </Field>

              <Field label="Realism">
                <select
                  value={realism}
                  onChange={(e) => setRealism(e.target.value as RealismLevel)}
                  disabled={busy}
                  className="input"
                >
                  {config?.realismLevels.map((level) => (
                    <option key={level} value={level}>
                      {humanise(level)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-4">
              <Disclosure label="Advanced">
                <div className="space-y-4">
                  <Field label="Camera preset" hint="Leave on Auto — the camera director picks per shot.">
                    <select
                      value={advanced.cameraPresetId}
                      onChange={(e) => setAdvanced((a) => ({ ...a, cameraPresetId: e.target.value }))}
                      disabled={busy}
                      className="input"
                    >
                      <option value="">Auto (recommended)</option>
                      {config?.cameraPresets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} — {p.description}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Shots" hint="0 = let the planner decide.">
                      <input
                        type="number"
                        min={0}
                        max={config?.maxShots ?? 6}
                        value={advanced.shotCount}
                        onChange={(e) => setAdvanced((a) => ({ ...a, shotCount: Number(e.target.value) }))}
                        disabled={busy}
                        className="input"
                      />
                    </Field>
                    <Field label="Seed" hint="Blank = derived from the prompt.">
                      <input
                        type="number"
                        min={0}
                        value={advanced.seed}
                        onChange={(e) => setAdvanced((a) => ({ ...a, seed: e.target.value }))}
                        disabled={busy}
                        className="input"
                        placeholder="auto"
                      />
                    </Field>
                  </div>

                  <Slider
                    label="Consistency strength"
                    value={advanced.consistencyStrength}
                    onChange={(v) => setAdvanced((a) => ({ ...a, consistencyStrength: v }))}
                    hint="How hard identity and continuity are locked across frames and shots."
                  />
                  <Slider
                    label="Reference strength"
                    value={advanced.referenceStrength}
                    onChange={(v) => setAdvanced((a) => ({ ...a, referenceStrength: v }))}
                    hint="How closely the attached images must be matched."
                  />
                  <Slider
                    label="Camera movement"
                    value={advanced.motionBudget}
                    onChange={(v) => setAdvanced((a) => ({ ...a, motionBudget: v }))}
                    hint="Low is usually more believable. High movement is the fastest route to obvious AI."
                  />

                  <Field label="Provider">
                    <select
                      value={advanced.providerId}
                      onChange={(e) => setAdvanced((a) => ({ ...a, providerId: e.target.value }))}
                      disabled={busy}
                      className="input"
                    >
                      <option value="">Default ({config?.activeProviderId})</option>
                      {config?.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                          {p.available ? "" : " — unavailable"}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Director">
                    <select
                      value={advanced.directorMode}
                      onChange={(e) =>
                        setAdvanced((a) => ({ ...a, directorMode: e.target.value as typeof a.directorMode }))
                      }
                      disabled={busy}
                      className="input"
                    >
                      <option value="">Default ({config?.director.mode})</option>
                      <option value="llm">LLM director</option>
                      <option value="heuristic">Heuristic (offline)</option>
                    </select>
                  </Field>

                  <Field label="Extra things to avoid">
                    <textarea
                      value={advanced.negativePrompt}
                      onChange={(e) => setAdvanced((a) => ({ ...a, negativePrompt: e.target.value }))}
                      disabled={busy}
                      rows={2}
                      placeholder="e.g. no people in the background"
                      className="input resize-y"
                    />
                  </Field>
                </div>
              </Disclosure>
            </div>

            {error ? (
              <div className="mt-4">
                <Banner tone="danger" title={error.message}>
                  {error.remedy}
                </Banner>
              </div>
            ) : null}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => void generate()}
                disabled={busy}
                className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-black
                           transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? statusLabel(job) : "Generate"}
              </button>
              {busy && job ? (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="rounded-lg border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-muted)]
                             transition hover:border-[var(--danger)] hover:text-[var(--fg)]"
                >
                  Cancel
                </button>
              ) : null}
            </div>

            {job ? (
              <div className="mt-4">
                <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-input)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
                  {humanise(job.status)} · {Math.round(job.progress * 100)}%
                </p>
              </div>
            ) : null}
          </Section>

          {config && activeProvider && !activeProvider.producesRealVideo ? (
            <Banner tone="info" title="Development mode">
              {activeProvider.detail} Everything upstream of generation is real — the director, shot
              plan, compiled prompts and provider request are exactly what a GPU backend will receive.
            </Banner>
          ) : null}

          {config && activeProvider && !activeProvider.available && activeProvider.remedy ? (
            <Banner tone="warning" title={activeProvider.detail}>
              {activeProvider.remedy}
            </Banner>
          ) : null}

          {config ? <QualityCapabilities analyzers={config.analyzers} /> : null}
        </div>

        {/* ---------------- inspection column ---------------- */}
        <div className="space-y-4">
          {!job ? (
            <div className="card flex min-h-[400px] flex-col items-center justify-center p-10 text-center">
              <p className="text-sm text-[var(--fg-muted)]">Nothing generated yet</p>
              <p className="mt-2 max-w-md text-xs leading-relaxed text-[var(--fg-subtle)]">
                Type an idea and press Generate. The director will infer the shot structure, camera
                work, lighting, realism constraints and reference bindings, then compile a
                professional generation prompt — all of which appears here for inspection.
              </p>
            </div>
          ) : (
            <>
              {job.spec ? (
                <PlanInspector
                  spec={job.spec}
                  compiled={job.compiled}
                  shots={job.shots}
                  notes={job.planNotes}
                />
              ) : (
                <div className="card p-10 text-center text-xs text-[var(--fg-muted)] animate-pulse-soft">
                  Directing…
                </div>
              )}
              <ResultPanel job={job} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * What quality control can actually measure in this installation.
 *
 * Shown because "quality: 71%" means something very different when it came
 * from a vision model than when it came from a risk estimate — and the user
 * should be able to see which, and what would upgrade it.
 */
function QualityCapabilities({ analyzers }: { analyzers: StudioConfig["analyzers"] }) {
  const measuring = analyzers.filter((a) => a.available && a.id !== "risk-prior");
  const missing = analyzers.filter((a) => !a.available);

  return (
    <Disclosure label="Quality control" badge={`${measuring.length} measuring`}>
      <div className="space-y-2">
        {analyzers.map((a) => (
          <div key={a.id} className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                a.id === "risk-prior"
                  ? "bg-[var(--fg-subtle)]"
                  : a.available
                    ? "bg-[var(--success)]"
                    : "bg-[var(--border-strong)]"
              }`}
            />
            <div className="min-w-0">
              <p className="text-[11px] text-[var(--fg)]">
                {a.label}
                {a.id === "risk-prior" ? (
                  <span className="text-[var(--fg-subtle)]"> — estimates only</span>
                ) : a.available ? null : (
                  <span className="text-[var(--fg-subtle)]"> — unavailable</span>
                )}
              </p>
              <p className="text-[10px] leading-relaxed text-[var(--fg-subtle)]">{a.description}</p>
            </div>
          </div>
        ))}

        {missing.length > 0 ? (
          <p className="mt-3 border-t border-[var(--border)] pt-3 text-[10px] leading-relaxed text-[var(--fg-subtle)]">
            Unavailable analyzers fall back to risk estimates, which are marked with an asterisk in
            the report. Adding an ANTHROPIC_API_KEY enables perceptual review of anatomy, branding
            and material realism.
          </p>
        ) : null}
      </div>
    </Disclosure>
  );
}

function statusLabel(job: GenerationJob | null): string {
  if (!job) return "Starting…";
  switch (job.status) {
    case "planning":
      return "Directing…";
    case "queued":
      return "Queued…";
    case "generating":
      return "Generating…";
    case "quality_check":
      return "Checking quality…";
    case "composing":
      return "Composing…";
    default:
      return "Working…";
  }
}
