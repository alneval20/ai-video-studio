"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import type { StoredReference } from "@/lib/references/types";
import { REFERENCE_ROLES, type ReferenceRole } from "@/lib/spec/vocab";
import { api } from "./api";
import { humanise } from "./primitives";

/**
 * Reference images with semantic roles.
 *
 * The role is the important part: it decides whether an image conditions the
 * model's identity understanding, its layout, or only its palette — so the
 * picker is right there on the thumbnail rather than buried in Advanced.
 */
export function ReferencePanel({
  references,
  projectId,
  onChange,
  onProjectId,
  disabled,
}: {
  references: StoredReference[];
  projectId: string | null;
  onChange: (refs: StoredReference[]) => void;
  onProjectId: (id: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (files.length === 0 || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadReferences(files, projectId, {});
      onProjectId(result.projectId);
      onChange([...references, ...result.references]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.deleteReference(id).catch(() => undefined);
    onChange(references.filter((r) => r.id !== id));
  }

  async function setRole(id: string, role: ReferenceRole) {
    const previous = references;
    // Optimistic update, then write through — the generation pipeline loads
    // roles from storage, so a role kept only in React state would be lost.
    onChange(references.map((r) => (r.id === id ? { ...r, role, roleSource: "user" } : r)));
    setError(null);
    try {
      await api.updateReferenceRole(id, role);
    } catch (e) {
      onChange(previous);
      setError(`Could not save the role for that image: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed
                    px-4 py-7 text-center transition
                    ${dragging ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border-strong)] hover:border-[var(--fg-subtle)]"}
                    ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        <p className="text-xs text-[var(--fg-muted)]">
          {busy ? "Uploading…" : "Drop images here, or click to browse"}
        </p>
        <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
          PNG, JPEG, WebP or AVIF — up to 12 MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/avif"
          className="hidden"
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}

      {references.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {references.map((ref) => (
            <li key={ref.id} className="overflow-hidden rounded-lg border border-[var(--border)]">
              <div className="relative aspect-square bg-[var(--bg-input)]">
                <Image
                  src={ref.url}
                  alt={ref.filename}
                  fill
                  unoptimized
                  sizes="200px"
                  className="object-cover"
                />
                <button
                  type="button"
                  onClick={() => void remove(ref.id)}
                  disabled={disabled}
                  aria-label={`Remove ${ref.filename}`}
                  className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-xs
                             text-white transition hover:bg-[var(--danger)] disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-1.5 p-2">
                <p className="truncate text-[11px] text-[var(--fg-muted)]" title={ref.filename}>
                  {ref.filename}
                </p>
                <select
                  value={ref.role}
                  disabled={disabled}
                  onChange={(e) => void setRole(ref.id, e.target.value as ReferenceRole)}
                  className="input px-2 py-1 text-[11px]"
                >
                  {REFERENCE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {humanise(role)}
                    </option>
                  ))}
                </select>
                {ref.roleSource === "inferred" ? (
                  <p className="text-[10px] text-[var(--fg-subtle)]">Role guessed from the filename</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
