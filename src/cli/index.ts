import { AppError, Service } from "../app.js";
import { newCtx } from "../manager/ctx.js";
import { allow, bool, parseArgs, str, UsageError, type Parsed } from "./args.js";
import { runCommand } from "./commands.js";
import { helpText, versionText } from "./help.js";
import { cyan, dim, red, setColor, yellow } from "./term.js";

const globalFlags = ["json", "dry-run", "no-color", "verbose", "help", "version", "quiet"];

const commandFlags: Record<string, string[]> = {
  ls: ["installed", "verbose"],
  mirrors: [],
  test: ["refresh"],
  use: [],
  reset: [],
  fastest: ["apply", "refresh"],
  add: ["name", "url", "note", "id"],
  rm: [],
  remove: [],
  gui: ["port", "no-open"],
  version: [],
  help: [],
};

interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return fail(err, argv.includes("--json") || argv.includes("-j"));
  }

  const flags = parsed.flags;
  const json = bool(flags, "json");
  if (json || bool(flags, "no-color")) setColor(false);

  const command = parsed.positionals[0];
  const rest = parsed.positionals.slice(1);

  if (bool(flags, "version") && !command) {
    console.log(versionText());
    return 0;
  }

  // Double-clicking the single-file binary passes no arguments: go straight to
  // the GUI. Flags alone (mirrorhub -h, mirrorhub -j) still print help.
  if (!command && argv.length === 0) {
    try {
      const service = await Service.create({ ctx: newCtx() });
      const { startGui } = await import("../gui/server.js");
      const info = await startGui(service, { open: true });
      console.log(`${cyan("MirrorHub")} ${info.url}`);
      console.log(dim("命令行用法：mirrorhub help；关闭本窗口即退出"));
      return 0;
    } catch (err) {
      return fail(err, false);
    }
  }

  if (!command || command === "help" || bool(flags, "help")) {
    const text = helpText(command === "help" ? rest[0] : command);
    if (json) console.log(JSON.stringify({ ok: true, data: { help: text } }, null, 2));
    else console.log(text);
    return 0;
  }

  try {
    const allowed = commandFlags[command];
    if (!allowed) throw new UsageError(`未知命令：${command}`);
    allow(flags, [...globalFlags, ...allowed]);
  } catch (err) {
    return fail(err, json);
  }

  const ctx = newCtx();
  ctx.dryRun = bool(flags, "dry-run");

  try {
    const service = await Service.create({ ctx });

    if (command === "gui") {
      const { startGui } = await import("../gui/server.js");
      const port = str(flags, "port") ? Number(str(flags, "port")) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UsageError("--port 需要 1-65535 之间的整数");
      const info = await startGui(service, { port, open: !bool(flags, "no-open") });
      if (json) console.log(JSON.stringify({ ok: true, data: { url: info.url, pid: process.pid } }, null, 2));
      else {
        console.log(`${cyan("MirrorHub")} ${info.url}`);
        console.log(dim("只监听本机 127.0.0.1；按 Ctrl+C 退出"));
      }
      return 0;
    }

    const out = await runCommand(command, rest, flags, service);
    if (json) console.log(JSON.stringify({ ok: true, data: out.data }, null, 2));
    else console.log(out.text);
    return 0;
  } catch (err) {
    return fail(err, json);
  }
}

function fail(err: unknown, json: boolean): number {
  let body: ErrorBody;
  let exit = 1;
  if (err instanceof UsageError) {
    body = { code: "bad_request", message: err.message, hint: "mirrorhub help 查看用法" };
    exit = 2;
  } else if (err instanceof AppError) {
    body = { code: err.code, message: err.message };
    if (err.hint) body.hint = err.hint;
    if (["bad_request", "unknown_tool", "unknown_mirror", "not_found"].includes(err.code)) exit = 2;
  } else if (err instanceof Error) {
    body = { code: "internal", message: err.message };
  } else {
    body = { code: "internal", message: String(err) };
  }

  if (json) {
    console.log(JSON.stringify({ ok: false, error: body }, null, 2));
  } else {
    console.error(`${red("错误：")}${body.message}`);
    if (body.hint) console.error(dim(body.hint));
    if (body.code === "internal") console.error(yellow("如果是 bug，请附上上面的报错到 GitHub issue"));
  }
  return exit;
}
