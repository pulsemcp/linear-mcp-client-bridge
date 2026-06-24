import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyComment } from "../src/filter.js";

const VIEWER = "viewer-1";
const none = () => false;

function comment(over: Partial<{ id: string; authorId: string | null; teamKey: string | null }> = {}) {
  return { id: "c1", authorId: "someone", teamKey: "ENG", ...over };
}

test("our own comments are classified as self", () => {
  assert.equal(classifyComment(comment({ authorId: VIEWER }), VIEWER, [], none), "self");
});

test("already-processed comments are duplicates", () => {
  const isProcessed = (id: string) => id === "c1";
  assert.equal(classifyComment(comment(), VIEWER, [], isProcessed), "duplicate");
});

test("self takes precedence over duplicate", () => {
  assert.equal(classifyComment(comment({ authorId: VIEWER }), VIEWER, [], () => true), "self");
});

test("comments outside the team allowlist are out-of-scope", () => {
  assert.equal(classifyComment(comment({ teamKey: "OPS" }), VIEWER, ["ENG"], none), "out-of-scope");
  // A comment with no team can't match an allowlist.
  assert.equal(classifyComment(comment({ teamKey: null }), VIEWER, ["ENG"], none), "out-of-scope");
});

test("a fresh in-scope comment is handled", () => {
  assert.equal(classifyComment(comment(), VIEWER, ["ENG"], none), "handle");
  // No allowlist means every team is in scope.
  assert.equal(classifyComment(comment({ teamKey: "OPS" }), VIEWER, [], none), "handle");
});
