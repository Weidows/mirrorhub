import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeCtx } from "./helper.ts";
import { forTool } from "../dist/manager/adapters.js";
import { normalizeUrl } from "../dist/manager/ctx.js";
import { mirrors, official, tools } from "../dist/catalog.js";

/** Per-tool fake host behaviour: go asks the binary where GOENV lives, yarn reports classic. */
function hostOptions(tool: string) {
  return (root: string) => {
    if (tool === "go") {
      const goenv = join(root, "go", "env");
      return {
        lookPath: { go: join(root, "fake-go") },
        run: (cmd: string, args: string[]) =>
          args[0] === "env" ? { stdout: goenv + "\n", stderr: "", code: 0 } : undefined,
      };
    }
    if (tool === "yarn") {
      return {
        lookPath: { yarn: join(root, "fake-yarn") },
        run: () => ({ stdout: "1.22.22\n", stderr: "", code: 0 }),
      };
    }
    return {};
  };
}

function targetMirror(tool: string) {
  const picked = mirrors(tool).find((m) => m.id !== "official" && !m.official);
  assert.ok(picked, `no non-official mirror for ${tool}`);
  return picked;
}

for (const tool of tools()) {
  test(`${tool}: apply writes the mirror, reset restores the official source`, async () => {
    const fake = await fakeCtx(hostOptions(tool));
    try {
      const adapter = forTool(tool);
      assert.ok(adapter, `adapter for ${tool}`);
      const mirror = targetMirror(tool);

      const applied = await adapter.apply(fake.ctx, mirror);
      assert.ok(applied.file, "apply reports a config file");
      assert.equal(normalizeUrl(applied.source), normalizeUrl(mirror.url));
      const after = await adapter.read(fake.ctx);
      assert.equal(normalizeUrl(after.source), normalizeUrl(mirror.url));

      const reset = await adapter.reset(fake.ctx);
      assert.equal(normalizeUrl(reset.source), normalizeUrl(official(tool).url));
    } finally {
      await fake.cleanup();
    }
  });
}

test("npm keeps unrelated .npmrc keys and only rewrites registry", async () => {
  const fake = await fakeCtx();
  try {
    const npmrc = join(fake.root, ".npmrc");
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=secret-token\nregistry=https://registry.npmjs.org/\nfund=false\n", "utf8");
    const adapter = forTool("npm")!;
    const mirror = targetMirror("npm");
    await adapter.apply(fake.ctx, mirror);
    const text = await readFile(npmrc, "utf8");
    assert.match(text, /_authToken=secret-token/);
    assert.match(text, /fund=false/);
    assert.equal(text.match(/^registry=.*$/gm)?.length, 1);
    assert.ok(text.includes("registry=" + mirror.url));
    await adapter.reset(fake.ctx);
    const back = await readFile(npmrc, "utf8");
    assert.match(back, /_authToken=secret-token/);
    assert.doesNotMatch(back, /^registry=/m);
  } finally {
    await fake.cleanup();
  }
});

test("pip writes trusted-host when the mirror needs it and removes it on reset", async () => {
  const fake = await fakeCtx();
  try {
    const adapter = forTool("pip")!;
    const mirror = mirrors("pip").find((m) => m.trusted_host);
    assert.ok(mirror?.trusted_host);
    await adapter.apply(fake.ctx, mirror);
    const file = join(fake.ctx.appData, "pip", "pip.ini");
    assert.match(await readFile(file, "utf8"), /trusted-host ?= ?/);
    await adapter.reset(fake.ctx);
    assert.doesNotMatch(await readFile(file, "utf8"), /trusted-host/);
  } finally {
    await fake.cleanup();
  }
});

test("cargo keeps unmanaged sections and removes its own on reset", async () => {
  const fake = await fakeCtx();
  try {
    const file = join(fake.root, ".cargo", "config.toml");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "[net]\ngit-fetch-with-cli = true\n", "utf8");
    const adapter = forTool("cargo")!;
    await adapter.apply(fake.ctx, targetMirror("cargo"));
    const text = await readFile(file, "utf8");
    assert.match(text, /\[net\]/);
    assert.match(text, /git-fetch-with-cli = true/);
    assert.match(text, /\[source\.mirrorhub\]/);
    assert.match(text, /replace-with = "mirrorhub"/);
    await adapter.reset(fake.ctx);
    const back = await readFile(file, "utf8");
    assert.match(back, /git-fetch-with-cli = true/);
    assert.doesNotMatch(back, /mirrorhub/);
  } finally {
    await fake.cleanup();
  }
});

test("composer writes a packagist replacement and cleans it on reset", async () => {
  const fake = await fakeCtx();
  try {
    const file = join(fake.ctx.appData, "Composer", "config.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ config: { "sort-packages": true } }, null, 4), "utf8");
    const adapter = forTool("composer")!;
    const mirror = targetMirror("composer");
    await adapter.apply(fake.ctx, mirror);
    const cfg = JSON.parse(await readFile(file, "utf8"));
    assert.equal(cfg.config["sort-packages"], true);
    assert.equal(cfg.repositories["packagist.org"], false);
    assert.equal(cfg.repositories.mirrorhub.url, mirror.url);
    await adapter.reset(fake.ctx);
    const back = JSON.parse(await readFile(file, "utf8"));
    assert.equal(back.config["sort-packages"], true);
    assert.equal(back.repositories, undefined);
  } finally {
    await fake.cleanup();
  }
});

test("gem keeps a single source after switching", async () => {
  const fake = await fakeCtx();
  try {
    const file = join(fake.root, ".gemrc");
    await writeFile(file, ':sources: ["https://rubygems.org"]\n:sources:\n- https://rubygems.org\n', "utf8");
    const adapter = forTool("gem")!;
    const mirror = targetMirror("gem");
    await adapter.apply(fake.ctx, mirror);
    const text = await readFile(file, "utf8");
    assert.ok(text.includes(':sources: ["' + mirror.url + '"]'));
    await adapter.reset(fake.ctx);
    const back = await readFile(file, "utf8");
    assert.doesNotMatch(back, new RegExp(mirror.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await adapter.read(fake.ctx)).origin, "default");
  } finally {
    await fake.cleanup();
  }
});

test("nuget replaces packageSources and restores nuget.org on reset", async () => {
  const fake = await fakeCtx();
  try {
    const file = join(fake.ctx.appData, "NuGet", "NuGet.Config");
    await mkdir(dirname(file), { recursive: true });
    const seed = '<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <packageSources>\n    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />\n  </packageSources>\n</configuration>\n';
    await writeFile(file, seed, "utf8");
    const adapter = forTool("nuget")!;
    await adapter.apply(fake.ctx, targetMirror("nuget"));
    const text = await readFile(file, "utf8");
    assert.match(text, /<clear \/>/);
    assert.match(text, /key="mirrorhub"/);
    await adapter.reset(fake.ctx);
    const back = await readFile(file, "utf8");
    assert.match(back, /key="nuget.org"/);
    assert.doesNotMatch(back, /mirrorhub/);
  } finally {
    await fake.cleanup();
  }
});

test("dry-run leaves the disk untouched", async () => {
  const fake = await fakeCtx();
  try {
    fake.ctx.dryRun = true;
    const applied = await forTool("npm")!.apply(fake.ctx, targetMirror("npm"));
    assert.match(applied.note ?? "", /dry-run/);
    await assert.rejects(readFile(join(fake.root, ".npmrc"), "utf8"), /ENOENT/);
  } finally {
    await fake.cleanup();
  }
});
