import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "bridge-state-"));
}

test("fresh state defaults the cursor to now and has no session", async () => {
  const dir = await tmpDir();
  const now = "2026-01-01T00:00:00.000Z";
  const store = await StateStore.load(dir, now);
  assert.equal(store.sessionId, null);
  assert.equal(store.lastSeen, now);
});

test("persists session id and reloads it", async () => {
  const dir = await tmpDir();
  const store = await StateStore.load(dir, "2026-01-01T00:00:00.000Z");
  await store.setSessionId("sess-123");
  const reloaded = await StateStore.load(dir, "2026-02-01T00:00:00.000Z");
  assert.equal(reloaded.sessionId, "sess-123");
  // Existing lastSeen must win over the fresh "now" on reload.
  assert.equal(reloaded.lastSeen, "2026-01-01T00:00:00.000Z");
});

test("markProcessed advances the cursor and dedupes", async () => {
  const dir = await tmpDir();
  const store = await StateStore.load(dir, "2026-01-01T00:00:00.000Z");

  assert.equal(store.alreadyProcessed("c1"), false);
  await store.markProcessed("c1", "2026-01-02T00:00:00.000Z");
  assert.equal(store.alreadyProcessed("c1"), true);
  assert.equal(store.lastSeen, "2026-01-02T00:00:00.000Z");

  // An older timestamp must not move the cursor backwards.
  await store.markProcessed("c0", "2025-12-31T00:00:00.000Z");
  assert.equal(store.lastSeen, "2026-01-02T00:00:00.000Z");
});

test("processed-id ring buffer is bounded", async () => {
  const dir = await tmpDir();
  const store = await StateStore.load(dir, "2026-01-01T00:00:00.000Z");
  for (let i = 0; i < 600; i++) {
    await store.markProcessed(`c${i}`, "2026-01-01T00:00:00.000Z");
  }
  // The oldest ids have been evicted (cap is 500); the newest remain.
  assert.equal(store.alreadyProcessed("c0"), false);
  assert.equal(store.alreadyProcessed("c599"), true);

  const raw = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.ok(raw.processedIds.length <= 500);
});
