import { official, mirrors as catalogMirrors } from "./catalog.js";
import { forTool, type Adapter } from "./manager/adapters.js";
import { exists, firstVersion, newCtx, normalizeUrl, type Ctx } from "./manager/ctx.js";
import type { Change, ListData, Mirror, ProbeResult, Status, Summary, ToolView } from "./model.js";
import * as probe from "./probe.js";
import { find, ids as registryIds, type ToolMeta } from "./registry.js";
import { UserConfig } from "./userconfig.js";
import { version } from "./version.js";

export type ErrorCode =
  | "unknown_tool"
  | "unknown_mirror"
  | "bad_request"
  | "read_failed"
  | "write_failed"
  | "not_found"
  | "no_usable_mirror";

/** AppError carries a machine-readable code plus a human hint for the CLI. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ServiceOptions {
  ctx?: Ctx;
  user?: UserConfig;
  cache?: probe.Cache;
  probeTimeout?: number;
  cacheTtl?: number;
  workers?: number;
}

export interface ListOptions {
  installedOnly?: boolean;
}

export interface TestOptions {
  refresh?: boolean;
  /** Reports fresh probe progress; cached entries are not counted. */
  onProgress?: (done: number, total: number) => void;
}

export interface FastestOptions extends TestOptions {
  apply?: boolean;
}

export interface FastestResult {
  tool: string;
  mirror: Mirror;
  probe: ProbeResult;
  change: Change | null;
  tested: number;
}

export interface MirrorListEntry {
  tool: string;
  name: string;
  mirrors: Mirror[];
}

/**
 * Service is the single entry point shared by the CLI and the local GUI:
 * every mutation goes through it, so behaviour cannot drift between the two.
 */
export class Service {
  readonly ctx: Ctx;
  readonly user: UserConfig;
  readonly cache: probe.Cache;
  private readonly probeTimeout: number;
  private readonly cacheTtl: number;
  private readonly workers: number;

  private constructor(ctx: Ctx, user: UserConfig, cache: probe.Cache, probeTimeout: number, cacheTtl: number, workers: number) {
    this.ctx = ctx;
    this.user = user;
    this.cache = cache;
    this.probeTimeout = probeTimeout;
    this.cacheTtl = cacheTtl;
    this.workers = workers;
  }

  static async create(opts: ServiceOptions = {}): Promise<Service> {
    const ctx = opts.ctx ?? newCtx();
    const user = opts.user ?? (await UserConfig.load(ctx));
    return new Service(
      ctx,
      user,
      opts.cache ?? new probe.Cache(),
      opts.probeTimeout ?? 8000,
      opts.cacheTtl ?? 5 * 60_000,
      opts.workers ?? 3,
    );
  }

  get version(): string {
    return version;
  }

  /** mirrorsFor returns built-in mirrors plus the user's own additions. */
  mirrorsFor(tool: string): Mirror[] {
    return [...catalogMirrors(tool), ...this.user.get(tool)];
  }

  listMirrors(): MirrorListEntry[] {
    return registryIds().map((id) => ({ tool: id, name: find(id)?.name ?? id, mirrors: this.mirrorsFor(id) }));
  }

  async view(id: string): Promise<ToolView> {
    const meta = this.requireTool(id);
    const adapter = forTool(meta.id);
    const view: ToolView = {
      id: meta.id,
      name: meta.name,
      category: meta.category,
      installed: false,
      on_path: false,
      config_exists: false,
      current: { source: "", raw: "", file: "", origin: "unknown" },
      supports_write: Boolean(adapter),
      mirrors: this.mirrorsFor(meta.id),
    };

    for (const bin of meta.binaries) {
      const found = await this.ctx.lookPath(bin);
      if (!found) continue;
      view.on_path = true;
      view.binary = found;
      const out = await this.ctx.run(bin, meta.versionArgs);
      view.version = firstVersion(out.stdout) ?? firstVersion(out.stderr);
      break;
    }

    if (adapter) {
      try {
        view.current = await adapter.read(this.ctx);
        if (view.current.file) {
          view.config_file = view.current.file;
          view.config_exists = await exists(view.current.file);
        }
        const match = this.matchMirror(meta.id, view.current.source);
        if (match) view.mirror_id = match.id;
      } catch (err) {
        view.error = (err as Error).message;
      }
    }

    view.installed = view.on_path || view.config_exists;
    return view;
  }

  async views(opts: ListOptions = {}): Promise<ListData> {
    const all = await Promise.all(registryIds().map((id) => this.view(id)));
    const tools = opts.installedOnly ? all.filter((t) => t.installed) : all;
    const installed = all.filter((t) => t.installed).length;
    const summary: Summary = {
      tools: tools.length,
      installed: opts.installedOnly ? tools.length : installed,
      configured: all.filter((t) => t.mirror_id !== undefined && t.mirror_id !== "official").length,
    };
    return { summary, tools };
  }

  async apply(tool: string, mirrorRef: string): Promise<Change> {
    const { meta, adapter } = this.requireWritable(tool);
    const mirror = this.mirrorOf(meta.id, mirrorRef);
    const before = await this.readStatus(adapter);
    let after: Status;
    try {
      after = this.ctx.dryRun ? await this.dryRunStatus(adapter, before, mirror) : await adapter.apply(this.ctx, mirror);
    } catch (err) {
      throw new AppError("write_failed", `写入 ${meta.name} 配置失败：${(err as Error).message}`, "确认配置文件没有被其他程序占用，或改用 --dry-run 查看将要写入的内容");
    }
    return this.change(meta.id, mirror, before, after);
  }

  async reset(tool: string): Promise<Change> {
    const { meta, adapter } = this.requireWritable(tool);
    const before = await this.readStatus(adapter);
    let after: Status;
    try {
      after = this.ctx.dryRun ? await this.dryRunStatus(adapter, before, official(meta.id)) : await adapter.reset(this.ctx);
    } catch (err) {
      throw new AppError("write_failed", `还原 ${meta.name} 配置失败：${(err as Error).message}`);
    }
    return this.change(meta.id, official(meta.id), before, after);
  }

  async test(tool?: string, opts: TestOptions = {}): Promise<ProbeResult[]> {
    const targets: probe.Target[] = [];
    const toolIds = tool ? [this.requireTool(tool).id] : registryIds().filter((id) => forTool(id) !== undefined);
    for (const id of toolIds) {
      for (const mirror of this.mirrorsFor(id)) {
        targets.push({ tool_id: id, mirror_id: mirror.id, name: mirror.name, url: mirror.probe ?? mirror.url });
      }
    }

    const results: ProbeResult[] = new Array(targets.length);
    const fresh: probe.Target[] = [];
    const freshAt: number[] = [];
    targets.forEach((target, i) => {
      const hit = opts.refresh ? undefined : this.cache.get(target.url, this.cacheTtl);
      if (hit) {
        results[i] = { ...hit, tool_id: target.tool_id, mirror_id: target.mirror_id, name: target.name };
      } else {
        freshAt.push(i);
        fresh.push(target);
      }
    });

    if (fresh.length > 0) {
      const measured = await probe.run(fresh, {
        workers: this.workers,
        timeoutMs: this.probeTimeout,
        onProgress: opts.onProgress,
      });
      measured.forEach((result, j) => {
        results[freshAt[j]] = result;
        this.cache.put(result.url, result);
      });
    }
    return results;
  }

  /**
   * spreadResults copies a measurement onto every tool that points at the same
   * URL: npm, pnpm and yarn share registries, so testing one should light up
   * the others in the GUI instead of leaving them blank.
   */
  spreadResults(results: ProbeResult[]): ProbeResult[] {
    const seen = new Set(results.map((r) => `${r.tool_id}|${r.mirror_id}`));
    const byUrl = new Map<string, ProbeResult>();
    for (const result of results) byUrl.set(normalizeUrl(result.url), result);

    const spread = [...results];
    for (const id of registryIds()) {
      if (!forTool(id)) continue;
      for (const mirror of this.mirrorsFor(id)) {
        const key = `${id}|${mirror.id}`;
        const url = mirror.probe ?? mirror.url;
        const hit = byUrl.get(normalizeUrl(url));
        if (!hit || seen.has(key)) continue;
        seen.add(key);
        spread.push({ ...hit, tool_id: id, mirror_id: mirror.id, name: mirror.name, url });
      }
    }
    return spread;
  }

  async fastest(tool: string, opts: FastestOptions = {}): Promise<FastestResult> {
    this.requireTool(tool);
    const results = await this.test(tool, { refresh: opts.refresh, onProgress: opts.onProgress });
    const usable = results.filter((r) => r.ok).sort((a, b) => a.ttfb_ms - b.ttfb_ms);
    if (usable.length === 0) {
      throw new AppError("no_usable_mirror", `${tool} 的所有镜像都探测失败`, "检查网络，或设置 HTTP_PROXY / HTTPS_PROXY 后再试");
    }
    const best = usable[0];
    const mirror = this.mirrorOf(tool, best.mirror_id);
    const change = opts.apply ? await this.apply(tool, mirror.id) : null;
    return { tool, mirror, probe: best, change, tested: usable.length };
  }

  async addCustom(tool: string, input: { id?: string; name?: string; url?: string; note?: string }): Promise<Mirror> {
    const meta = this.requireTool(tool);
    try {
      return await this.user.add(this.ctx, meta.id, input);
    } catch (err) {
      throw new AppError("bad_request", (err as Error).message, "示例：mirrorhub add npm --name 公司源 --url https://registry.example.com/");
    }
  }

  async removeCustom(tool: string, id: string): Promise<void> {
    const meta = this.requireTool(tool);
    const removed = await this.user.remove(this.ctx, meta.id, id);
    if (!removed) throw new AppError("not_found", `${meta.id} 没有自定义镜像 ${id}`, "用 mirrorhub mirrors " + meta.id + " 查看现有镜像 id");
  }

  // ------------------------------------------------------------- internals

  private requireTool(id: string): ToolMeta {
    const meta = find(id);
    if (!meta) throw new AppError("unknown_tool", `未知工具：${id}`, `支持的工具：${registryIds().join("、")}`);
    return meta;
  }

  private requireWritable(tool: string): { meta: ToolMeta; adapter: Adapter } {
    const meta = this.requireTool(tool);
    const adapter = forTool(meta.id);
    if (!adapter) throw new AppError("bad_request", `${meta.name} 还不支持自动写入`, "可以用 mirrorhub mirrors 查看支持的镜像，手动修改配置");
    return { meta, adapter };
  }

  private mirrorOf(tool: string, ref: string): Mirror {
    const mirrors = this.mirrorsFor(tool);
    const wanted = ref.trim();
    const byId = mirrors.find((m) => m.id === wanted);
    if (byId) return byId;
    const target = normalizeUrl(wanted);
    const byUrl = mirrors.find((m) => normalizeUrl(m.url) === target);
    if (byUrl) return byUrl;
    const byName = mirrors.find((m) => m.name.toLowerCase() === wanted.toLowerCase());
    if (byName) return byName;
    throw new AppError(
      "unknown_mirror",
      `${tool} 没有镜像：${wanted}`,
      `可用镜像：${mirrors.map((m) => m.id).join("、")}（也可以用完整 URL）`,
    );
  }

  private matchMirror(tool: string, source: string): Mirror | undefined {
    if (!source) return undefined;
    const target = normalizeUrl(source);
    return this.mirrorsFor(tool).find((m) => normalizeUrl(m.url) === target);
  }

  /** dryRunStatus shows where the write would land without touching the disk. */
  private async dryRunStatus(adapter: Adapter, before: Status, mirror: Mirror): Promise<Status> {
    const files = await adapter.configFiles(this.ctx).catch(() => [] as string[]);
    return {
      source: mirror.url,
      raw: `dry-run → ${mirror.url}`,
      file: before.file || files[0] || "",
      origin: before.origin === "env" ? "env" : "file",
      note: "dry-run：未写入文件",
    };
  }

  private async readStatus(adapter: Adapter): Promise<Status> {
    try {
      return await adapter.read(this.ctx);
    } catch (err) {
      throw new AppError("read_failed", `读取配置失败：${(err as Error).message}`);
    }
  }

  private change(tool: string, mirror: Mirror, before: Status, after: Status): Change {
    const changed = normalizeUrl(before.source) !== normalizeUrl(after.source);
    const out: Change = {
      tool,
      mirror,
      before,
      after,
      file: after.file || before.file,
      dry_run: this.ctx.dryRun,
      changed,
    };
    if (after.backup) out.backup = after.backup;
    const note = after.note ?? (changed ? undefined : "已经是这个镜像，未改动文件");
    if (note) out.note = note;
    return out;
  }
}
