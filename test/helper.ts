import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../dist/manager/ctx.js";

export interface FakeCtxOptions {
  env?: Record<string, string>;
  lookPath?: Record<string, string>;
  run?: (cmd: string, args: string[]) => { stdout: string; stderr: string; code: number } | undefined;
}

export interface FakeCtx {
  ctx: Ctx;
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * fakeCtx builds a throwaway home directory so adapters never touch the real
 * one. Options may be a function of the temp root when they need its path.
 */
export async function fakeCtx(options: FakeCtxOptions | ((root: string) => FakeCtxOptions) = {}): Promise<FakeCtx> {
  const root = await mkdtemp(join(tmpdir(), "mirrorhub-test-"));
  const opts = typeof options === "function" ? options(root) : options;
  const ctx: Ctx = {
    platform: "win32",
    arch: "x64",
    home: root,
    appData: join(root, "Roaming"),
    localAppData: join(root, "Local"),
    xdgConfig: join(root, ".config"),
    dryRun: false,
    env: (key) => opts.env?.[key],
    lookPath: async (bin) => opts.lookPath?.[bin],
    run: async (cmd, args) => opts.run?.(cmd, args) ?? { stdout: "", stderr: "", code: 1 },
  };
  return { ctx, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
