import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { AppError, type Service } from "../app.js";
import type { Ctx } from "../manager/ctx.js";
import { assets } from "./assets.gen.js";

export interface GuiOptions {
  port?: number;
  open?: boolean;
}

export interface GuiInfo {
  url: string;
  reused: boolean;
}

interface Instance {
  url: string;
  token: string;
  pid: number;
}

const staticFiles: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

/**
 * startGui serves the embedded UI on 127.0.0.1 only. Every mutating call needs
 * the per-process token, so a random page in the browser cannot switch mirrors.
 * A second launch reuses the running instance instead of stacking servers.
 */
export async function startGui(service: Service, opts: GuiOptions = {}): Promise<GuiInfo> {
  const instanceFile = join(service.ctx.platform === "win32" ? service.ctx.appData : service.ctx.xdgConfig, "mirrorhub", "gui.json");
  const existing = await readInstance(instanceFile);
  if (existing && (await isAlive(existing.url))) {
    if (opts.open) openBrowser(existing.url, service.ctx);
    return { url: existing.url, reused: true };
  }

  const token = randomBytes(16).toString("hex");

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET") {
        if (url.pathname === "/api/bootstrap") {
          send(res, 200, { ok: true, data: { token, runtime: "node", state: await buildState(service) } });
          return;
        }
        if (url.pathname === "/api/state") {
          send(res, 200, { ok: true, data: await buildState(service) });
          return;
        }
        await serveStatic(url.pathname, res);
        return;
      }

      if (req.method === "POST") {
        if (req.headers["x-mh-token"] !== token) {
          send(res, 403, { ok: false, error: { code: "forbidden", message: "token 不匹配，请从 mirrorhub gui 输出的地址打开" } });
          return;
        }
        await handlePost(service, url.pathname, await readJson(req), res, () => shutdown(server, instanceFile, 0));
        return;
      }

      send(res, 405, { ok: false, error: { code: "bad_request", message: "不支持的方法" } });
    } catch (err) {
      if (res.headersSent) return;
      const error = err instanceof AppError
        ? { ok: false as const, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } }
        : { ok: false as const, error: { code: "internal", message: (err as Error).message } };
      send(res, err instanceof AppError ? 400 : 500, error);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  const instance: Instance = { url: `http://127.0.0.1:${port}/`, token, pid: process.pid };
  await fs.mkdir(dirname(instanceFile), { recursive: true });
  await fs.writeFile(instanceFile, JSON.stringify(instance, null, 2) + "\n", "utf8");

  const cleanup = () => {
    void fs.rm(instanceFile, { force: true });
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  server.once("close", cleanup);

  if (opts.open) openBrowser(instance.url, service.ctx);
  return { url: instance.url, reused: false };
}

async function handlePost(
  service: Service,
  path: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  quit: () => void,
): Promise<void> {
  const tool = typeof body.tool === "string" ? body.tool : "";
  switch (path) {
    case "/api/apply": {
      const change = await service.apply(tool, typeof body.mirror === "string" ? body.mirror : "");
      const view = await service.view(tool);
      send(res, 200, { ok: true, data: { change, tool: view } });
      return;
    }
    case "/api/reset": {
      const change = await service.reset(tool);
      const view = await service.view(tool);
      send(res, 200, { ok: true, data: { change, tool: view } });
      return;
    }
    case "/api/test": {
      const ids = Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === "string") : [];
      const results = service.spreadResults(
        await service.test(ids.length === 1 ? ids[0] : undefined, { refresh: body.refresh === true }),
      );
      send(res, 200, { ok: true, data: { results } });
      return;
    }
    case "/api/add": {
      const mirror = await service.addCustom(tool, {
        name: typeof body.name === "string" ? body.name : "",
        url: typeof body.url === "string" ? body.url : "",
      });
      send(res, 200, { ok: true, data: { mirror } });
      return;
    }
    case "/api/remove": {
      await service.removeCustom(tool, typeof body.id === "string" ? body.id : "");
      send(res, 200, { ok: true, data: { removed: true } });
      return;
    }
    case "/api/quit": {
      send(res, 200, { ok: true, data: { quitting: true } });
      quit();
      return;
    }
    default:
      send(res, 404, { ok: false, error: { code: "not_found", message: `未知接口 ${path}` } });
  }
}

async function buildState(service: Service): Promise<unknown> {
  const data = await service.views();
  return {
    version: service.version,
    platform: `${service.ctx.platform}/${service.ctx.arch}`,
    config_file: service.user.file,
    summary: data.summary,
    tools: data.tools,
  };
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const entry = staticFiles[path];
  if (!entry) {
    send(res, 404, { ok: false, error: { code: "not_found", message: "页面不存在" } });
    return;
  }
  const body = assets[entry.file];
  if (body === undefined) {
    send(res, 500, { ok: false, error: { code: "internal", message: `缺少界面资源 ${entry.file}` } });
    return;
  }
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
  res.end(body);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new AppError("bad_request", "请求体过大");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new AppError("bad_request", "请求体不是合法 JSON");
  }
}

async function readInstance(file: string): Promise<Instance | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Instance;
    return parsed && typeof parsed.url === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** isAlive also rejects stale instances left by another implementation. */
async function isAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/bootstrap", url), { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const payload = (await res.json()) as { data?: { runtime?: string } };
    return payload?.data?.runtime === "node";
  } catch {
    return false;
  }
}

function shutdown(server: Server, instanceFile: string, code: number): void {
  void fs.rm(instanceFile, { force: true });
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

function openBrowser(url: string, ctx: Ctx): void {
  const args: [string, string[]] =
    ctx.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ctx.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(args[0], args[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // the URL is printed anyway; the user can open it manually
  }
}
