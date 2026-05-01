#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SalesforceClient } from "./SalesforceClient.js";
import { registerQueryTools } from "./tools/query.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerFlowTools } from "./tools/flows.js";
import { registerFileTools } from "./tools/files.js";
import { registerOpportunityTools } from "./tools/opportunity.js";
import { registerMetadataTools } from "./tools/metadata.js";

// Auth client
const client = new SalesforceClient();

// Create MCP server
const server = new McpServer({
  name: "salesforce-query-mcp",
  version: "1.0.0",
});

// Register tools
registerQueryTools(server, client);
registerValidationTools(server, client);
registerFlowTools(server, client);
registerFileTools(server, client);
registerOpportunityTools(server, client);
registerMetadataTools(server, client);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Salesforce Query MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
