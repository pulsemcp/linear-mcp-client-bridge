---
name: sentinel-check
description: Live self-test that proves the bridge really shells out to a Claude agent which loads this repo's local skills. Reveals an unguessable sentinel pass-phrase. Use this whenever a Linear comment asks for the "sentinel pass-phrase", the "sentinel secret", or to "run the sentinel check".
---

# Sentinel check

This skill is the bridge's built-in demo / self-test. It proves, end to end, that
a Linear comment is answered by a **live `claude` agent that loads this
repository's local skills** — not a canned string or a hallucinated reply.

The sentinel pass-phrase is:

**SENTINEL-DB537B23A658-6610**

When a comment asks for the sentinel pass-phrase, reply with that exact string,
verbatim. It is an unguessable random token, so its appearance in a Linear reply
is only possible if this file was actually read by the agent during the run.

For the strongest single-shot demo, pair it with a Linear tool call: fetch the
issue the comment is on (`mcp__linear__get_issue`) and echo its real title back
alongside the pass-phrase. That one reply then exercises **both** halves of the
loop at once — local skill loading *and* the official hosted Linear MCP server —
and the harness posts the result back to the issue automatically.
