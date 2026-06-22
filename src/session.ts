import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { createLinearMcpServer } from "./linear-tools.js";
import type { LinearClient } from "./linear.js";
import type { StateStore } from "./state.js";

/**
 * Wraps the Claude Agent SDK so that every Linear comment is handled as one
 * more turn in a SINGLE, continuous conversation.
 *
 * The trick is `resume`: the first turn creates a session and we capture its
 * id; every turn after that passes `resume: <sessionId>`, so the agent keeps
 * the full history of every ticket it has ever seen. That shared memory is the
 * whole point — ticket #42 can be answered with what it learned on ticket #7.
 */
export class AgentSession {
  constructor(
    private readonly config: Config,
    private readonly linear: LinearClient,
    private readonly state: StateStore,
  ) {}

  /**
   * Run one turn. Returns the agent's final text, which the caller posts back
   * to Linear as the reply.
   */
  async run(prompt: string): Promise<string> {
    const resume = this.state.sessionId ?? undefined;

    const options: Options = {
      model: this.config.model,
      cwd: this.config.projectRoot,
      // Load CLAUDE.md, .claude/skills and project settings from disk.
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Make every skill the project ships available to the agent.
      skills: "all",
      // Unattended daemon: there is no human to approve tool calls. See the
      // README "Security" section — run this only against trusted workspaces.
      permissionMode: this.config.permissionMode as Options["permissionMode"],
      allowDangerouslySkipPermissions: this.config.permissionMode === "bypassPermissions",
      // Combine the in-process Linear tools with whatever the operator put in
      // .mcp.json (an MCP gateway, other servers, ...).
      strictMcpConfig: false,
      mcpServers: {
        // createSdkMcpServer() already returns a { type: "sdk", ... } config.
        linear: createLinearMcpServer(this.linear),
      },
      ...(resume ? { resume } : {}),
    };

    let finalText = "";
    const assistantText: string[] = [];

    for await (const message of query({ prompt, options })) {
      const msg = message as Record<string, any>;

      if (typeof msg.session_id === "string") {
        await this.state.setSessionId(msg.session_id);
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content as Array<Record<string, any>>) {
          if (block.type === "text" && typeof block.text === "string") {
            assistantText.push(block.text);
          }
        }
      }

      if (msg.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string") {
          finalText = msg.result;
        } else if (msg.subtype && msg.subtype !== "success") {
          throw new Error(`Agent turn ended with subtype "${msg.subtype}"`);
        }
      }
    }

    const reply = (finalText || assistantText.join("\n\n")).trim();
    return reply;
  }
}
