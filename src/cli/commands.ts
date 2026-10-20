import { AppError, type FastestResult, type Service } from "../app.js";
import { normalizeUrl } from "../manager/ctx.js";
import type { Change, ListData, Mirror, ProbeResult, Status, ToolView } from "../model.js";
import { displayWidth, ms as fmtMs, pad, table } from "../render.js";
import { bool, str, UsageError, type Parsed } from "./args.js";
import { bold, cyan, dim, green, red, yellow } from "./term.js";

export interface CommandOutput {
  data: unknown;
  text: string;
}

const originLabel: Record<Status["origin"], string> = {
  file: "文件",
  env: "环境变量",
  command: "命令",
  default: "默认",
  unknown: "未知",
};

export async function runCommand(command: string, args: string[], flags: Parsed["flags"], service: Service): Promise<CommandOutput> {
  switch (command) {
    case "ls":
      return list(service, flags);
    case "mirrors":
      return mirrors(service, args);
    case "test":
      return test(service, args, flags);
    case "use":
      return use(service, args);
    case "reset":
      return reset(service, args);
    case "fastest":
      return fastest(service, args, flags);
    case "add":
      return add(service, args, flags);
    case "rm":
    case "remove":
      return remove(service, args);
    case "version":
      return {
        data: { version: service.version, node: process.version, platform: service.ctx.platform, arch: service.ctx.arch },
        text: `${cyan("mirrorhub")} ${service.version} ${dim(`(${process.version}, ${service.ctx.platform}/${service.ctx.arch})`)}`,
      };
    default:
      throw new UsageError(`未知命令：${command}`);
  }
}

function mirrorName(view: ToolView): string {
  if (!view.current.source) return "-";
  const found = view.mirrors.find((m) => m.id === view.mirror_id);
  return found ? found.name : dim("未识别");
}

async function list(service: Service, flags: Parsed["flags"]): Promise<CommandOutput> {
  const installedOnly = bool(flags, "installed");
  const verbose = bool(flags, "verbose");
  const data: ListData = await service.views({ installedOnly });

  if (data.tools.length === 0) {
    return { data, text: "没有检测到已安装的工具。" };
  }

  const headers = ["工具", "版本", "镜像", "来源", "地址"];
  if (verbose) headers.push("配置文件");
  const rows = data.tools.map((t) => {
    const row = [
      t.on_path ? t.id : dim(t.id),
      t.version ?? dim("-"),
      t.mirror_id ? mirrorName(t) : t.installed ? dim("未配置") : dim("-"),
      originLabel[t.current.origin],
      t.current.source || dim("-"),
    ];
    if (verbose) row.push(t.config_file ?? dim("-"));
    return row;
  });

  const lines = [table(headers, rows), ""];
  lines.push(dim(`${data.summary.tools} 个工具 · ${data.summary.installed} 个已安装 · ${data.summary.configured} 个已切换到非官方源`));
  const envTools = data.tools.filter((t) => t.current.origin === "env").map((t) => t.id);
  if (envTools.length > 0) lines.push(yellow(`环境变量仍优先于配置文件：${envTools.join("、")}`));
  const errored = data.tools.filter((t) => t.error);
  for (const t of errored) lines.push(red(`${t.id}: ${t.error}`));
  return { data, text: lines.join("\n") };
}

function mirrors(service: Service, args: string[]): CommandOutput {
  const wanted = args[0];
  const entries = wanted
    ? service.listMirrors().filter((e) => e.tool === wanted)
    : service.listMirrors();
  if (wanted && entries.length === 0) {
    throw new AppError("unknown_tool", `未知工具：${wanted}`, `支持：${service.listMirrors().map((e) => e.tool).join("、")}`);
  }

  const blocks = entries.map((entry) => {
    const width = Math.max(...entry.mirrors.map((m) => displayWidth(m.id)));
    const lines = [`${bold(entry.name)} ${dim(`(${entry.mirrors.length})`)}`];
    for (const m of entry.mirrors) {
      const official = m.official ? dim(" · 官方") : "";
      const custom = m.custom ? yellow(" · 自定义") : "";
      lines.push(`  ${pad(m.id, width + 2)} ${m.name}${official}${custom}  ${dim(m.url)}`);
    }
    return lines.join("\n");
  });

  return { data: { mirrors: entries }, text: blocks.join("\n\n") };
}

/** Rough stderr progress bar; quiet for JSON output and non-TTY runs. */
function progress(flags: Parsed["flags"]): { onProgress: (done: number, total: number) => void; clear: () => void } {
  const enabled = !bool(flags, "json") && Boolean(process.stderr.isTTY);
  const width = 20;
  return {
    onProgress(done, total) {
      if (!enabled) return;
      const filled = total === 0 ? width : Math.min(width, Math.round((done / total) * width));
      process.stderr.write(`\r测速 [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`);
    },
    clear() {
      if (enabled) process.stderr.write(`\r${" ".repeat(40)}\r`);
    },
  };
}

async function test(service: Service, args: string[], flags: Parsed["flags"]): Promise<CommandOutput> {
  const tool = args[0];
  const bar = progress(flags);
  let results: ProbeResult[];
  try {
    results = await service.test(tool, { refresh: bool(flags, "refresh"), onProgress: bar.onProgress });
  } finally {
    bar.clear();
  }

  const ordered = [...results].sort((a, b) => {
    if (a.tool_id !== b.tool_id) return a.tool_id.localeCompare(b.tool_id);
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.ttfb_ms - b.ttfb_ms;
  });

  const rows = ordered.map((r) => [
    r.tool_id,
    r.name,
    r.ok ? green("OK") : red("失败"),
    fmtMs(r.ttfb_ms),
    r.url,
    r.ok ? "" : dim(r.error ?? `HTTP ${r.status}`),
  ]);

  const ok = results.filter((r) => r.ok).length;
  const lines = [table(["工具", "镜像", "状态", "延迟", "地址", "错误"], rows), ""];
  lines.push(dim(`${ok}/${results.length} 个镜像可用`));
  if (ok === 0) lines.push(yellow("全部失败：检查网络，或设置 HTTP_PROXY / HTTPS_PROXY 后再试"));
  return { data: { results }, text: lines.join("\n") };
}

function changeText(change: Change, service: Service): string {
  const nameOf = (source: string): string => {
    if (!source) return "(未配置)";
    const hit = service.mirrorsFor(change.tool).find((m) => normalizeUrl(m.url) === normalizeUrl(source));
    return hit ? hit.name : source;
  };
  const before = change.before.source || "(未配置)";
  const after = change.after.source || "(未配置)";
  const lines = [`${bold(change.tool)}  ${nameOf(change.before.source)} → ${nameOf(change.after.source)}`];
  if (before !== after) lines.push(dim(`${before} → ${after}`));
  if (change.file) lines.push(dim(`配置文件 ${change.file}`));
  if (change.backup) lines.push(dim(`已备份到 ${change.backup}`));
  if (change.dry_run) lines.push(yellow("dry-run：未写入文件"));
  else if (!change.changed) lines.push(yellow("已经是这个镜像，未改动文件"));
  if (change.note && change.dry_run === false && change.changed) lines.push(dim(change.note));
  return lines.join("\n");
}

async function use(service: Service, args: string[]): Promise<CommandOutput> {
  if (args.length < 2) throw new UsageError("用法：mirrorhub use <工具> <镜像>");
  const change = await service.apply(args[0], args[1]);
  return { data: change, text: changeText(change, service) };
}

async function reset(service: Service, args: string[]): Promise<CommandOutput> {
  if (args.length < 1) throw new UsageError("用法：mirrorhub reset <工具>");
  const change = await service.reset(args[0]);
  const text = change.changed ? changeText(change, service) : `${bold(change.tool)} 已经是官方源，无需改动`;
  return { data: change, text };
}

async function fastest(service: Service, args: string[], flags: Parsed["flags"]): Promise<CommandOutput> {
  if (args.length < 1) throw new UsageError("用法：mirrorhub fastest <工具> [--apply]");
  const bar = progress(flags);
  let result: FastestResult;
  try {
    result = await service.fastest(args[0], {
      apply: bool(flags, "apply"),
      refresh: bool(flags, "refresh"),
      onProgress: bar.onProgress,
    });
  } finally {
    bar.clear();
  }
  const lines = [
    `${bold(result.tool)} 最快：${result.mirror.name} ${green(fmtMs(result.probe.ttfb_ms))} ${dim(`(${result.tested} 个可用)`)}`,
    dim(result.mirror.url),
  ];
  if (result.change) {
    lines.push("", changeText(result.change, service));
  } else {
    lines.push("", dim("加 --apply 直接切换到这个镜像"));
  }
  return { data: result, text: lines.join("\n") };
}

async function add(service: Service, args: string[], flags: Parsed["flags"]): Promise<CommandOutput> {
  const tool = args[0];
  if (!tool) throw new UsageError("用法：mirrorhub add <工具> --name <名称> --url <地址>");
  const name = str(flags, "name");
  const url = str(flags, "url");
  if (!name || !url) throw new UsageError("需要 --name 与 --url，例如：mirrorhub add npm --name 公司源 --url https://registry.example.com/");
  const mirror: Mirror = await service.addCustom(tool, { name, url, note: str(flags, "note"), id: str(flags, "id") });
  return {
    data: mirror,
    text: `已添加 ${bold(mirror.name)}（${mirror.id}）到 ${tool}\n${dim(`保存于 ${service.user.file}`)}`,
  };
}

async function remove(service: Service, args: string[]): Promise<CommandOutput> {
  if (args.length < 2) throw new UsageError("用法：mirrorhub rm <工具> <镜像 id>");
  await service.removeCustom(args[0], args[1]);
  return { data: { tool: args[0], id: args[1], removed: true }, text: `已删除 ${args[0]} 的镜像 ${bold(args[1])}` };
}
