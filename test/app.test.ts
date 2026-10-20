import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helper.ts";
import { Service, AppError } from "../dist/app.js";
import { normalizeUrl } from "../dist/manager/ctx.js";
import { official } from "../dist/catalog.js";

test("apply switches the mirror and reset goes back to the official source", async () => {
  const fake = await fakeCtx();
  try {
    const service = await Service.create({ ctx: fake.ctx });
    const change = await service.apply("npm", "npmmirror");
    assert.equal(change.tool, "npm");
    assert.equal(change.mirror.id, "npmmirror");
    assert.equal(change.changed, true);
    assert.equal(change.dry_run, false);
    assert.equal(normalizeUrl(change.after.source), normalizeUrl("https://registry.npmmirror.com/"));

    const view = await service.view("npm");
    assert.equal(view.mirror_id, "npmmirror");
    assert.equal(view.installed, true);
    assert.equal(view.config_exists, true);

    const second = await service.apply("npm", "huawei");
    assert.ok(second.backup, "rewriting an existing config keeps a .mirrorhub.bak copy");
    assert.equal((await service.view("npm")).mirror_id, "huawei");

    const back = await service.reset("npm");
    assert.equal(normalizeUrl(back.after.source), normalizeUrl(official("npm").url));
  } finally {
    await fake.cleanup();
  }
});

test("views summarises tools and can filter to installed ones", async () => {
  const fake = await fakeCtx();
  try {
    const service = await Service.create({ ctx: fake.ctx });
    const all = await service.views();
    assert.equal(all.tools.length, 11);
    assert.equal(all.summary.tools, 11);
    assert.equal(all.summary.installed, 0);
    assert.equal(all.summary.configured, 0);

    await service.apply("npm", "npmmirror");
    const installed = await service.views({ installedOnly: true });
    // pnpm and yarn share ~/.npmrc, so they count as configured too.
    assert.deepEqual(installed.tools.map((t) => t.id).sort(), ["npm", "pnpm", "yarn"]);
    assert.equal(installed.summary.installed, 3);
    assert.equal((await service.views()).summary.configured, 3);
  } finally {
    await fake.cleanup();
  }
});

test("a measured source lights up every tool that shares it", async () => {
  const fake = await fakeCtx();
  try {
    const service = await Service.create({ ctx: fake.ctx });
    const measured = [
      {
        tool_id: "npm",
        mirror_id: "npmmirror",
        name: "npmmirror",
        url: "https://registry.npmmirror.com/-/ping",
        ok: true,
        status: 200,
        ttfb_ms: 12,
        total_ms: 30,
      },
    ];
    const spread = service.spreadResults(measured);
    assert.deepEqual(
      spread.map((r) => `${r.tool_id}/${r.mirror_id}`).sort(),
      ["bun/npmmirror", "npm/npmmirror", "pnpm/npmmirror", "yarn/npmmirror"],
    );
    assert.equal(service.spreadResults(spread).length, spread.length, "spreading twice changes nothing");
  } finally {
    await fake.cleanup();
  }
});

test("unknown tool and mirror names fail with stable error codes", async () => {
  const fake = await fakeCtx();
  try {
    const service = await Service.create({ ctx: fake.ctx });
    await assert.rejects(service.view("brew"), (err: unknown) => err instanceof AppError && err.code === "unknown_tool");
    await assert.rejects(service.apply("npm", "does-not-exist"), (err: unknown) => err instanceof AppError && err.code === "unknown_mirror");
    await assert.rejects(service.apply("npm", ""), (err: unknown) => err instanceof AppError);
  } finally {
    await fake.cleanup();
  }
});

test("custom mirrors can be added, used and removed", async () => {
  const fake = await fakeCtx();
  try {
    const service = await Service.create({ ctx: fake.ctx });
    const mirror = await service.addCustom("npm", { name: "公司源", url: "https://registry.example.com/" });
    assert.equal(mirror.id, "custom");
    assert.equal(mirror.custom, true);
    assert.equal(service.mirrorsFor("npm").length, 6);

    const change = await service.apply("npm", mirror.id);
    assert.equal(normalizeUrl(change.after.source), "https://registry.example.com");

    const saved = JSON.parse(await readFile(join(fake.ctx.appData, "mirrorhub", "config.json"), "utf8"));
    assert.equal(saved.mirrors.npm[0].url, "https://registry.example.com/");

    await assert.rejects(service.addCustom("npm", { name: "重复", url: "https://registry.example.com/" }), (err: unknown) => err instanceof AppError && err.code === "bad_request");
    await assert.rejects(service.addCustom("npm", { name: "坏地址", url: "ftp://x" }), (err: unknown) => err instanceof AppError && err.code === "bad_request");

    await service.removeCustom("npm", mirror.id);
    assert.equal(service.mirrorsFor("npm").length, 5);
    await assert.rejects(service.removeCustom("npm", mirror.id), (err: unknown) => err instanceof AppError && err.code === "not_found");
  } finally {
    await fake.cleanup();
  }
});

test("dry-run reports the target mirror without writing files", async () => {
  const fake = await fakeCtx();
  try {
    fake.ctx.dryRun = true;
    const service = await Service.create({ ctx: fake.ctx });
    const change = await service.apply("npm", "npmmirror");
    assert.equal(change.dry_run, true);
    assert.equal(change.changed, true);
    assert.equal(normalizeUrl(change.after.source), normalizeUrl("https://registry.npmmirror.com/"));
    assert.match(change.after.note ?? "", /dry-run/);
    await assert.rejects(readFile(join(fake.root, ".npmrc"), "utf8"), /ENOENT/);
  } finally {
    await fake.cleanup();
  }
});
