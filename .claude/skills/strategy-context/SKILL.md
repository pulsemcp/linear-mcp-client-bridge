---
name: strategy-context
description: Answer strategy questions about technical work on a Linear ticket by grounding the answer in Zoom meeting transcripts and Notion documentation (both reached through the MCP aggregator). Use this whenever a comment asks about the "why", direction, priorities, scope, trade-offs, or decisions behind technical work — anything that depends on what was discussed in meetings or written down in docs rather than what is on the ticket itself.
---

# Strategy context from Zoom + Notion

Strategy questions are rarely answerable from the Linear ticket alone. The reasoning —
why we are building this, what was decided, what got deprioritized, which trade-off
won — usually lives in two systems the operator has wired up through the MCP
aggregator:

- **Notion** — the durable written record: PRDs, specs, roadmaps, design docs,
  decision logs, and meeting notes. Treat it as the source of truth for what was
  formally **decided**.
- **Zoom** — meeting transcripts and recordings: the verbal discussion, rationale,
  and back-and-forth. This is where you find the **why**, and decisions that have
  not been written up yet.

Both surface as `mcp__*` tools (often behind the gateway/aggregator entry in
`.mcp.json`). Your job is to connect the technical ticket to that context and answer
with grounded, cited reasoning — not to guess from the ticket text.

## Procedure

1. **Pin down the strategy question.** What is actually being asked — is something
   *decided* or still open? What is the *rationale*? What is the *priority* or
   *sequencing*? Is the *scope* in or out? Was an alternative considered and rejected?

2. **Get the Linear context first.** Use `get_issue` / `search_issues` to pull the
   thread, linked issues, the parent project, labels, and who is involved. Tickets
   often link the relevant Notion doc directly, and related tickets name the project
   or feature under discussion.

3. **Find the Zoom and Notion tools.** Scan the `mcp__*` tools and read their
   descriptions. If the aggregator exposes a discovery/search tool, use it to locate
   the right capability. Notion tools typically search and fetch pages; Zoom tools
   typically list meetings, search recordings, and fetch transcripts.

4. **Check Notion first — the written record.** Search by the project/feature name
   and the key terms from the ticket (not the Linear identifier — docs rarely use
   "ENG-123"). Open the authoritative doc (PRD, spec, decision log) and follow links
   between pages. Note the page's last-edited date and owner so you can flag staleness.

5. **Then mine Zoom transcripts for the "why" and recent decisions.** Search
   transcripts for the topic/feature. Transcripts are long and noisy: locate the
   relevant span and read around it rather than skimming the whole thing. Attribute
   who said what, and record the meeting date — a decision in last week's planning
   call can supersede a month-old doc. Use Zoom to fill the gaps Notion does not
   cover yet.

6. **Reconcile, with a clear hierarchy.** Notion is canonical for what is *formally
   decided*; a more recent Zoom discussion can amend or override it. If the two
   conflict, say so explicitly and present both with their dates — never silently
   pick one.

7. **Answer like a teammate, with sources.** Lead with the direct answer. Separate
   "decided" from "still under discussion." Cite each claim: the Notion page (with
   link) or the Zoom meeting (name + date), plus any relevant Linear tickets. Quote
   sparingly, where exact wording matters.

8. **Fail honestly.** If neither Zoom nor Notion covers it, say what you searched and
   what is missing. For a strategy question, "this isn't documented or decided yet"
   is often the real answer — and it tells the team where the gap is.

## Tips

- **Search terms matter.** Pull the project codename, feature name, and component
  from the ticket; meetings and docs use those, not the Linear identifier. Try
  synonyms if the first search is thin.
- **Recency is signal.** Prefer the newest doc/meeting, and flag it when the best
  source you found is old.
- **Attribute and date everything from Zoom.** Transcripts capture opinions and
  half-formed ideas, not just decisions. "X was raised as a concern" is not "we
  decided X."
- **Transcripts can be wrong** — mis-transcribed names, numbers, and product terms
  are common. Corroborate any critical fact against Notion or the ticket.
- **Don't over-fetch.** A targeted search plus the one right page or transcript beats
  dumping everything into context.

## Example

> Comment on `ENG-742`: "Before I start — are we still doing the realtime sync the
> spec mentions, or did we decide to punt it to v2? The ticket isn't clear."

A good run:

- `get_issue("ENG-742")` → it links a Notion "Sync v1 PRD" and references project
  "Mercury".
- Notion search "Mercury sync PRD" → open it: realtime sync is listed but flagged
  "TBD pending perf review," last edited three weeks ago.
- Zoom search "Mercury sync" → the most recent "Mercury planning" transcript: the
  team agreed to ship batch sync in v1 and move realtime to v2 after the perf review.
- Reply on `ENG-742`: "Punt it — realtime sync is moving to v2. The PRD still says
  *TBD* (last edited ~3 weeks ago), but in the **Mercury planning** call on
  <date> the team decided v1 ships batch-only and realtime goes to v2 pending the
  perf review. Worth updating the PRD to match. Sources: Notion *Sync v1 PRD*
  <link>, Zoom *Mercury planning* <date>."

That is the move: a Linear question in → Notion for the written record, Zoom for the
latest reasoning → a dated, sourced answer that clearly separates what is decided
from what is stale or still open.
