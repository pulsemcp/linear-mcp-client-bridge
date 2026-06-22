import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LinearClient } from "./linear.js";

/**
 * An in-process MCP server that exposes Linear to the agent as first-class
 * tools. Because it runs inside this Node process, it reuses the same API
 * token the bridge already holds — no extra process, no extra secret.
 *
 * This sits alongside whatever the operator configures in `.mcp.json`
 * (an MCP gateway, other servers, ...). The agent sees one unified toolbox.
 */
export function createLinearMcpServer(linear: LinearClient) {
  const okText = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const errText = (err: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  });

  const getIssue = tool(
    "get_issue",
    "Fetch full detail for a Linear issue (description, status, assignee, labels, and its comment thread) by issue id or identifier like ENG-123.",
    { id: z.string().describe("Issue id or identifier, e.g. ENG-123") },
    async ({ id }) => {
      try {
        return okText(await linear.getIssue(id));
      } catch (err) {
        return errText(err);
      }
    },
  );

  const searchIssues = tool(
    "search_issues",
    "Free-text search across all Linear issues the token can see. Use this to find related tickets, prior art, or context before answering.",
    {
      term: z.string().describe("Search text"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
    async ({ term, limit }) => {
      try {
        return okText(await linear.searchIssues(term, limit ?? 10));
      } catch (err) {
        return errText(err);
      }
    },
  );

  const listMyIssues = tool(
    "list_my_issues",
    "List the open issues assigned to the bridge's own Linear user.",
    {
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    async ({ limit }) => {
      try {
        return okText(await linear.listMyIssues(limit ?? 20));
      } catch (err) {
        return errText(err);
      }
    },
  );

  const postComment = tool(
    "post_comment",
    "Post a comment onto a Linear issue. Note: your final reply to the issue you are currently handling is posted automatically — only use this to comment on a DIFFERENT issue.",
    {
      issueId: z.string().describe("The issue id (UUID) to comment on"),
      body: z.string().describe("Markdown comment body"),
    },
    async ({ issueId, body }) => {
      try {
        const url = await linear.createComment(issueId, body);
        return okText({ posted: true, url });
      } catch (err) {
        return errText(err);
      }
    },
  );

  return createSdkMcpServer({
    name: "linear",
    version: "0.1.0",
    tools: [getIssue, searchIssues, listMyIssues, postComment],
  });
}
