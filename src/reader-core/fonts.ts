/**
 * Reading faces, shared with the desktop app.
 *
 * Monospace is the default because the pivot alignment is exact in it: every
 * glyph advances 1ch, so the focal column can be hit with arithmetic instead of
 * per-word canvas measurement. The proportional options are offered for
 * legibility (Atkinson Hyperlegible was designed for low vision) and taste, and
 * pay a measurement cost per new word.
 *
 * Differs from the desktop copy in one line only: the desktop derives
 * `ReaderFont` from its generated Tauri bindings, which do not exist here, so
 * the union is written out.
 */

export type ReaderFont =
  | "geist_mono"
  | "jet_brains_mono"
  | "atkinson_hyperlegible"
  | "geist";

export const FONT_STACKS: Record<ReaderFont, string> = {
  geist_mono: '"Geist Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
  jet_brains_mono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
  atkinson_hyperlegible: '"Atkinson Hyperlegible", system-ui, sans-serif',
  geist: '"Geist", system-ui, sans-serif',
};

/** UI chrome face. Deliberately not the reading face — the two jobs differ. */
export const UI_FONT = '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';

const MONOSPACE: ReadonlySet<ReaderFont> = new Set<ReaderFont>([
  "geist_mono",
  "jet_brains_mono",
]);

export function isMonospace(font: ReaderFont): boolean {
  return MONOSPACE.has(font);
}

export const FONT_LABELS: Record<ReaderFont, string> = {
  geist_mono: "Geist Mono",
  jet_brains_mono: "JetBrains Mono",
  atkinson_hyperlegible: "Atkinson Hyperlegible",
  geist: "Geist",
};
