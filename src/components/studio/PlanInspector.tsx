"use client";

import { useState } from "react";
import type { CompiledSpecPrompts } from "@/lib/prompts/prompt-compiler";
import type { ShotJob } from "@/lib/jobs/types";
import type { VideoGenerationSpec } from "@/lib/spec/spec";
import { Disclosure, Meter, Row, humanise } from "./primitives";

/**
 * The plan inspector.
 *
 * This is the window into the engine: what the Director inferred, how the shots
 * were planned, which camera was chosen and why, what realism and consistency
 * constraints fired, how references were bound, and the exact prompt that was
 * compiled. The point is that nothing about the sophistication is hidden.
 */
export function PlanInspector({
  spec,
  compiled,
  shots,
  notes,
}: {
  spec: VideoGenerationSpec;
  compiled: CompiledSpecPrompts | null;
  shots: ShotJob[];
  notes: string[];
}) {
  return (
    <div className="space-y-3">
      <div className="card p-5">
        <p className="text-xs uppercase tracking-[0.14em] text-[var(--fg-subtle)]">Logline</p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--fg)]">{spec.creative.logline}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="chip">{humanise(spec.creative.socialArchetype)}</span>
          <span className="chip">{humanise(spec.creative.visualStyle)}</span>
          <span className="chip">{humanise(spec.creative.colorGrade)}</span>
          <span className="chip">{humanise(spec.creative.mood)}</span>
          <span className="chip">{humanise(spec.realism.level)} realism</span>
          <span className="chip">
            {spec.delivery.aspectRatio} · {spec.delivery.totalDurationSec}s
          </span>
        </div>

        <div className="mt-4 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--fg-subtle)]">
          Directed by the{" "}
          <span className="text-[var(--fg-muted)]">
            {spec.directorMeta.engine === "llm" ? `LLM director (${spec.directorMeta.model})` : "heuristic director"}
          </span>
          {spec.directorMeta.fallbackUsed ? " after the LLM path failed" : ""} in{" "}
          {spec.directorMeta.elapsedMs}ms.
        </div>
      </div>

      <Disclosure label="Scene" badge={`${spec.scene.subjects.length} subject(s)`}>
        <div className="space-y-3">
          <Row label="Setting" value={spec.scene.environment.setting} />
          <Row label="Time" value={humanise(spec.scene.environment.timeOfDay)} />
          <Row label="Lighting" value={humanise(spec.scene.environment.lighting)} />
          <Row label="Background" value={humanise(spec.scene.environment.backgroundActivity)} />

          <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
            {spec.scene.subjects.map((subject) => (
              <div key={subject.key} className="rounded-md bg-[var(--bg-input)] p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--fg)]">{subject.label}</span>
                  <span className="chip">{humanise(subject.kind)}</span>
                  {subject.hero ? (
                    <span className="chip border-[var(--accent)]/40 text-[var(--accent)]">hero</span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-xs text-[var(--fg-muted)]">{subject.description}</p>
                {subject.identityNotes.length > 0 ? (
                  <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                    Locked: {subject.identityNotes.join(" · ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Disclosure>

      <Disclosure label="Shot plan" badge={`${spec.shots.length} shot(s)`} defaultOpen>
        <div className="space-y-3">
          {spec.shots.map((shot) => {
            const job = shots.find((s) => s.shotId === shot.id);
            const prompt = compiled?.shots.find((s) => s.shotId === shot.id);
            return <ShotCard key={shot.id} shot={shot} job={job} prompt={prompt} />;
          })}
        </div>
      </Disclosure>

      <Disclosure label="References" badge={`${spec.references.length} bound`}>
        {spec.references.length === 0 ? (
          <p className="text-xs text-[var(--fg-muted)]">
            No reference images. Every subject is being generated from the text description alone —
            attaching a product or character reference is the single biggest quality lever available.
          </p>
        ) : (
          <div className="space-y-2">
            {spec.references.map((ref) => (
              <div key={ref.referenceId} className="rounded-md bg-[var(--bg-input)] p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-[var(--fg)]">{ref.label}</span>
                  <span className="chip">{humanise(ref.role)}</span>
                  <span className="chip">{humanise(ref.usage)}</span>
                  <span className="chip">{humanise(ref.adherence)}</span>
                  <span className="chip">weight {ref.weight}</span>
                </div>
                {ref.preserve.length > 0 ? (
                  <p className="mt-1.5 text-[11px] text-[var(--fg-subtle)]">
                    Preserving: {ref.preserve.join(" · ")}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                  {ref.shotIds === null ? "Applies to every shot." : `Applies to ${ref.shotIds.length} shot(s).`}
                </p>
                {ref.usage === "descriptive_only" ? (
                  <p className="mt-1 text-[11px] text-[var(--warning)]">
                    This provider cannot condition on the image — it is described in words instead.
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Disclosure>

      <Disclosure label="Consistency" badge={`strength ${spec.consistency.strength}`}>
        <div className="space-y-2">
          <Row label="Seed policy" value={`${humanise(spec.consistency.seedPolicy)} · base ${spec.consistency.baseSeed}`} />
          {Object.entries(spec.consistency.crossShot)
            .filter(([, v]) => v !== "off")
            .map(([key, value]) => (
              <Row key={key} label={humanise(key)} value={humanise(value as string)} />
            ))}
          {spec.consistency.continuityNotes.length > 0 ? (
            <ul className="mt-3 space-y-1 border-t border-[var(--border)] pt-3">
              {spec.consistency.continuityNotes.map((note, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
                  · {note}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Disclosure>

      <Disclosure
        label="Realism constraints"
        badge={`${spec.realism.positives.length} + ${spec.realism.negatives.length}`}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="field-label">Applied</p>
            <ul className="space-y-1">
              {spec.realism.positives.map((line, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
                  · {line}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="field-label">Avoided</p>
            <ul className="space-y-1">
              {spec.realism.negatives.map((line, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-[var(--fg-subtle)]">
                  · {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-4 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--fg-subtle)]">
          Fired by rules: {spec.realism.appliedRuleIds.join(", ")}
        </p>
      </Disclosure>

      {notes.length > 0 ? (
        <Disclosure label="Planner decisions" badge={`${notes.length}`}>
          <ul className="space-y-1.5">
            {notes.map((note, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
                · {note}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ShotCard({
  shot,
  job,
  prompt,
}: {
  shot: VideoGenerationSpec["shots"][number];
  job: ShotJob | undefined;
  prompt: CompiledSpecPrompts["shots"][number] | undefined;
}) {
  const [tab, setTab] = useState<"craft" | "prompt">("craft");

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-input)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--fg)]">{shot.title}</span>
          <span className="chip">{shot.durationSec}s</span>
          {job ? <ShotStatusChip status={job.status} /> : null}
        </div>
        <div className="flex gap-1">
          {(["craft", "prompt"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-1 text-[11px] transition ${
                tab === t ? "bg-[var(--border-strong)] text-[var(--fg)]" : "text-[var(--fg-subtle)] hover:text-[var(--fg)]"
              }`}
            >
              {t === "craft" ? "Direction" : "Compiled prompt"}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        {tab === "craft" ? (
          <div className="space-y-1">
            <p className="mb-2 text-xs leading-relaxed text-[var(--fg-muted)]">{shot.action}</p>
            <Row label="Camera" value={`${shot.camera.presetLabel} · ${humanise(shot.camera.primaryMove)}`} />
            <Row
              label="Framing"
              value={`${humanise(shot.camera.shotSize)} · ${humanise(shot.camera.angle)} · ${shot.camera.focalLengthMm}mm`}
            />
            <Row
              label="Movement"
              value={`intensity ${shot.camera.moveIntensity} · speed ${shot.camera.moveSpeed} · jitter ${shot.camera.microJitter}`}
            />
            <Row label="Focus" value={`${humanise(shot.camera.depthOfField)} · ${humanise(shot.camera.focusBehavior)}`} />
            <Row
              label="Motion"
              value={`${humanise(shot.motion.subjectMotion)} subject · ${humanise(shot.motion.motionBlur)} blur`}
            />
            <Row label="Seed" value={String(shot.seed)} />
            <p className="mt-3 border-t border-[var(--border)] pt-2 text-[11px] italic leading-relaxed text-[var(--fg-subtle)]">
              {shot.camera.rationale}
            </p>
            {job?.quality ? <QualitySummary report={job.quality} /> : null}
            {job && job.attempts.length > 1 ? (
              <div className="mt-3 border-t border-[var(--border)] pt-2">
                <p className="field-label">Repair history</p>
                {job.attempts.map((a) => (
                  <p key={a.id} className="text-[11px] text-[var(--fg-muted)]">
                    Attempt {a.attempt + 1}: {a.status}
                    {a.repairChanges.length > 0 ? ` — ${a.repairChanges.join(" ")}` : ""}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : prompt ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <span className="chip">~{prompt.approxTokens} tokens</span>
              <span className="chip">
                {prompt.parameters.width}×{prompt.parameters.height} · {prompt.parameters.frames} frames
              </span>
              <span className="chip">adherence {prompt.parameters.promptAdherence}</span>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-muted)]">
              {prompt.positive}
            </pre>
            {prompt.negative ? (
              <div>
                <p className="field-label">Negative</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-subtle)]">
                  {prompt.negative}
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-[var(--fg-subtle)]">Prompt not compiled yet.</p>
        )}
      </div>
    </div>
  );
}

function ShotStatusChip({ status }: { status: ShotJob["status"] }) {
  const tone =
    status === "completed"
      ? "text-[var(--success)] border-[var(--success)]/40"
      : status === "failed"
        ? "text-[var(--danger)] border-[var(--danger)]/40"
        : status === "pending"
          ? "text-[var(--fg-subtle)]"
          : "text-[var(--accent)] border-[var(--accent)]/40 animate-pulse-soft";
  return <span className={`chip ${tone}`}>{humanise(status)}</span>;
}

function QualitySummary({ report }: { report: NonNullable<ShotJob["quality"]> }) {
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="field-label mb-0">Quality</p>
        <span className="chip">confidence: {report.confidence}</span>
      </div>
      <Meter value={report.overall} />
      <div className="mt-2 space-y-1">
        {report.scores.map((score) => (
          <div key={score.dimension} className="flex items-center gap-2">
            <span className="w-36 shrink-0 text-[10px] text-[var(--fg-subtle)]">
              {humanise(score.dimension)}
              {score.measured ? "" : " *"}
            </span>
            <Meter value={score.score} />
          </div>
        ))}
      </div>
      {report.issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {report.issues.map((issue, i) => (
            <li
              key={i}
              className={`text-[11px] ${issue.severity === "critical" ? "text-[var(--danger)]" : "text-[var(--warning)]"}`}
            >
              · {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {report.notCheckedNotes.length > 0 ? (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--fg-subtle)]">
          * estimated, not measured. {report.notCheckedNotes.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
