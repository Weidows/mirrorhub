import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { run } from "../dist/probe.js";

async function localServer(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const server = createServer((_req, res) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight--;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    peak: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("probe run caps parallelism and reports progress per unique url", async () => {
  const server = await localServer(120);
  try {
    const targets = Array.from({ length: 6 }, (_, i) => ({
      tool_id: `t${i}`,
      mirror_id: "m",
      name: `n${i}`,
      url: `http://127.0.0.1:${server.port}/p${i}`,
    }));
    const seen: string[] = [];
    const results = await run(targets, {
      workers: 3,
      timeoutMs: 5000,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });

    assert.deepEqual(seen, ["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    assert.equal(results.length, 6);
    assert.deepEqual(results.map((r) => r.tool_id), targets.map((t) => t.tool_id));
    assert.ok(results.every((r) => r.ok), "every probe should succeed");
    assert.equal(server.peak(), 3, "three workers should keep three requests in flight");
  } finally {
    await server.close();
  }
});

test("probe run measures a shared url once and copies the result", async () => {
  const server = await localServer(10);
  try {
    const url = `http://127.0.0.1:${server.port}/same`;
    const targets = ["npm", "pnpm", "yarn"].map((tool) => ({ tool_id: tool, mirror_id: "npmmirror", name: "npmmirror", url }));
    let calls = 0;
    const results = await run(targets, { workers: 3, timeoutMs: 5000, onProgress: () => calls++ });

    assert.equal(calls, 1, "one progress step for one unique url");
    assert.equal(results.length, 3);
    assert.equal(new Set(results.map((r) => r.total_ms)).size, 1, "siblings share the measurement");
    assert.deepEqual(results.map((r) => r.tool_id), ["npm", "pnpm", "yarn"]);
    assert.equal(server.peak(), 1, "the shared url is fetched once");
  } finally {
    await server.close();
  }
});
