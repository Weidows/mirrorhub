import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";

import type { ProbeResult } from "./model.js";

export interface Target {
  tool_id: string;
  mirror_id: string;
  name: string;
  url: string;
}

export interface CacheEntry {
  result: ProbeResult;
  at: number;
}

/** Cache keeps recent probe results so the GUI does not re-test on every render. */
export class Cache {
  private entries = new Map<string, CacheEntry>();

  get(url: string, ttlMs: number): ProbeResult | undefined {
    const hit = this.entries.get(url);
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttlMs) {
      this.entries.delete(url);
      return undefined;
    }
    return hit.result;
  }

  put(url: string, result: ProbeResult): void {
    this.entries.set(url, { result, at: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}

const userAgent = "mirrorhub/0.1";

export function proxyFor(target: URL): URL | undefined {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (matchesNoProxy(target.hostname, noProxy)) return undefined;
  const raw =
    target.protocol === "https:"
      ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      : process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function matchesNoProxy(hostname: string, list: string): boolean {
  const host = hostname.toLowerCase();
  for (const raw of list.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const bare = entry.split(":")[0].replace(/^\./, "");
    if (host === bare || host.endsWith("." + bare)) return true;
  }
  return false;
}

interface RawResponse {
  status: number;
  location?: string;
  ttfb: number;
  total: number;
}

/**
 * rawGet performs one HTTP(S) GET and stops as soon as the response headers are
 * in: the measurement is "time until the server answers", not "time to download
 * a package". Proxies are honoured (HTTP via absolute-URI, HTTPS via CONNECT),
 * because on a proxy host the official sources are unreachable otherwise and
 * would look broken.
 */
function rawGet(url: URL, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const proxy = proxyFor(url);
    const secure = url.protocol === "https:";
    const port = Number(url.port || (secure ? 443 : 80));

    let socket: net.Socket | undefined;
    let settled = false;
    let headerBuffer = Buffer.alloc(0);
    let ttfb = 0;

    const done = (err: Error | null, status = 0, location?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      const total = Math.round(performance.now() - started);
      if (err) reject(err);
      else resolve({ status, location, ttfb: Math.round(ttfb || total), total });
    };

    const timer = setTimeout(() => done(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);

    const onData = (chunk: Buffer) => {
      if (!ttfb) ttfb = performance.now() - started;
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      if (headerBuffer.length > 64 * 1024) {
        done(new Error("响应头过大"));
        return;
      }
      const end = headerBuffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = headerBuffer.subarray(0, end).toString("latin1");
      const statusLine = head.split("\r\n")[0] ?? "";
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
      if (!m) {
        done(new Error(`无法解析响应: ${statusLine.slice(0, 60)}`));
        return;
      }
      done(null, Number(m[1]), /^location:\s*(.+)$/im.exec(head)?.[1]?.trim());
    };

    const attach = (sock: net.Socket) => {
      socket = sock;
      sock.on("data", onData);
      sock.on("error", (err) => done(err));
      sock.on("close", () => done(new Error("连接被关闭")));
    };

    const requestBytes = (absolute: boolean) => {
      const path = absolute ? url.href : url.pathname + url.search;
      return (
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `User-Agent: ${userAgent}\r\n` +
        "Accept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
      );
    };

    try {
      if (proxy && !secure) {
        const sock = net.connect({ host: proxy.hostname, port: Number(proxy.port || 8080) });
        sock.once("connect", () => {
          attach(sock);
          sock.write(requestBytes(true));
        });
        sock.once("error", (err) => done(err));
        return;
      }

      if (proxy && secure) {
        const sock = net.connect({ host: proxy.hostname, port: Number(proxy.port || 8080) });
        let handshake = Buffer.alloc(0);
        const onHandshake = (chunk: Buffer) => {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf("\r\n\r\n");
          if (end < 0) return;
          sock.off("data", onHandshake);
          const head = handshake.subarray(0, end).toString("latin1");
          const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0);
          if (status !== 200) {
            done(new Error(`代理 CONNECT 失败: ${status}`));
            return;
          }
          const rest = handshake.subarray(end + 4);
          if (rest.length > 0) sock.unshift(rest);
          const tunnel = tls.connect({ socket: sock, servername: url.hostname });
          tunnel.once("secureConnect", () => {
            attach(tunnel);
            tunnel.write(requestBytes(false));
          });
          tunnel.once("error", (err) => done(err));
        };
        sock.once("connect", () => {
          sock.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n\r\n`);
          sock.on("data", onHandshake);
        });
        sock.once("error", (err) => done(err));
        return;
      }

      const sock = secure
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port });
      sock.once(secure ? "secureConnect" : "connect", () => {
        attach(sock);
        sock.write(requestBytes(false));
      });
      sock.once("error", (err) => done(err));
    } catch (err) {
      done(err as Error);
    }
  });
}

export interface Measurement {
  status: number;
  ttfb: number;
  total: number;
  ok: boolean;
  error?: string;
}

export async function measure(url: string, timeoutMs = 8000): Promise<Measurement> {
  const started = performance.now();
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { status: 0, ttfb: 0, total: 0, ok: false, error: "无效的 URL" };
  }
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await rawGet(current, timeoutMs);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
        current = new URL(res.location, current);
        continue;
      }
      return { status: res.status, ttfb: res.ttfb, total: Math.round(performance.now() - started), ok: res.status > 0 && res.status < 400 };
    }
    return { status: 0, ttfb: 0, total: Math.round(performance.now() - started), ok: false, error: "重定向次数过多" };
  } catch (err) {
    return { status: 0, ttfb: 0, total: Math.round(performance.now() - started), ok: false, error: (err as Error).message };
  }
}

/** run probes every target, deduplicating identical probe URLs. */
export async function run(targets: Target[], workers = 16, timeoutMs = 8000): Promise<ProbeResult[]> {
  const byUrl = new Map<string, Promise<Measurement>>();
  const pending: Promise<void>[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    let measurement = byUrl.get(target.url);
    if (!measurement) {
      measurement = measure(target.url, timeoutMs);
      byUrl.set(target.url, measurement);
    }
    pending.push(
      measurement.then((r) => {
        result[i] = {
          tool_id: target.tool_id,
          mirror_id: target.mirror_id,
          name: target.name,
          url: target.url,
          ok: r.ok,
          status: r.status,
          ttfb_ms: r.ttfb,
          total_ms: r.total,
          ...(r.error ? { error: r.error } : {}),
        };
      }),
    );
  }

  const result: ProbeResult[] = new Array(targets.length);
  await Promise.all(pending);
  return result;
}
