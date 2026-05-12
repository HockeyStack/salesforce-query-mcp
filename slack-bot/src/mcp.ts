import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Anthropic from "@anthropic-ai/sdk";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001";
const MCP_TOKEN = process.env.MCP_SECRET_TOKEN;

export interface McpSession {
  client: Client;
  tools: Anthropic.Tool[];
  close: () => Promise<void>;
}

// Opens a fresh MCP session, fetches the tool list, and returns both.
// Each Slack message gets its own session so there's no state leakage between users.
export async function createMcpSession(): Promise<McpSession> {
  const headers: Record<string, string> = {};
  if (MCP_TOKEN) headers["Authorization"] = `Bearer ${MCP_TOKEN}`;

  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`), {
    requestInit: { headers },
  });

  const client = new Client({ name: "slack-bot", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();

  // Convert MCP tool schema to the shape Anthropic's SDK expects
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  return {
    client,
    tools: anthropicTools,
    close: () => client.close(),
  };
}

// Calls a single MCP tool and returns its text output.
export async function callMcpTool(
  client: Client,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: input });

  if (!Array.isArray(result.content)) return String(result.content);

  return result.content
    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
}
