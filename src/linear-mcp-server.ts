import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadLinearConfig } from "./config.js";
import { LinearClient } from "./linear.js";

/**
 * A standalone stdio MCP server that exposes Linear to the agent as first-class
 * tools (`get_issue`, `search_issues`, `list_my_issues`, `post_comment`).
 *
 * The bridge drives Claude through the `claude` CLI (`claude -p`), which runs as
 * a separate process — so the Linear tools can't live in-process. Instead the
 * CLI launches this file over stdio (see `session.ts`, which passes it via
 * `--mcp-config`). It reads `LINEAR_API_TOKEN` from the environment it inherits
 * from the daemon, so the token never needs to appear on a command line.
 *
 * This sits alongside whatever the operator configures in `.mcp.json`
 * (an MCP gateway, other servers, ...). The agent sees one unified toolbox.
 */
const ok = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

async function main(): Promise<void> {
  const linear = new LinearClient(loadLinearConfig());
  const server = new McpServer({ name: "linear", version: "0.1.0" });

  server.registerTool(
    "get_issue",
    {
      description:
        "Fetch full detail for a Linear issue (description, status, assignee, labels, and its comment thread) by issue id or identifier like ENG-123.",
      inputSchema: { id: z.string().describe("Issue id or identifier, e.g. ENG-123") },
    },
    async ({ id }) => {
      try {
        return ok(await linear.getIssue(id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_issues",
    {
      description:
        "Free-text search across all Linear issues the token can see. Use this to find related tickets, prior art, or context before answering.",
      inputSchema: {
        term: z.string().describe("Search text"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
    },
    async ({ term, limit }) => {
      try {
        return ok(await linear.searchIssues(term, limit ?? 10));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_my_issues",
    {
      description: "List the open issues assigned to the bridge's own Linear user.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
      },
    },
    async ({ limit }) => {
      try {
        return ok(await linear.listMyIssues(limit ?? 20));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "post_comment",
    {
      description:
        "Post a comment onto a Linear issue. Note: your final reply to the issue you are currently handling is posted automatically — only use this to comment on a DIFFERENT issue.",
      inputSchema: {
        issueId: z.string().describe("The issue id (UUID) to comment on"),
        body: z.string().describe("Markdown comment body"),
      },
    },
    async ({ issueId, body }) => {
      try {
        return ok({ posted: true, url: await linear.createComment(issueId, body) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error("linear-mcp-server fatal:", err);
  process.exit(1);
});
