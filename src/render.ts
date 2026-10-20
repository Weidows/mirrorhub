/** Terminal table rendering with East-Asian width awareness. */

export type Align = "left" | "right";

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function pad(text: string, width: number, align: Align = "left"): string {
  const diff = Math.max(0, width - displayWidth(text));
  return align === "right" ? " ".repeat(diff) + text : text + " ".repeat(diff);
}

/** table renders borderless columns separated by two spaces; trailing spaces are trimmed. */
export function table(headers: string[], rows: string[][], aligns: Align[] = []): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ""))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i], aligns[i] ?? "left")))
      .join("  ")
      .replace(/\s+$/, "");
  return [line(headers), ...rows.map(line)].join("\n");
}

export function ms(value: number): string {
  return value > 0 ? `${Math.round(value)}ms` : "-";
}
