/**
 * Doc is a tiny line-oriented editor for the config dialects MirrorHub touches:
 * ini/.npmrc/key=value, .yarnrc-style "key value", and TOML-ish sections.
 *
 * It deliberately keeps formatting it does not understand: comments, ordering,
 * unrelated keys and the original line endings all survive a write.
 */

export interface SetStyle {
  /** Separator between key and value. Defaults to "=". */
  sep?: string;
  /** Quote character to wrap the value in; false (default) writes it bare. */
  quote?: string | false;
}

interface KV {
  key: string;
  sep: string;
  value: string;
  indent: string;
}

export class Doc {
  lines: string[];
  eol: string;

  constructor(lines: string[], eol = "\n") {
    this.lines = lines;
    this.eol = eol;
  }

  static parse(content: string): Doc {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    if (content === "") return new Doc([], eol);
    const body = content.endsWith(eol) ? content.slice(0, -eol.length) : content;
    return new Doc(body.split(eol), eol);
  }

  toString(): string {
    if (this.lines.length === 0) return "";
    return this.lines.join(this.eol) + this.eol;
  }

  /** get returns the last value for key inside section ("" for top level). */
  get(section: string, key: string): string | undefined {
    const range = this.range(section);
    if (!range) return undefined;
    let found: string | undefined;
    for (let i = range.start; i < range.end; i++) {
      const kv = parseKV(this.lines[i]);
      if (kv && kv.key.toLowerCase() === key.toLowerCase()) found = unquote(kv.value);
    }
    return found;
  }

  hasSection(section: string): boolean {
    return this.range(section) !== undefined;
  }

  keys(section: string): string[] {
    const range = this.range(section);
    if (!range) return [];
    const out: string[] = [];
    for (let i = range.start; i < range.end; i++) {
      const kv = parseKV(this.lines[i]);
      if (kv) out.push(kv.key);
    }
    return out;
  }

  set(section: string, key: string, value: string, style: SetStyle = {}): void {
    const sep = style.sep ?? "=";
    const rendered = style.quote ? style.quote + value + style.quote : value;
    const range = this.range(section);
    if (range) {
      let target = -1;
      for (let i = range.start; i < range.end; i++) {
        const kv = parseKV(this.lines[i]);
        if (kv && kv.key.toLowerCase() === key.toLowerCase()) target = i;
      }
      if (target >= 0) {
        const existing = parseKV(this.lines[target]);
        const indent = existing?.indent ?? "";
        // Keep the separator the file already uses ("=" vs " = " vs " ") unless overridden.
        const chosen = style.sep ?? existingSep(this.lines[target], existing?.key ?? key) ?? "=";
        this.lines[target] = indent + key + chosen + rendered;
        return;
      }
      this.insert(range.end, key + sep + rendered);
      return;
    }
    // Section does not exist yet: append it as a new block.
    if (this.lines.length > 0) this.lines.push("");
    this.lines.push("[" + section + "]");
    this.lines.push(key + sep + rendered);
  }

  delete(section: string, key: string): boolean {
    const range = this.range(section);
    if (!range) return false;
    let removed = false;
    for (let i = range.end - 1; i >= range.start; i--) {
      const kv = parseKV(this.lines[i]);
      if (kv && kv.key.toLowerCase() === key.toLowerCase()) {
        this.lines.splice(i, 1);
        removed = true;
      }
    }
    return removed;
  }

  deleteSection(section: string): boolean {
    const full = this.fullRange(section);
    if (!full) return false;
    this.lines.splice(full.start, full.end - full.start);
    return true;
  }

  /** range returns the content line indexes of a section, or undefined. */
  private range(section: string): { start: number; end: number } | undefined {
    if (section === "") {
      const first = this.lines.findIndex((l) => sectionName(l) !== undefined);
      return { start: 0, end: first < 0 ? this.lines.length : first };
    }
    for (let i = 0; i < this.lines.length; i++) {
      if (sectionName(this.lines[i]) === section) {
        let end = i + 1;
        while (end < this.lines.length && sectionName(this.lines[end]) === undefined) end++;
        return { start: i + 1, end };
      }
    }
    return undefined;
  }

  private fullRange(section: string): { start: number; end: number } | undefined {
    const body = this.range(section);
    if (!body) return undefined;
    if (section === "") return body;
    return { start: body.start - 1, end: body.end };
  }

  private insert(at: number, line: string): void {
    this.lines.splice(at, 0, line);
  }
}

export function sectionName(line: string): string | undefined {
  const m = /^\s*\[([^\[\]][^\]]*)\]\s*(?:[#;].*)?$/.exec(line);
  return m ? m[1].trim() : undefined;
}

export function parseKV(line: string): KV | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) return undefined;
  if (sectionName(line) !== undefined) return undefined;
  const indent = line.slice(0, line.length - line.trimStart().length);

  const eq = trimmed.indexOf("=");
  if (eq > 0) {
    return { key: trimmed.slice(0, eq).trim(), sep: "=", value: trimmed.slice(eq + 1).trim(), indent };
  }
  const colon = trimmed.indexOf(":");
  if (colon > 0 && !trimmed.slice(0, colon).includes(" ")) {
    return { key: trimmed.slice(0, colon).trim(), sep: ":", value: trimmed.slice(colon + 1).trim(), indent };
  }
  const m = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (m) return { key: m[1], sep: " ", value: m[2].trim(), indent };
  return undefined;
}

/** existingSep returns the raw separator (with spacing) that follows key. */
export function existingSep(line: string, key: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith(key.toLowerCase())) return undefined;
  const rest = trimmed.slice(key.length);
  const m = /^(\s*[=:]\s*|\s+)/.exec(rest);
  return m ? m[1] : undefined;
}

export function unquote(value: string): string {
  let v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) {
    const quote = v[0];
    const close = v.indexOf(quote, 1);
    if (close > 0) return v.slice(1, close);
  }
  const comment = /\s+[#;]/.exec(v);
  if (comment) v = v.slice(0, comment.index);
  return v.trim();
}
