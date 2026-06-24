import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ActivityHub } from "../src/activity.js";
import { formatSse, startVizServer } from "../src/web.js";

test("formatSse emits a well-formed SSE message", () => {
  const msg = formatSse({ id: 7, ts: "2026-01-01T00:00:00.000Z", type: "info", text: "hi" });
  assert.equal(
    msg,
    'id: 7\nevent: activity\ndata: {"id":7,"ts":"2026-01-01T00:00:00.000Z","type":"info","text":"hi"}\n\n',
  );
});

/** Start a server on an ephemeral port and return its base URL + a stopper. */
async function withServer(
  hub: ActivityHub,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  // projectRoot doesn't matter here — the server falls back to inline HTML if
  // public/index.html isn't found, which is fine for these checks.
  const server = await startVizServer({ hub, projectRoot: process.cwd(), port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET / serves the activity page", async () => {
  await withServer(new ActivityHub(), async (base) => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<!doctype html>/i);
  });
});

test("GET /healthz reports buffered count and subscriber count", async () => {
  const hub = new ActivityHub();
  hub.emit({ type: "info", text: "boot" });
  await withServer(hub, async (base) => {
    const res = await fetch(base + "/healthz");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; buffered: number; subscribers: number };
    assert.equal(json.ok, true);
    assert.equal(json.buffered, 1);
    assert.equal(json.subscribers, 0);
  });
});

test("a non-GET method is rejected, unknown paths 404", async () => {
  await withServer(new ActivityHub(), async (base) => {
    const post = await fetch(base + "/", { method: "POST" });
    assert.equal(post.status, 405);
    const missing = await fetch(base + "/nope");
    assert.equal(missing.status, 404);
  });
});

test("GET /events replays the ring buffer then streams a live event", async () => {
  const hub = new ActivityHub();
  hub.emit({ type: "comment", issue: "ENG-1", text: "buffered before connect" });

  await withServer(hub, async (base) => {
    const ac = new AbortController();
    const res = await fetch(base + "/events", { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const readUntil = async (needle: string): Promise<void> => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before seeing ${JSON.stringify(needle)}`);
        buf += decoder.decode(value, { stream: true });
      }
    };

    // The replayed buffered event arrives first...
    await readUntil("buffered before connect");
    // ...then a freshly emitted event streams live.
    hub.emit({ type: "reply", issue: "ENG-1", text: "live after connect" });
    await readUntil("live after connect");

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
