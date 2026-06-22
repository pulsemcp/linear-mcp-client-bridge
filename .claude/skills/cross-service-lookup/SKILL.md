---
name: cross-service-lookup
description: Answer a Linear ticket by finding and using the right connected MCP server. Use this whenever a comment asks something you can't answer from the issue alone — e.g. it references a customer, an order, a deploy, a metric, a doc, a repo, or any external system. The skill explains how to discover what MCP tools are connected and route the question to the best one.
---

# Cross-service lookup

The whole point of this bridge is that you are not just a chatbot on a ticket —
you are an MCP **client** with access to whatever services the operator wired up
in `.mcp.json` (often an MCP gateway/aggregator that fronts many servers at
once). When a ticket needs information that lives in another system, go get it.

## Procedure

1. **Read the real question.** What does the commenter actually need, and which
   system would hold the answer? (A customer record → CRM/DB. A deploy status →
   CI/infra. "How do I…" → docs. A code reference → the repo. A metric →
   analytics.)

2. **Inventory your tools.** You have:
   - the built-in `linear` tools (`get_issue`, `search_issues`, …), and
   - every tool exposed by the MCP servers in `.mcp.json`, which appear as
     `mcp__<server>__<tool>`. An aggregator/gateway typically surfaces many
     upstream servers through a single connection, so scan the available
     `mcp__*` tools and read their descriptions before deciding nothing fits.
   If a gateway exposes a discovery/search tool (e.g. one that lists or searches
   upstream tools or resources), use it to find the right capability first.

3. **Gather Linear context first.** Use `search_issues` / `get_issue` to pull
   related tickets and the full thread. Past tickets often name the system or
   record you need.

4. **Call the most specific tool.** Prefer a precise lookup over a broad one.
   Chain calls when needed (search → fetch detail). Pass identifiers you already
   extracted from the ticket.

5. **Synthesize and cite.** Answer the question directly. Briefly name where the
   information came from (which service / which ticket / which doc) so the
   commenter can verify it. Include links when a tool returns them.

6. **Fail honestly.** If no connected service can answer, say what you checked
   and what tool or access would be needed — that feedback tells the operator
   which MCP server to add next.

## Example

> Comment on `SUP-204`: "Did customer acme-co's latest invoice actually go out?
> They say they never got it."

A good run:
- `search_issues("acme-co invoice")` → finds `SUP-188` mentioning their billing
  account id `cus_3f9…`.
- Discover a billing capability among the `mcp__*` tools (directly, or via the
  gateway's discovery tool) and look up that customer's recent invoices.
- Find the invoice is `status: sent` but to an old email address.
- Reply on `SUP-204`: state the finding, the source (billing service), the
  invoice id, and the likely cause (stale email), with a suggested next step.

That round-trip — Linear comment in, the right external system queried, a
sourced answer back — is exactly the capability this bridge exists to give you.
Reach for it by default rather than guessing from memory.
