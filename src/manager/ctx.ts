import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Everything an adapter needs to read and write the host, injectable in tests. */
export interface Ctx {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  appData: string;
  localAppData: string;
  xdgConfig: string;
  dryRun: boolean;
  env(key: string): string | undefined;
  lookPath(bin: string): Promise<string | undefined>;
  run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

export function newCtx(): Ctx {
  const home = homedir();
  const platform = osPlatform();
  const env = (key: string) => {
    const v = process.env[key];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };
  const appData = env("APPDATA") ?? join(home, "AppData", "Roaming");
  const localAppData = env("LOCALAPPDATA") ?? join(home, "AppData", "Local");
  const xdgConfig = env("XDG_CONFIG_HOME") ?? join(home, ".config");
  return {
    platform,
    arch: osArch(),
    home,
    appData,
    localAppData,
    xdgConfig,
    dryRun: false,
    env,
    lookPath: (bin) => lookPath(bin, platform === "win32"),
    run: (cmd, args) => runCommand(cmd, args),
  };
}

const winExts = [".exe", ".cmd", ".bat", ".com", ".ps1"];

/** lookPath mirrors the behaviour of the OS PATH search, including PATHEXT. */
export async function lookPath(bin: string, windows: boolean): Promise<string | undefined> {
  const pathVar = process.env.PATH ?? "";
  const exts = windows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const names = windows && winExts.some((e) => bin.toLowerCase().endsWith(e)) ? [bin] : windows ? exts.map((e) => bin + e.toLowerCase()).concat(bin) : [bin];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        const st = await fs.stat(candidate);
        if (!st.isFile()) continue;
        if (!windows) await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export function runCommand(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
  });
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readOrEmpty(file: string): Promise<{ content: string; exists: boolean }> {
  try {
    return { content: await fs.readFile(file, "utf8"), exists: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { content: "", exists: false };
    throw err;
  }
}

export function firstExisting(paths: string[], fallback: string): string {
  const defined = paths.filter(Boolean);
  return defined[0] ?? fallback;
}

/** firstExistingAsync returns the first path that is on disk, or fallback. */
export async function firstExistingAsync(paths: string[], fallback: string): Promise<string> {
  for (const p of paths) {
    if (p && (await exists(p))) return p;
  }
  return paths[0] ?? fallback;
}

export interface SaveResult {
  written: boolean;
  backup?: string;
}

/**
 * save writes content atomically, keeping a single .mirrorhub.bak copy of the
 * previous file. Nothing is written when the content is already identical or
 * when the context is in dry-run mode.
 */
export async function save(ctx: Ctx, file: string, content: string): Promise<SaveResult> {
  let prev: string | null = null;
  try {
    prev = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (prev === content) return { written: false };
  if (ctx.dryRun) return { written: false };
  await fs.mkdir(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (prev !== null) {
    backup = file + ".mirrorhub.bak";
    await fs.writeFile(backup, prev, "utf8");
  }
  const tmp = file + ".mirrorhub.tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
  return { written: true, backup };
}

/** normalizeUrl makes mirror URLs comparable: no sparse+ prefix, no ,direct
 * suffix, no trailing slash, case-insensitive. */
export function normalizeUrl(url: string): string {
  let s = (url ?? "").trim().toLowerCase();
  if (s.startsWith("sparse+")) s = s.slice("sparse+".length);
  const comma = s.indexOf(",");
  if (comma >= 0) s = s.slice(0, comma);
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

const versionRe = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/;

export function firstVersion(text: string): string | undefined {
  return versionRe.exec(text)?.[1];
}

export function majorVersion(version: string): number {
  const first = /^\s*(\d+)/.exec(version);
  return first ? Number(first[1]) : 0;
}
