import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient, mapCommentNode, type FetchLike, type CommentNode } from "../src/linear.js";
import type { Config } from "../src/config.js";

const baseConfig = { linearApiUrl: "https://example.test/graphql", linearApiToken: "tok" } as Config;

interface Call {
  variables: Record<string, unknown>;
}

/** Build a fake fetch that returns queued GraphQL payloads and records calls. */
function fakeFetch(payloads: unknown[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...payloads];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ variables: body.variables });
    const payload = queue.shift() ?? { data: {} };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  return { fetch, calls };
}

function commentNode(id: string, createdAt: string, withIssue = true): CommentNode {
  return {
    id,
    body: `body ${id}`,
    createdAt,
    url: `https://linear.app/c/${id}`,
    user: { id: `u-${id}`, name: `User ${id}`, displayName: `disp ${id}` },
    issue: withIssue
      ? { id: `i-${id}`, identifier: `ENG-${id}`, title: `Issue ${id}`, url: "https://linear.app/i", team: { key: "ENG" } }
      : null,
  };
}

test("mapCommentNode flattens fields and prefers displayName", () => {
  const m = mapCommentNode(commentNode("1", "2026-01-01T00:00:00.000Z"));
  assert.equal(m.id, "1");
  assert.equal(m.issueIdentifier, "ENG-1");
  assert.equal(m.authorName, "disp 1");
  assert.equal(m.teamKey, "ENG");
});

test("getViewer returns the identity", async () => {
  const { fetch } = fakeFetch([{ data: { viewer: { id: "v1", name: "Bot" } } }]);
  const client = new LinearClient(baseConfig, fetch);
  assert.deepEqual(await client.getViewer(), { id: "v1", name: "Bot" });
});

test("fetchCommentsSince drains pages, drops issue-less comments, sorts ascending", async () => {
  const { fetch, calls } = fakeFetch([
    {
      data: {
        comments: {
          nodes: [
            commentNode("b", "2026-01-02T00:00:00.000Z"),
            commentNode("noissue", "2026-01-03T00:00:00.000Z", false),
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    },
    {
      data: {
        comments: {
          nodes: [commentNode("a", "2026-01-01T00:00:00.000Z")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ]);
  const client = new LinearClient(baseConfig, fetch);

  const result = await client.fetchCommentsSince("2025-12-31T00:00:00.000Z");

  // Two pages fetched; the second carried the first page's cursor.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.variables.after, null);
  assert.equal(calls[1]?.variables.after, "cursor-1");

  // issue-less comment filtered out, remaining sorted oldest-first.
  assert.deepEqual(
    result.map((c) => c.id),
    ["a", "b"],
  );
});

test("createComment returns the new url and throws on failure", async () => {
  const ok = fakeFetch([
    { data: { commentCreate: { success: true, comment: { id: "c1", url: "https://linear.app/c/c1" } } } },
  ]);
  const client = new LinearClient(baseConfig, ok.fetch);
  assert.equal(await client.createComment("i-1", "hi"), "https://linear.app/c/c1");

  const bad = fakeFetch([{ data: { commentCreate: { success: false, comment: null } } }]);
  const client2 = new LinearClient(baseConfig, bad.fetch);
  await assert.rejects(() => client2.createComment("i-1", "hi"), /rejected/);
});

test("surfaces GraphQL errors", async () => {
  const { fetch } = fakeFetch([{ errors: [{ message: "Bad token" }] }]);
  const client = new LinearClient(baseConfig, fetch);
  await assert.rejects(() => client.getViewer(), /Bad token/);
});
