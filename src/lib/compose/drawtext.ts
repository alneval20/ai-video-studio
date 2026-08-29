/**
 * Shared helpers for FFmpeg's `drawtext` filter.
 *
 * These were duplicated in the composer and the mock provider, which meant an
 * escaping fix in one place silently left the other exploitable to filter-graph
 * injection through prompt or caption text.
 */

/**
 * Escapes text for embedding in a `drawtext=text='...'` expression.
 *
 * Order matters: backslashes first, or subsequent escapes get double-escaped.
 * Single quotes are removed rather than escaped — FFmpeg's nested quoting rules
 * make them unreliable inside a filter-graph string, and dropping an apostrophe
 * is far better than breaking the whole graph.
 */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\;")
    .replace(/[\[\]]/g, "")
    // Newlines would terminate the filter description.
    .replace(/[\r\n]+/g, " ");
}

/** Greedy word wrap to a column width. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
