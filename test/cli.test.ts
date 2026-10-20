import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, "..");
const entry = join(project, "dist", "index.js");

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

function cli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { cwd: project, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const raw = (err as (Error & { code?: unknown }) | null)?.code;
        const code = err ? (typeof raw === "number" ? raw : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

function envelope(run: Run): any {
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`not JSON: ${run.stdout.slice(0, 400)}\nstderr: ${run.stderr.slice(0, 400)}`);
  }
}

test("version -j prints a JSON envelope", async () => {
  const run = await cli(["version", "-j"]);
  assert.equal(run.code, 0);
  const body = envelope(run);
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.equal(body.ok, true);
  assert.equal(body.data.version, pkg.version);
  assert.match(body.data.node, /^v\d+/);
});

test("package.json stays the single source of truth for the published version", async () => {
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.equal(pkg.name, "@mirrorhub/cli");
  const run = await cli(["version", "-j"]);
  assert.equal(run.code, 0);
  assert.equal(envelope(run).data.version, pkg.version);
});

test("mirrors npm -j lists every built-in mirror with the official one first", async () => {
  const run = await cli(["mirrors", "npm", "-j"]);
  assert.equal(run.code, 0);
  const body = envelope(run);
  assert.equal(body.ok, true);
  const entry = body.data.mirrors[0];
  assert.equal(entry.tool, "npm");
  assert.equal(entry.mirrors.length, 5);
  assert.equal(entry.mirrors[0].id, "official");
  assert.ok(entry.mirrors.every((m: any) => typeof m.url === "string"));
});

test("ls -j reports all eleven tools", async () => {
  const run = await cli(["ls", "-j"]);
  assert.equal(run.code, 0);
  const body = envelope(run);
  assert.equal(body.ok, true);
  assert.equal(body.data.summary.tools, 11);
  assert.equal(body.data.tools.length, 11);
  assert.ok(body.data.tools.some((t: any) => t.id === "npm"));
});

test("use with a dry-run never writes and reports the target", async () => {
  const run = await cli(["use", "npm", "npmmirror", "-n", "-j"]);
  assert.equal(run.code, 0);
  const body = envelope(run);
  assert.equal(body.ok, true);
  assert.equal(body.data.dry_run, true);
  assert.equal(body.data.mirror.id, "npmmirror");
});

test("unknown mirror exits 2 with a structured error", async () => {
  const run = await cli(["use", "npm", "no-such-mirror", "-j"]);
  assert.equal(run.code, 2);
  const body = envelope(run);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "unknown_mirror");
  assert.ok(body.error.message.length > 0);
});

test("unknown command exits 2 with a structured error", async () => {
  const run = await cli(["frobnicate", "-j"]);
  assert.equal(run.code, 2);
  const body = envelope(run);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "bad_request");
});

test("--help prints usage and exits 0", async () => {
  const run = await cli(["--help"]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /用法/);
  assert.match(run.stdout, /mirrorhub ls/);
});
