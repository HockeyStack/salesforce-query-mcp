import Anthropic from "@anthropic-ai/sdk";
import { createMcpSession, callMcpTool } from "./mcp.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Override via ANTHROPIC_MODEL env var if you want to pin a specific version
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5";

// Cap individual tool results to avoid blowing past Claude's 200k token context limit.
// Salesforce describe/flow metadata responses can be very large.
const MAX_TOOL_RESULT_CHARS = 40_000;

const SYSTEM_PROMPT = `You are a Salesforce assistant for the RevOps team at HockeyStack. You have tools to query Salesforce data, analyze flows, validation rules, and opportunity documents.

Guidelines:
- Be concise and actionable
- Format responses for Slack: use *bold* (not **bold**), _italic_, \`field_names\`, and - bullet points
- Never use emojis
- Never use markdown tables - Slack does not render them and they look broken as plain text. Use bullet lists or plain paragraphs instead
- Never use em dashes. Use a hyphen (-) or colon instead
- When running multiple tools, summarize the combined findings clearly
- If a request is ambiguous, make a reasonable assumption and state it
- Never expose raw IDs unless asked - use names and labels instead
- For bulk audits (e.g. "audit all my contracts", "check all opportunity dates", "find date discrepancies", "audit all PDFs"), ALWAYS use a compound audit tool like sf_audit_contract_dates or sf_audit_multi_year_splits when one fits the request. NEVER iterate through opportunities one at a time using sf_get_opportunity_files + sf_read_file_as_text for bulk work - that exceeds context limits and produces inconsistent batching and hallucinations
- If the user asks for "more", "the rest", "keep going", or "next batch" after a compound audit returned its full result set, explain that the tool already returned the complete result in one call. Offer to filter, sort, or drill into specific accounts/opportunities instead`;

export interface Message {
  role: "user" | "assistant";
  content: string;
}

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return (
    result.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[Result truncated at ${MAX_TOOL_RESULT_CHARS.toLocaleString()} characters — the full response was too large to include. Summarize what you have.]`
  );
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
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: session.tools,
      messages,
    });

    // Tool call loop - Claude may call multiple tools across multiple turns
    while (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (toolUse) => {
          try {
            const raw = await callMcpTool(
              session.client,
              toolUse.name,
              toolUse.input as Record<string, unknown>
            );
            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: truncateToolResult(raw),
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
        max_tokens: 2048,
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
