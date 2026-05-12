import Anthropic from "@anthropic-ai/sdk";
import { createMcpSession, callMcpTool } from "./mcp.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Override via ANTHROPIC_MODEL env var if you want to pin a specific version
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5";

const SYSTEM_PROMPT = `You are a Salesforce assistant for the RevOps team at HockeyStack. \
You have tools to query Salesforce data, analyze flows, validation rules, and opportunity documents.

Guidelines:
- Be concise and actionable
- Format responses for Slack: use *bold* (not **bold**), _italic_, \`field_names\`, and - bullet points
- When running multiple tools, summarize the combined findings clearly
- If a request is ambiguous, make a reasonable assumption and state it
- Never expose raw IDs unless asked — use names and labels instead`;

export interface Message {
  role: "user" | "assistant";
  content: string;
}

// Runs the full Claude agentic loop for one user message.
// Keeps calling tools until Claude produces a final text response.
export async function runClaudeLoop(
  userMessage: string,
  history: Message[]
): Promise<string> {
  const session = await createMcpSession();

  try {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    let response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: session.tools,
      messages,
    });

    // Tool call loop — Claude may call multiple tools across multiple turns
    while (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (toolUse) => {
          try {
            const result = await callMcpTool(
              session.client,
              toolUse.name,
              toolUse.input as Record<string, unknown>
            );
            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: result,
            };
          } catch (err) {
            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            };
          }
        })
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: session.tools,
        messages,
      });
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlock?.text ?? "(no response)";
  } finally {
    await session.close();
  }
}
