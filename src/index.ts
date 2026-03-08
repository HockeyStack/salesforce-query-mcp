#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Config
const API_VERSION = "v62.0";

// Read env vars
const CLIENT_ID = process.env.SALESFORCE_CID;
const CLIENT_SECRET = process.env.SALESFORCE_CS;
const REFRESH_TOKEN = process.env.SALESFORCE_REFRESH_TOKEN;
const LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com";

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Error: SALESFORCE_CID, SALESFORCE_CS, and SALESFORCE_REFRESH_TOKEN environment variables are required");
  process.exit(1);
}

// Token state
let accessToken: string | null = null;
let instanceUrl: string | null = null;

async function refreshAccessToken(): Promise<void> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: REFRESH_TOKEN!,
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
  });

  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errorBody}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  instanceUrl = data.instance_url;
}

async function ensureToken(): Promise<void> {
  if (!accessToken || !instanceUrl) {
    await refreshAccessToken();
  }
}

async function sfRequest(path: string): Promise<any> {
  await ensureToken();

  const url = `${instanceUrl}/services/data/${API_VERSION}${path}`;

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // If unauthorized, refresh and retry once
  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Salesforce API error (${res.status}): ${errorBody}`);
  }

  return res.json();
}

// Create MCP server
const server = new McpServer({
  name: "salesforce-query-mcp",
  version: "1.0.0",
});

// Tool: SOQL query
server.tool(
  "sf_query",
  "Execute a SOQL query against Salesforce. Returns matching records.",
  {
    query: z.string().describe("The SOQL query to execute (e.g. SELECT Id, Name FROM Account LIMIT 10)"),
  },
  async ({ query }) => {
    try {
      const allRecords: any[] = [];
      let nextPath: string | null = `/query?q=${encodeURIComponent(query)}`;

      while (nextPath) {
        const data = await sfRequest(nextPath);
        allRecords.push(...data.records);

        if (data.done) {
          nextPath = null;
        } else {
          nextPath = data.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "");
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ totalSize: allRecords.length, records: allRecords }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: describe object
server.tool(
  "sf_describe",
  "Get metadata (fields, relationships, etc.) for a Salesforce object.",
  {
    sobject: z.string().describe("The API name of the Salesforce object (e.g. Account, Contact, Custom_Object__c)"),
  },
  async ({ sobject }) => {
    try {
      const data = await sfRequest(`/sobjects/${sobject}/describe`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Describe failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: list objects
server.tool(
  "sf_list_objects",
  "List all available Salesforce objects (sObjects) in the org.",
  {},
  async () => {
    try {
      const data = await sfRequest("/sobjects/");
      const objects = data.sobjects.map((obj: any) => ({
        name: obj.name,
        label: obj.label,
        custom: obj.custom,
        queryable: obj.queryable,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(objects, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `List objects failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

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
