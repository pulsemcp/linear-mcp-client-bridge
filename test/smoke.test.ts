import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSmokeArgs, pickSmokeComment } from "../src/smoke.js";
import type { LinearComment } from "../src/linear.js";

const VIEWER = "viewer-1";

function comment(over: Partial<LinearComment> = {}): LinearComment {
  return {
    id: "c1",
    body: "hello",
    createdAt: "2026-06-20T00:00:00.000Z",
    url: "https://linear.app/x/c1",
    authorId: "someone",
    authorName: "Someone",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Title",
    issueUrl: "https://linear.app/x/ENG-1",
    teamKey: "ENG",
    ...over,
  };
}

test("parseSmokeArgs defaults: post mode, 120-minute window, no issue filter", () => {
  const o = parseSmokeArgs([]);
  assert.equal(o.dryRun, false);
  assert.equal(o.lookbackMinutes, 120);
  assert.equal(o.issue, undefined);
});

test("parseSmokeArgs reads --dry-run, --issue and --lookback-min", () => {
  const o = parseSmokeArgs(["--dry-run", "--issue", "ENG-12", "--lookback-min", "30"]);
  assert.equal(o.dryRun, true);
  assert.equal(o.issue, "ENG-12");
  assert.equal(o.lookbackMinutes, 30);
});

test("parseSmokeArgs ignores a non-positive lookback and keeps the default", () => {
  assert.equal(parseSmokeArgs(["--lookback-min", "0"]).lookbackMinutes, 120);
  assert.equal(parseSmokeArgs(["--lookback-min", "nope"]).lookbackMinutes, 120);
});

test("pickSmokeComment returns the newest answerable comment (last in ascending order)", () => {
  const chosen = pickSmokeComment(
    [comment({ id: "old" }), comment({ id: "new" })],
    VIEWER,
    [],
  );
  assert.equal(chosen?.id, "new");
});

test("pickSmokeComment skips the bot's own comments and out-of-scope teams", () => {
  // Our own comment must never be chosen even if it's newest.
  assert.equal(
    pickSmokeComment([comment({ id: "ok" }), comment({ id: "mine", authorId: VIEWER })], VIEWER, [])?.id,
    "ok",
  );
  // Team allowlist excludes other teams.
  assert.equal(
    pickSmokeComment([comment({ teamKey: "OPS" })], VIEWER, ["ENG"]),
    null,
  );
});

test("pickSmokeComment restricts to a single issue (case-insensitive) when --issue is set", () => {
  const comments = [comment({ id: "a", issueIdentifier: "ENG-1" }), comment({ id: "b", issueIdentifier: "ENG-2" })];
  assert.equal(pickSmokeComment(comments, VIEWER, [], "eng-2")?.id, "b");
  assert.equal(pickSmokeComment(comments, VIEWER, [], "ENG-9"), null);
});

test("pickSmokeComment returns null when nothing is answerable", () => {
  assert.equal(pickSmokeComment([], VIEWER, []), null);
});
