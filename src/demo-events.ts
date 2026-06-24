import type { ActivityInput } from "./activity.js";

/**
 * A realistic, self-contained activity script for previewing the web view
 * without a live Linear/Anthropic connection.
 *
 * `npm run viz:demo` replays this on a timer so you can see exactly what the
 * split-screen demo will look like (and rehearse the recording) before pointing
 * the real daemon at your workspace. It's also handy for screenshot tests.
 *
 * Each step is an event plus how long to wait *before* emitting it.
 */
export interface DemoStep {
  delayMs: number;
  event: ActivityInput;
}

const ISSUE = "ENG-204";
const TITLE = "Checkout 500s on expired coupons";

export const DEMO_SCRIPT: DemoStep[] = [
  { delayMs: 200, event: { type: "info", text: "Activity view live on port 8787." } },
  { delayMs: 400, event: { type: "info", text: "Authenticated with Linear as Bridge Bot." } },
  { delayMs: 400, event: { type: "info", text: "Watching Linear — polling every 20s." } },
  { delayMs: 900, event: { type: "poll", text: "Picked up 1 new comment(s) from Linear." } },
  {
    delayMs: 500,
    event: {
      type: "comment",
      issue: ISSUE,
      title: TITLE,
      actor: "priya",
      text: "@bridge can you look into why checkout returns a 500 when a coupon is expired, and link any related tickets?",
    },
  },
  {
    delayMs: 800,
    event: { type: "info", issue: ISSUE, title: TITLE, text: "Agent online — 47 tools available", detail: "MCP: linear, gateway" },
  },
  {
    delayMs: 700,
    event: { type: "assistant", issue: ISSUE, text: "On it. Let me pull this issue and search for related checkout/coupon tickets." },
  },
  {
    delayMs: 600,
    event: { type: "tool-use", issue: ISSUE, tool: "mcp__linear__get_issue", text: '{"id":"ENG-204"}' },
  },
  {
    delayMs: 900,
    event: {
      type: "tool-result",
      issue: ISSUE,
      tool: "mcp__linear__get_issue",
      text: 'ENG-204 · "Checkout 500s on expired coupons" · status: In Progress · team: Eng',
    },
  },
  {
    delayMs: 800,
    event: { type: "tool-use", issue: ISSUE, tool: "mcp__linear__list_issues", text: '{"query":"coupon expired checkout 500","limit":5}' },
  },
  {
    delayMs: 1000,
    event: {
      type: "tool-result",
      issue: ISSUE,
      tool: "mcp__linear__list_issues",
      text: "3 matches: ENG-188 (coupon validation refactor), ENG-150 (cart totals NPE), SUP-91 (customer report: promo code error)",
    },
  },
  {
    delayMs: 900,
    event: {
      type: "assistant",
      issue: ISSUE,
      text: "Found the likely culprit — ENG-188 changed coupon validation to throw instead of returning null, and checkout never caught it. ENG-150 and SUP-91 look related. Writing up a reply.",
    },
  },
  {
    delayMs: 1100,
    event: {
      type: "reply",
      issue: ISSUE,
      title: TITLE,
      text: "Likely cause: ENG-188 made expired-coupon validation throw, and the checkout handler doesn't catch it → 500. Related: ENG-150 (cart totals NPE), SUP-91 (customer report). Suggested fix: catch the validation error and return a 422 with a clear message. Want me to open a fix ticket?",
      detail: "https://linear.app/acme/issue/ENG-204#comment-7f3a21",
    },
  },
];
