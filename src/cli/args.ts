/** Tiny argv parser: subcommands, boolean flags, and --key=value options. */

export interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

export const valueFlags = new Set(["port", "mirror", "name", "url", "note", "id", "timeout", "host"]);

const shortFlags: Record<string, string> = {
  j: "json",
  n: "dry-run",
  v: "verbose",
  h: "help",
  q: "quiet",
};

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (valueFlags.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) throw new UsageError(`参数 --${body} 需要一个值`);
        flags.set(body, next);
        i++;
        continue;
      }
      flags.set(body, true);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const name = shortFlags[arg.slice(1)];
      if (!name) throw new UsageError(`未知选项：${arg}`);
      flags.set(name, true);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function bool(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

export function str(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function allow(flags: Map<string, string | true>, allowed: string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) throw new UsageError(`未知选项：--${key}`);
  }
}
