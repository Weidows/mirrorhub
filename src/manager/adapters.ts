import { promises as fs } from "node:fs";
import { join } from "node:path";

import { official } from "../catalog.js";
import type { Mirror, Status } from "../model.js";
import { Doc } from "./doc.js";
import { exists, firstExistingAsync, firstVersion, majorVersion, normalizeUrl, readOrEmpty, save, type Ctx } from "./ctx.js";

export interface Adapter {
  id: string;
  configFiles(ctx: Ctx): Promise<string[]>;
  read(ctx: Ctx): Promise<Status>;
  apply(ctx: Ctx, mirror: Mirror): Promise<Status>;
  reset(ctx: Ctx): Promise<Status>;
}

function status(source: string, raw: string, file: string, origin: Status["origin"], note?: string): Status {
  const out: Status = { source, raw, file, origin };
  if (note) out.note = note;
  return out;
}

function officialStatus(file: string, tool: string, note?: string): Status {
  return status(official(tool).url, "", file, "default", note);
}

function joinNote(a?: string, b?: string): string | undefined {
  return [a, b].filter(Boolean).join("；") || undefined;
}

function applyResult(ctx: Ctx, saved: { backup?: string }, after: Status, saved2?: { written: boolean }): Status {
  const out = { ...after };
  if (saved.backup) out.backup = saved.backup;
  if (ctx.dryRun) out.note = joinNote(out.note, "dry-run：未写入文件");
  return out;
}

// ---------------------------------------------------------------- npm family

interface NpmOpts {
  id: string;
  note?: string;
  envKeys: string[];
}

function npmFamily(opts: NpmOpts): Adapter {
  const file = (ctx: Ctx) => join(ctx.home, ".npmrc");
  const readRegistry = async (ctx: Ctx, path: string): Promise<string | undefined> => {
    const { content } = await readOrEmpty(path);
    return Doc.parse(content).get("", "registry");
  };
  return {
    id: opts.id,
    configFiles: async (ctx) => [file(ctx)],
    async read(ctx) {
      const path = file(ctx);
      for (const key of opts.envKeys) {
        const value = ctx.env(key);
        if (value) return status(value, `${key}=${value}`, path, "env", joinNote(opts.note, "环境变量优先于配置文件"));
      }
      const value = await readRegistry(ctx, path);
      if (value) return status(value, `registry=${value}`, path, "file", opts.note);
      return officialStatus(path, opts.id, opts.note);
    },
    async apply(ctx, mirror) {
      const path = file(ctx);
      const { content } = await readOrEmpty(path);
      const doc = Doc.parse(content);
      doc.set("", "registry", mirror.url, { sep: "=" });
      const saved = await save(ctx, path, doc.toString());
      return applyResult(ctx, saved, await this.read(ctx));
    },
    async reset(ctx) {
      const path = file(ctx);
      const { content } = await readOrEmpty(path);
      const doc = Doc.parse(content);
      if (doc.delete("", "registry")) await save(ctx, path, doc.toString());
      const after = await this.read(ctx);
      return { ...after, note: joinNote(after.note, opts.note) };
    },
  };
}

const npmAdapter = npmFamily({ id: "npm", envKeys: ["NPM_CONFIG_REGISTRY", "npm_config_registry"] });
const pnpmAdapter = npmFamily({ id: "pnpm", note: "pnpm 与 npm 共用 ~/.npmrc", envKeys: ["NPM_CONFIG_REGISTRY", "npm_config_registry"] });
const bunAdapter: Adapter = {
  id: "bun",
  configFiles: async (ctx) => [join(ctx.home, ".bunfig.toml")],
  async read(ctx) {
    const path = join(ctx.home, ".bunfig.toml");
    const env = ctx.env("BUN_CONFIG_REGISTRY");
    if (env) return status(env, `BUN_CONFIG_REGISTRY=${env}`, path, "env");
    const { content } = await readOrEmpty(path);
    const value = Doc.parse(content).get("install", "registry");
    if (value) return status(value, `registry = ${value}`, path, "file");
    return officialStatus(path, "bun");
  },
  async apply(ctx, mirror) {
    const path = join(ctx.home, ".bunfig.toml");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.set("install", "registry", mirror.url, { quote: '"' });
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = join(ctx.home, ".bunfig.toml");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    if (doc.delete("install", "registry")) await save(ctx, path, doc.toString());
    return this.read(ctx);
  },
};

/** yarn switched its config format in v2 (berry); detect which one is active. */
async function yarnIsBerry(ctx: Ctx): Promise<boolean> {
  if (await exists(join(ctx.home, ".yarnrc.yml"))) return true;
  const bin = await ctx.lookPath("yarn");
  if (!bin) return false;
  const r = await ctx.run(bin, ["--version"]);
  const v = firstVersion(r.stdout + r.stderr);
  return r.code === 0 && v !== undefined && majorVersion(v) >= 2;
}

const yarnAdapter: Adapter = {
  id: "yarn",
  async configFiles(ctx) {
    return [join(ctx.home, ".yarnrc.yml"), join(ctx.home, ".yarnrc"), join(ctx.home, ".npmrc")];
  },
  async read(ctx) {
    const berry = await yarnIsBerry(ctx);
    const yml = join(ctx.home, ".yarnrc.yml");
    if (berry) {
      const { content } = await readOrEmpty(yml);
      const value = Doc.parse(content).get("", "npmRegistryServer");
      if (value) return status(value, `npmRegistryServer: ${value}`, yml, "file");
      return officialStatus(yml, "yarn", "yarn berry 使用 .yarnrc.yml");
    }
    const rc = join(ctx.home, ".yarnrc");
    const { content } = await readOrEmpty(rc);
    const value = Doc.parse(content).get("", "registry");
    if (value) return status(value, `registry "${value}"`, rc, "file");
    const npmrc = await readOrEmpty(join(ctx.home, ".npmrc"));
    const fallback = Doc.parse(npmrc.content).get("", "registry");
    if (fallback) return status(fallback, `registry=${fallback}`, join(ctx.home, ".npmrc"), "file", "回退到 npm 配置");
    return officialStatus(yml, "yarn", "yarn berry 使用 .yarnrc.yml");
  },
  async apply(ctx, mirror) {
    const berry = await yarnIsBerry(ctx);
    if (berry) {
      const path = join(ctx.home, ".yarnrc.yml");
      const { content } = await readOrEmpty(path);
      const doc = Doc.parse(content);
      doc.set("", "npmRegistryServer", mirror.url, { sep: ": ", quote: '"' });
      const saved = await save(ctx, path, doc.toString());
      return applyResult(ctx, saved, await this.read(ctx));
    }
    const path = join(ctx.home, ".yarnrc");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.set("", "registry", mirror.url, { sep: " ", quote: '"' });
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    for (const path of [join(ctx.home, ".yarnrc.yml"), join(ctx.home, ".yarnrc")]) {
      const { content } = await readOrEmpty(path);
      const doc = Doc.parse(content);
      if (doc.delete("", "npmRegistryServer") || doc.delete("", "registry")) await save(ctx, path, doc.toString());
    }
    return this.read(ctx);
  },
};

// -------------------------------------------------------------------- python

const pipAdapter: Adapter = {
  id: "pip",
  async configFiles(ctx) {
    const candidates: string[] = [];
    const envFile = ctx.env("PIP_CONFIG_FILE");
    if (envFile) candidates.push(envFile);
    if (ctx.platform === "win32") {
      candidates.push(join(ctx.appData, "pip", "pip.ini"), join(ctx.appData, "pip", "pip.conf"));
      candidates.push(join(ctx.home, ".pip", "pip.ini"), join(ctx.home, ".pip", "pip.conf"));
      candidates.push(join(ctx.xdgConfig, "pip", "pip.conf"));
    } else {
      candidates.push(join(ctx.xdgConfig, "pip", "pip.conf"), join(ctx.home, ".pip", "pip.conf"), join(ctx.home, ".pip", "pip.ini"));
    }
    return candidates;
  },
  async read(ctx) {
    const files = await this.configFiles(ctx);
    const env = ctx.env("PIP_INDEX_URL");
    if (env) return status(env, `PIP_INDEX_URL=${env}`, files[0], "env");
    for (const path of files) {
      const { content, exists: has } = await readOrEmpty(path);
      if (!has) continue;
      const doc = Doc.parse(content);
      const value = doc.get("global", "index-url");
      if (value) return status(value, `index-url = ${value}`, path, "file");
    }
    return officialStatus(files[0], "pip");
  },
  async apply(ctx, mirror) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.set("global", "index-url", mirror.url);
    if (mirror.trusted_host) doc.set("global", "trusted-host", mirror.trusted_host);
    else doc.delete("global", "trusted-host");
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    let changed = false;
    for (const key of ["index-url", "trusted-host", "extra-index-url"]) {
      if (doc.delete("global", key)) changed = true;
    }
    if (changed) await save(ctx, path, doc.toString());
    return this.read(ctx);
  },
};

const uvAdapter: Adapter = {
  id: "uv",
  async configFiles(ctx) {
    if (ctx.platform === "win32") return [join(ctx.appData, "uv", "uv.toml"), join(ctx.xdgConfig, "uv", "uv.toml")];
    return [join(ctx.xdgConfig, "uv", "uv.toml")];
  },
  async read(ctx) {
    const files = await this.configFiles(ctx);
    const env = ctx.env("UV_INDEX_URL") ?? ctx.env("UV_DEFAULT_INDEX");
    if (env) return status(env, `UV_INDEX_URL=${env}`, files[0], "env");
    for (const path of files) {
      const { content, exists: has } = await readOrEmpty(path);
      if (!has) continue;
      const doc = Doc.parse(content);
      const value = doc.get("", "index-url") ?? doc.get("", "default-index");
      if (value) return status(value, `index-url = ${value}`, path, "file");
    }
    return officialStatus(files[0], "uv");
  },
  async apply(ctx, mirror) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.set("", "index-url", mirror.url);
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.delete("", "index-url");
    doc.delete("", "default-index");
    await save(ctx, path, doc.toString());
    return this.read(ctx);
  },
};

// ------------------------------------------------------------------------ go

async function goEnvFile(ctx: Ctx): Promise<string> {
  const bin = await ctx.lookPath("go");
  if (bin) {
    const r = await ctx.run(bin, ["env", "GOENV"]);
    const value = r.stdout.trim();
    if (r.code === 0 && value && value !== "off") return value;
  }
  return ctx.platform === "win32" ? join(ctx.appData, "go", "env") : join(ctx.xdgConfig, "go", "env");
}

const goAdapter: Adapter = {
  id: "go",
  async configFiles(ctx) {
    return [await goEnvFile(ctx)];
  },
  async read(ctx) {
    const path = await goEnvFile(ctx);
    const env = ctx.env("GOPROXY");
    if (env) return status(env, `GOPROXY=${env}`, path, "env");
    const { content } = await readOrEmpty(path);
    const value = Doc.parse(content).get("", "GOPROXY");
    if (value) return status(value, `GOPROXY=${value}`, path, "file");
    return officialStatus(path, "go");
  },
  async apply(ctx, mirror) {
    const path = await goEnvFile(ctx);
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.set("", "GOPROXY", mirror.url, { sep: "=" });
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = await goEnvFile(ctx);
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    if (doc.delete("", "GOPROXY")) await save(ctx, path, doc.toString());
    return this.read(ctx);
  },
};

// --------------------------------------------------------------------- cargo

const cargoManaged = "mirrorhub";

function cargoFile(ctx: Ctx): string {
  const home = ctx.env("CARGO_HOME") ?? join(ctx.home, ".cargo");
  return join(home, "config.toml");
}

function cargoUrl(doc: Doc): string | undefined {
  const replace = doc.get("source.crates-io", "replace-with");
  if (replace) {
    return doc.get(`source.${replace}`, "registry") ?? doc.get(`source.${replace}`, "local-registry") ?? doc.get(`registries.${replace}`, "index");
  }
  return doc.get("registries.crates-io", "index");
}

const cargoAdapter: Adapter = {
  id: "cargo",
  async configFiles(ctx) {
    const home = ctx.env("CARGO_HOME") ?? join(ctx.home, ".cargo");
    return [join(home, "config.toml"), join(home, "config")];
  },
  async read(ctx) {
    for (const path of await this.configFiles(ctx)) {
      const { content, exists: has } = await readOrEmpty(path);
      if (!has) continue;
      const doc = Doc.parse(content);
      const url = cargoUrl(doc);
      if (url) return status(url, `replace-with = "${doc.get("source.crates-io", "replace-with") ?? ""}"`, path, "file");
      return officialStatus(path, "cargo");
    }
    return officialStatus(cargoFile(ctx), "cargo");
  },
  async apply(ctx, mirror) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.deleteSection(`source.${cargoManaged}`);
    doc.deleteSection("source.crates-io");
    doc.set("source.crates-io", "replace-with", cargoManaged, { sep: " = ", quote: '"' });
    doc.set(`source.${cargoManaged}`, "registry", mirror.url, { sep: " = ", quote: '"' });
    const saved = await save(ctx, path, doc.toString());
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = await firstExistingAsync(await this.configFiles(ctx), "");
    const { content } = await readOrEmpty(path);
    const doc = Doc.parse(content);
    doc.deleteSection("source.crates-io");
    doc.deleteSection(`source.${cargoManaged}`);
    await save(ctx, path, doc.toString());
    return this.read(ctx);
  },
};

// ------------------------------------------------------------------ composer

const composerMirrorKey = "mirrorhub";

async function composerFile(ctx: Ctx): Promise<string> {
  const files = await composerAdapter.configFiles(ctx);
  return firstExistingAsync(files, files[files.length - 1]);
}

function parseComposer(content: string): Record<string, unknown> {
  if (content.trim() === "") return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("Composer 配置不是合法 JSON");
  }
}

const composerAdapter: Adapter = {
  id: "composer",
  async configFiles(ctx) {
    const out: string[] = [];
    const home = ctx.env("COMPOSER_HOME");
    if (home) out.push(join(home, "config.json"));
    out.push(join(ctx.appData, "Composer", "config.json"), join(ctx.xdgConfig, "composer", "config.json"), join(ctx.home, ".composer", "config.json"));
    return out;
  },
  async read(ctx) {
    const path = await composerFile(ctx);
    const { content, exists: has } = await readOrEmpty(path);
    if (!has) return officialStatus(path, "composer");
    const cfg = parseComposer(content);
    const repos = (cfg.repositories ?? {}) as Record<string, unknown>;
    const mirror = repos[composerMirrorKey] as { url?: string } | undefined;
    if (mirror?.url) return status(mirror.url, `repositories.${composerMirrorKey}.url`, path, "file");
    return officialStatus(path, "composer");
  },
  async apply(ctx, mirror) {
    const path = await composerFile(ctx);
    const { content } = await readOrEmpty(path);
    const cfg = parseComposer(content);
    const repos = { ...((cfg.repositories as Record<string, unknown>) ?? {}) };
    repos["packagist.org"] = false;
    repos[composerMirrorKey] = { type: "composer", url: mirror.url };
    cfg.repositories = repos;
    const saved = await save(ctx, path, JSON.stringify(cfg, null, 4) + "\n");
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = await composerFile(ctx);
    const { content } = await readOrEmpty(path);
    const cfg = parseComposer(content);
    const repos = { ...((cfg.repositories as Record<string, unknown>) ?? {}) };
    delete repos[composerMirrorKey];
    delete repos["packagist.org"];
    if (Object.keys(repos).length === 0) delete cfg.repositories;
    else cfg.repositories = repos;
    await save(ctx, path, JSON.stringify(cfg, null, 4) + "\n");
    return this.read(ctx);
  },
};

// ----------------------------------------------------------------------- gem

function gemSources(content: string): { header: number; items: number[] } | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*:sources:\s*$/.test(lines[i])) continue;
    const items: number[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s+/.test(lines[j])) items.push(j);
      else if (lines[j].trim() === "") continue;
      else break;
    }
    return { header: i, items };
  }
  return undefined;
}

function gemInline(content: string): string | undefined {
  const m = /^\s*:sources:\s*\[(.*)\]\s*$/.exec(content.split(/\r?\n/).find((l) => l.trim().startsWith(":sources:")) ?? "");
  return m ? m[1] : undefined;
}

const gemAdapter: Adapter = {
  id: "gem",
  configFiles: async (ctx) => [join(ctx.home, ".gemrc")],
  async read(ctx) {
    const path = join(ctx.home, ".gemrc");
    const { content, exists: has } = await readOrEmpty(path);
    if (!has) return officialStatus(path, "gem");
    const inline = gemInline(content);
    if (inline) {
      const first = inline.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      if (first) return status(first, `:sources: [${inline}]`, path, "file");
    }
    const lines = content.split(/\r?\n/);
    const block = gemSources(content);
    if (block && block.items.length > 0) {
      const raw = lines[block.items[0]].replace(/^\s*-\s+/, "").trim();
      const value = raw.replace(/^["']|["']$/g, "");
      return status(value, `:sources: [${value}]`, path, "file");
    }
    return officialStatus(path, "gem");
  },
  async apply(ctx, mirror) {
    const path = join(ctx.home, ".gemrc");
    const { content } = await readOrEmpty(path);
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
    const inlineIdx = lines.findIndex((l) => /^\s*:sources:\s*\[.*\]\s*$/.test(l));
    if (inlineIdx >= 0) {
      lines[inlineIdx] = `:sources: ["${mirror.url}"]`;
    } else {
      const block = gemSources(content);
      if (block && block.items.length > 0) {
        for (let k = block.items.length - 1; k >= 1; k--) lines.splice(block.items[k], 1);
        lines[block.items[0]] = `- "${mirror.url}"`;
      } else {
        lines.push(":sources:", `- "${mirror.url}"`);
      }
    }
    const saved = await save(ctx, path, lines.length ? lines.join(eol) + eol : "");
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = join(ctx.home, ".gemrc");
    const { content } = await readOrEmpty(path);
    const lines = content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
    const block = gemSources(content);
    if (block) {
      for (let k = block.items.length - 1; k >= 0; k--) lines.splice(block.items[k], 1);
      lines.splice(block.header, 1);
    }
    // The inline form and any leftovers are ours to remove too: reset means
    // "stop forcing a mirror", not "restore someone else's source list".
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith(":sources:")) lines.splice(i, 1);
    }
    await save(ctx, path, lines.length ? lines.join("\n") + "\n" : "");
    return this.read(ctx);
  },
};

// --------------------------------------------------------------------- nuget

const nugetMirrorKey = "mirrorhub";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nugetAddLine(key: string, value: string): string {
  return `    <add key="${escapeXml(key)}" value="${escapeXml(value)}" protocolVersion="3" />`;
}

function nugetBlock(url: string): string {
  return `  <packageSources>\n    <clear />\n${nugetAddLine(nugetMirrorKey, url)}\n  </packageSources>`;
}

function nugetFile(ctx: Ctx): string {
  return ctx.platform === "win32" ? join(ctx.appData, "NuGet", "NuGet.Config") : join(ctx.xdgConfig, "NuGet", "NuGet.Config");
}

const nugetAdapter: Adapter = {
  id: "nuget",
  configFiles: async (ctx) => [nugetFile(ctx)],
  async read(ctx) {
    const path = nugetFile(ctx);
    const { content, exists: has } = await readOrEmpty(path);
    if (!has) return officialStatus(path, "nuget");
    const block = /<packageSources>([\s\S]*?)<\/packageSources>/i.exec(content);
    if (block) {
      const add = /<add\s+[^>]*key="([^"]+)"[^>]*value="([^"]+)"/gi;
      let first: string | undefined;
      let managed: string | undefined;
      let m: RegExpExecArray | null;
      while ((m = add.exec(block[1])) !== null) {
        if (!first) first = m[2];
        if (m[1].toLowerCase() === nugetMirrorKey) managed = m[2];
      }
      const value = managed ?? first;
      if (value) return status(value, `<add key="${managed ? nugetMirrorKey : "…"}" value="${value}" />`, path, "file");
    }
    return officialStatus(path, "nuget");
  },
  async apply(ctx, mirror) {
    const path = nugetFile(ctx);
    const { content } = await readOrEmpty(path);
    let next: string;
    if (/<packageSources>[\s\S]*?<\/packageSources>/i.test(content)) {
      next = content.replace(/<packageSources>[\s\S]*?<\/packageSources>/i, nugetBlock(mirror.url));
    } else if (/<\/configuration>/i.test(content)) {
      next = content.replace(/<\/configuration>/i, `${nugetBlock(mirror.url)}\n</configuration>`);
    } else {
      next = `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n${nugetBlock(mirror.url)}\n</configuration>\n`;
    }
    const saved = await save(ctx, path, next);
    return applyResult(ctx, saved, await this.read(ctx));
  },
  async reset(ctx) {
    const path = nugetFile(ctx);
    const { content } = await readOrEmpty(path);
    if (!/key="mirrorhub"/i.test(content)) return this.read(ctx);
    const next = content.replace(/<packageSources>[\s\S]*?<\/packageSources>/i, nugetBlock("https://api.nuget.org/v3/index.json").replace(nugetMirrorKey, "nuget.org"));
    await save(ctx, path, next);
    return this.read(ctx);
  },
};

// -------------------------------------------------------------------- lookup

const adapters: Record<string, Adapter> = {
  npm: npmAdapter,
  pnpm: pnpmAdapter,
  yarn: yarnAdapter,
  bun: bunAdapter,
  pip: pipAdapter,
  uv: uvAdapter,
  go: goAdapter,
  cargo: cargoAdapter,
  composer: composerAdapter,
  gem: gemAdapter,
  nuget: nugetAdapter,
};

export function forTool(id: string): Adapter | undefined {
  return adapters[id];
}

export { normalizeUrl };
