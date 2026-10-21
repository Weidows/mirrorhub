// Builds a Node SEA (single executable application) for the current platform.
// CI runs this natively on every target OS: the V8 blob is platform-specific,
// so cross-compiling it is not supported by Node.
//
//   npm run build:sea  ->  build/mirrorhub-<platform>-<arch>[.exe]
//
// Node SEA embeds the whole node binary (~90 MB), so the default output is huge.
// Set MIRRORHUB_UPX=1 (or MIRRORHUB_UPX=/path/to/upx) to compress it to ~30 MB.
// Cost: every start unpacks the image, ~+300 ms on a warm Windows box.
import { spawnSync } from "node:child_process";
import { readFile, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import postject from "postject";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build");
const entry = join(root, "dist", "index.js");
const bundle = join(build, "mirrorhub.cjs");
const blob = join(build, "mirrorhub.blob");
const exe = join(build, `mirrorhub-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status ?? res.signal}`);
  }
};

await mkdir(build, { recursive: true });

// 1. One CommonJS file: SEA still loads a classic script, and this also keeps
//    the packed size small by dropping the compiler-shaped module graph.
await esbuild.build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
});
console.log("bundled ->", bundle);

// 2. Snapshot the bundle into a V8 blob.
const config = join(build, "sea-config.json");
await writeFile(
  config,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", config]);

// 3. Copy the running node binary and inject the blob into it.
await copyFile(process.execPath, exe);
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", exe]);
}
const inject = postject.inject ?? postject.default?.inject;
if (typeof inject !== "function") throw new Error("postject.inject is unavailable");
await inject(exe, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
// 4. Optional UPX compression. Signing must come last: UPX rewrites the image.
//    UPX refuses Mach-O ("macOS is currently not supported"), so darwin keeps the
//    raw binary and the release workflow ships it as .tar.gz instead.
const upx = process.env.MIRRORHUB_UPX;
if (upx && process.platform === "darwin") {
  console.log("upx skipped: UPX does not support Mach-O binaries");
}
if (upx && process.platform !== "darwin") {
  const rawSize = (await stat(exe)).size;
  const tmp = `${exe}.upx`;
  await copyFile(exe, tmp);
  try {
    const args = ["-9", "--quiet", tmp];
    // ELF after postject injection trips UPX's e_phoff sanity check.
    if (process.platform === "linux") args.splice(2, 0, "--force");
    run(upx === "1" ? "upx" : upx, args);
    await rename(tmp, exe);
    const packed = (await stat(exe)).size;
    console.log(
      `upx -> ${(rawSize / 1024 / 1024).toFixed(1)} MB => ${(packed / 1024 / 1024).toFixed(1)} MB`,
    );
  } catch (err) {
    await rm(tmp, { force: true });
    console.warn(`upx failed, keeping the uncompressed binary: ${err.message}`);
  }
}
if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", exe]);
}

const size = (await stat(exe)).size;
console.log(`sea -> ${exe} (${(size / 1024 / 1024).toFixed(1)} MB)`);
