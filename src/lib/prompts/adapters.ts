import type { PromptStyle } from "@/lib/providers/types";
import type { PromptBlueprint } from "./blueprint";

/**
 * Provider prompt adapters.
 *
 *   Universal VideoGenerationSpec -> PromptBlueprint -> Provider adapter -> model request
 *
 * Different video models want different things. A Wan/LTX-style model responds
 * best to flowing cinematic prose; some workflows want labelled blocks; older
 * SD-derived pipelines still respond to comma-separated tags. Swapping a model
 * means adding a renderer here, not touching the director.
 */

export interface RenderedPrompt {
  positive: string;
  negative: string;
  /** Section-by-section breakdown, shown in the UI's prompt inspector. */
  sections: Array<{ label: string; text: string }>;
}

export type PromptRenderer = (blueprint: PromptBlueprint) => RenderedPrompt;

/** Flowing prose, paragraph-separated. The best default for modern T2V/I2V models. */
export const renderCinematicProse: PromptRenderer = (b) => {
  const paragraphs: Array<{ label: string; lines: string[] }> = [
    { label: "Scene", lines: [b.headline, ...b.subjects] },
    { label: "Action", lines: b.action },
    { label: "References", lines: b.references },
    { label: "Camera", lines: b.camera },
    { label: "Lighting", lines: b.lighting },
    { label: "Motion", lines: b.motion },
    { label: "Atmosphere", lines: b.atmosphere },
    { label: "Continuity", lines: b.consistency },
    { label: "Realism", lines: b.realism },
    { label: "Aesthetic", lines: b.aesthetic },
  ];

  const sections = paragraphs
    .filter((p) => p.lines.length > 0)
    .map((p) => ({ label: p.label, text: p.lines.map(sentence).join(" ") }));

  return {
    positive: sections.map((s) => s.text).join("\n\n"),
    negative: b.negatives.join(", "),
    sections,
  };
};

/** Labelled blocks. Easier for ComfyUI workflows and for humans to debug. */
export const renderStructuredBlocks: PromptRenderer = (b) => {
  const blocks: Array<{ label: string; lines: string[] }> = [
    { label: "SCENE", lines: [b.headline] },
    { label: "SUBJECT", lines: b.subjects },
    { label: "ACTION", lines: b.action },
    { label: "REFERENCE", lines: b.references },
    { label: "CAMERA", lines: b.camera },
    { label: "LIGHT", lines: b.lighting },
    { label: "MOTION", lines: b.motion },
    { label: "ATMOSPHERE", lines: b.atmosphere },
    { label: "CONTINUITY", lines: b.consistency },
    { label: "REALISM", lines: b.realism },
    { label: "STYLE", lines: b.aesthetic },
  ];

  const sections = blocks
    .filter((blk) => blk.lines.length > 0)
    .map((blk) => ({ label: blk.label, text: `${blk.label}: ${blk.lines.map(sentence).join(" ")}` }));

  return {
    positive: sections.map((s) => s.text).join("\n"),
    negative: b.negatives.join(", "),
    sections,
  };
};

/** Comma-separated keywords, for older SD-lineage pipelines. */
export const renderTagSoup: PromptRenderer = (b) => {
  const tags = [
    ...b.keywords,
    ...b.subjects.map(stripToClause),
    ...b.action.map(stripToClause),
    ...b.realism.slice(0, 4).map(stripToClause),
  ]
    .map((t) => t.toLowerCase().replace(/\.$/, "").trim())
    .filter(Boolean);

  const positive = Array.from(new Set(tags)).join(", ");
  return {
    positive,
    negative: b.negatives.join(", "),
    sections: [{ label: "Tags", text: positive }],
  };
};

const RENDERERS: Record<PromptStyle, PromptRenderer> = {
  cinematic_prose: renderCinematicProse,
  structured_blocks: renderStructuredBlocks,
  tag_soup: renderTagSoup,
};

export function getRenderer(style: PromptStyle): PromptRenderer {
  return RENDERERS[style] ?? renderCinematicProse;
}

/** Ensures a line reads as a sentence without double-punctuating. */
function sentence(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Reduces a sentence to its first clause, for tag-style prompts. */
function stripToClause(line: string): string {
  return line.split(/[,.;]/)[0]?.trim() ?? "";
}
