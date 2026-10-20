import { promises as fs } from "node:fs";
import { join } from "node:path";

import { mirrors as catalogMirrors } from "./catalog.js";
import { save, type Ctx } from "./manager/ctx.js";
import type { Mirror } from "./model.js";

export interface CustomMirrorInput {
  id?: string;
  name?: string;
  url?: string;
  note?: string;
}

interface Shape {
  version?: number;
  mirrors?: Record<string, Mirror[]>;
}

/**
 * UserConfig stores mirrors the user added themselves in
 * %APPDATA%/mirrorhub/config.json (or ~/.config/mirrorhub/config.json).
 * Built-in mirrors stay in code so upgrades never clobber user additions.
 */
export class UserConfig {
  readonly file: string;
  private data: Shape;

  private constructor(file: string, data: Shape) {
    this.file = file;
    this.data = data;
  }

  static async load(ctx: Ctx): Promise<UserConfig> {
    const dir = ctx.platform === "win32" ? ctx.appData : ctx.xdgConfig;
    const file = join(dir, "mirrorhub", "config.json");
    let data: Shape = { version: 1, mirrors: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Shape;
      if (parsed && typeof parsed === "object" && parsed.mirrors && typeof parsed.mirrors === "object") {
        data = { version: 1, mirrors: parsed.mirrors };
      }
    } catch {
      // missing or unreadable config is the normal first-run case
    }
    return new UserConfig(file, data);
  }

  get(tool: string): Mirror[] {
    return (this.data.mirrors?.[tool] ?? []).map((m) => ({ ...m, custom: true }));
  }

  all(): Record<string, Mirror[]> {
    const out: Record<string, Mirror[]> = {};
    for (const [tool, list] of Object.entries(this.data.mirrors ?? {})) out[tool] = list.map((m) => ({ ...m, custom: true }));
    return out;
  }

  async add(ctx: Ctx, tool: string, input: CustomMirrorInput): Promise<Mirror> {
    const name = (input.name ?? "").trim();
    const url = (input.url ?? "").trim();
    if (!name) throw new Error("镜像名称不能为空");
    if (!/^https?:\/\//i.test(url)) throw new Error("镜像地址必须以 http:// 或 https:// 开头");

    const list = this.data.mirrors?.[tool] ?? [];
    for (const existing of list) {
      if (existing.url.trim().toLowerCase() === url.toLowerCase()) {
        throw new Error(`该镜像地址已存在（${existing.id}）`);
      }
    }

    const mirror: Mirror = {
      id: this.uniqueId(tool, input.id?.trim() || name),
      name,
      url,
      custom: true,
    };
    if (input.note) mirror.note = input.note;

    this.data.mirrors = { ...(this.data.mirrors ?? {}), [tool]: [...list, mirror] };
    await this.save(ctx);
    return mirror;
  }

  async remove(ctx: Ctx, tool: string, id: string): Promise<boolean> {
    const list = this.data.mirrors?.[tool] ?? [];
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    this.data.mirrors = { ...(this.data.mirrors ?? {}), [tool]: next };
    if (next.length === 0) delete this.data.mirrors[tool];
    await this.save(ctx);
    return true;
  }

  private uniqueId(tool: string, raw: string): string {
    const base = slug(raw) || "custom";
    const taken = new Set([...catalogMirrors(tool).map((m) => m.id), ...(this.data.mirrors?.[tool] ?? []).map((m) => m.id)]);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private async save(ctx: Ctx): Promise<void> {
    const body = JSON.stringify({ version: 1, mirrors: this.data.mirrors ?? {} }, null, 2) + "\n";
    await save(ctx, this.file, body);
  }
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
