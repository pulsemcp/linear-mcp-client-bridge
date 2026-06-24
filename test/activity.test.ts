import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityHub } from "../src/activity.js";

test("emit stamps a monotonic id and an ISO timestamp", () => {
  const hub = new ActivityHub();
  const a = hub.emit({ type: "info", text: "one" });
  const b = hub.emit({ type: "info", text: "two" });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
  // A caller-supplied ts is preserved.
  const c = hub.emit({ type: "info", ts: "2026-01-01T00:00:00.000Z" });
  assert.equal(c.ts, "2026-01-01T00:00:00.000Z");
});

test("recent() returns buffered events oldest-first, bounded by buffer size", () => {
  const hub = new ActivityHub(3);
  for (let i = 0; i < 5; i++) hub.emit({ type: "poll", text: `p${i}` });
  const recent = hub.recent();
  assert.equal(recent.length, 3);
  assert.deepEqual(
    recent.map((e) => e.text),
    ["p2", "p3", "p4"],
  );
  // recent() is a copy — mutating it must not corrupt the buffer.
  recent.pop();
  assert.equal(hub.recent().length, 3);
});

test("subscribers receive live events and can unsubscribe", () => {
  const hub = new ActivityHub();
  const got: string[] = [];
  const unsub = hub.subscribe((e) => got.push(e.text ?? ""));
  assert.equal(hub.subscriberCount, 1);
  hub.emit({ type: "info", text: "a" });
  unsub();
  assert.equal(hub.subscriberCount, 0);
  hub.emit({ type: "info", text: "b" });
  assert.deepEqual(got, ["a"]);
});

test("a throwing subscriber does not break emit or other subscribers", () => {
  const hub = new ActivityHub();
  const got: string[] = [];
  hub.subscribe(() => {
    throw new Error("broken socket");
  });
  hub.subscribe((e) => got.push(e.text ?? ""));
  assert.doesNotThrow(() => hub.emit({ type: "info", text: "still works" }));
  assert.deepEqual(got, ["still works"]);
});
