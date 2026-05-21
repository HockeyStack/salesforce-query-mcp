#!/usr/bin/env node
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { SalesforceClient } from "./SalesforceClient.js";
import { registerQueryTools } from "./tools/query.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerFlowTools } from "./tools/flows.js";
import { registerFileTools } from "./tools/files.js";
import { registerOpportunityTools } from "./tools/opportunity.js";

// Auth client - shared across all sessions (stateless, safe to reuse)
const client = new SalesforceClient();

// McpServer only supports one active transport at a time, so HTTP mode creates
// a fresh instance per session. Stdio mode creates one and keeps it.
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "salesforce-query-mcp",
    version: "1.0.0",
  });
  registerQueryTools(server, client);
  registerValidationTools(server, client);
  registerFlowTools(server, client);
  registerFileTools(server, client);
  registerOpportunityTools(server, client);
  return server;
}

// Start server
// - stdio: local Cursor usage, selected when MCP_HTTP_PORT is not set (default)
// - HTTP:  remote server mode for the Slack bot, selected via MCP_HTTP_PORT env var or --http flag

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Salesforce Query MCP server running on stdio");
}

async function startHttp() {
  const app = express();
  app.use(express.json());

  const MCP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "3001", 10);
  const MCP_TOKEN = process.env.MCP_SECRET_TOKEN;

  const sessions: Record<string, StreamableHTTPServerTransport> = {};

  function checkAuth(req: express.Request, res: express.Response): boolean {
    if (MCP_TOKEN && req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http", sessions: Object.keys(sessions).length });
  });

  // MCP: all client messages (initialize creates a new session, subsequent calls reuse it)
  app.post("/mcp", async (req, res) => {
    if (!checkAuth(req, res)) return;

    const isInit = req.body?.method === "initialize";

    if (isInit) {
      const sessionId = uuidv4();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      sessions[sessionId] = transport;
      transport.onclose = () => {
        delete sessions[sessionId];
      };
      try {
        await createMcpServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("MCP init error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
      }
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string;
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({ error: "Missing or unknown session" });
      return;
    }

    try {
      await sessions[sessionId].handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  // MCP: SSE stream (for clients that open a persistent GET)
  app.get("/mcp", async (req, res) => {
    if (!checkAuth(req, res)) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({ error: "Unknown or missing session" });
      return;
    }
    await sessions[sessionId].handleRequest(req, res);
  });

  // MCP: session teardown
  app.delete("/mcp", (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].close();
      delete sessions[sessionId];
    }
    res.status(204).end();
  });

  app.listen(MCP_PORT, () => {
    console.error(`Salesforce MCP HTTP server running on port ${MCP_PORT}`);
  });
}

async function main() {
  const httpMode =
    process.env.MCP_HTTP_PORT !== undefined || process.argv.includes("--http");

  if (httpMode) {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
