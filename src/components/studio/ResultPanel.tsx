"use client";

import type { GenerationJob } from "@/lib/jobs/types";
import { Banner, Meter, humanise } from "./primitives";
import { mediaUrl } from "./api";

/** The output view: the finished video, or an honest account of what happened. */
export function ResultPanel({ job }: { job: GenerationJob }) {
  const output = job.output;

  return (
    <div className="space-y-3">
      {job.provider?.fellBack && job.provider.fallbackReason ? (
        <Banner tone="warning" title="Fell back to the development provider">
          {job.provider.fallbackReason}
        </Banner>
      ) : null}

      {output && !output.isRealGeneration ? (
        <Banner tone="warning" title="This is a placeholder, not AI video">
          The development provider produced labelled slates so the whole pipeline could run. Connect a
          real generation backend to produce actual footage — the plan, prompts and provider request
          above are exactly what it will receive.
        </Banner>
      ) : null}

      {job.error ? (
        <Banner tone="danger" title={job.error.message}>
          {job.error.remedy}
        </Banner>
      ) : null}

      {output?.finalPath ? (
        <div className="card overflow-hidden">
          <video
            key={output.finalPath}
            src={mediaUrl(output.finalPath)}
            poster={output.posterPath ? mediaUrl(output.posterPath) : undefined}
            controls
            playsInline
            className="mx-auto max-h-[70vh] w-full bg-black object-contain"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              <span className="chip">
                {output.width}×{output.height}
              </span>
              <span className="chip">{output.durationSec}s</span>
              <span className="chip">{job.shots.length} shot(s)</span>
            </div>
            <a
              href={mediaUrl(output.finalPath)}
              download
              className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs
                         text-[var(--fg-muted)] transition hover:border-[var(--accent)] hover:text-[var(--fg)]"
            >
              Download
            </a>
          </div>
        </div>
      ) : null}

      {output && !output.finalPath && output.notes.length > 0 ? (
        <Banner tone="info" title="Composition did not run">
          {output.notes.join(" ")}
        </Banner>
      ) : null}

      {/* Per-shot clips, so a partially successful job is still useful. */}
      {job.shots.some((s) => s.outputPath) ? (
        <div className="card p-5">
          <p className="field-label">Individual shots</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {job.shots
              .filter((s) => s.outputPath)
              .map((shot) => (
                <div key={shot.shotId} className="rounded-lg border border-[var(--border)] p-2">
                  <p className="mb-2 text-[11px] text-[var(--fg-muted)]">{shot.title}</p>
                  {shot.outputPath!.endsWith(".txt") ? (
                    <a
                      href={mediaUrl(shot.outputPath!)}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded bg-[var(--bg-input)] p-4 text-center text-[11px] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    >
                      FFmpeg unavailable — open the request manifest
                    </a>
                  ) : (
                    <video
                      src={mediaUrl(shot.outputPath!)}
                      controls
                      playsInline
                      className="w-full rounded bg-black"
                    />
                  )}
                  {shot.quality ? (
                    <div className="mt-2">
                      <Meter value={shot.quality.overall} />
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        </div>
      ) : null}

      <details className="card p-5">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.12em] text-[var(--fg-muted)]">
          Generation log ({job.logs.length})
        </summary>
        <div className="mt-3 max-h-80 space-y-1 overflow-auto font-mono text-[11px]">
          {job.logs.map((entry, i) => (
            <p
              key={i}
              className={
                entry.level === "error"
                  ? "text-[var(--danger)]"
                  : entry.level === "warn"
                    ? "text-[var(--warning)]"
                    : "text-[var(--fg-subtle)]"
              }
            >
              <span className="text-[var(--fg-subtle)]">{entry.ts.slice(11, 19)}</span> {entry.message}
            </p>
          ))}
        </div>
      </details>

      {job.provider ? (
        <p className="text-[11px] text-[var(--fg-subtle)]">
          Provider: {humanise(job.provider.resolvedId)} · status {humanise(job.status)}
        </p>
      ) : null}
    </div>
  );
}
