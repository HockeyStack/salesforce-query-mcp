#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import open from "open";

// Config
const API_VERSION = "v62.0";
const CALLBACK_PORT = 54321;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth/callback`;
const TOKEN_DIR = join(homedir(), ".salesforce-query-mcp");
const TOKEN_FILE = join(TOKEN_DIR, "tokens.json");

interface TokenData {
  access_token: string;
  refresh_token: string;
  instance_url: string;
  issued_at: string;
}

// Read env vars
const CLIENT_ID = process.env.SALESFORCE_CID;
const CLIENT_SECRET = process.env.SALESFORCE_CS;
const LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: SALESFORCE_CID and SALESFORCE_CS environment variables are required");
  process.exit(1);
}

// Token management
async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: TokenData): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
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
  const updated: TokenData = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token, // refresh token doesn't change
    instance_url: data.instance_url,
    issued_at: data.issued_at,
  };
  await saveTokens(updated);
  return updated;
}

function startOAuthFlow(): Promise<TokenData> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname === "/oauth/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authentication Failed</h1><p>${error}</p><p>You can close this window.</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>No authorization code received</h1><p>You can close this window.</p>");
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        try {
          const params = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID!,
            client_secret: CLIENT_SECRET!,
            redirect_uri: REDIRECT_URI,
          });

          const tokenRes = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });

          if (!tokenRes.ok) {
            const errorBody = await tokenRes.text();
            throw new Error(`Token exchange failed (${tokenRes.status}): ${errorBody}`);
          }

          const tokenData = await tokenRes.json();
          const tokens: TokenData = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            instance_url: tokenData.instance_url,
            issued_at: tokenData.issued_at,
          };

          await saveTokens(tokens);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authentication Successful!</h1><p>You can close this window and return to your terminal.</p>");
          server.close();
          resolve(tokens);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
          server.close();
          reject(err);
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(CALLBACK_PORT, () => {
      const authUrl = new URL(`${LOGIN_URL}/services/oauth2/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CLIENT_ID!);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("scope", "full refresh_token");

      console.error(`\nOpening browser for Salesforce authentication...`);
      console.error(`If the browser doesn't open, visit: ${authUrl.toString()}\n`);
      open(authUrl.toString()).catch(() => {
        // If open fails, user can still use the URL from stderr
      });
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

async function getTokens(): Promise<TokenData> {
  let tokens = await loadTokens();
  if (tokens) {
    return tokens;
  }
  return startOAuthFlow();
}

async function sfRequest(path: string, tokens: TokenData): Promise<{ data: any; tokens: TokenData }> {
  const url = `${tokens.instance_url}/services/data/${API_VERSION}${path}`;

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  // If unauthorized, try refreshing the token
  if (res.status === 401) {
    tokens = await refreshAccessToken(tokens);
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
  }

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Salesforce API error (${res.status}): ${errorBody}`);
  }

  return { data: await res.json(), tokens };
}

// Create MCP server
const server = new McpServer({
  name: "salesforce-query-mcp",
  version: "1.0.0",
});

// Tool: authenticate
server.tool(
  "sf_authenticate",
  "Authenticate with Salesforce via OAuth. Run this first if you get authentication errors.",
  {},
  async () => {
    try {
      const tokens = await startOAuthFlow();
      return {
        content: [
          {
            type: "text",
            text: `Successfully authenticated with Salesforce.\nInstance: ${tokens.instance_url}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: SOQL query
server.tool(
  "sf_query",
  "Execute a SOQL query against Salesforce. Returns matching records.",
  {
    query: z.string().describe("The SOQL query to execute (e.g. SELECT Id, Name FROM Account LIMIT 10)"),
  },
  async ({ query }) => {
    try {
      let tokens = await getTokens();
      const allRecords: any[] = [];
      let nextPath: string | null = `/query?q=${encodeURIComponent(query)}`;

      while (nextPath) {
        const result = await sfRequest(nextPath, tokens);
        tokens = result.tokens;
        allRecords.push(...result.data.records);

        if (result.data.done) {
          nextPath = null;
        } else {
          // nextRecordsUrl is an absolute path like /services/data/v62.0/query/...
          nextPath = result.data.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "");
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { totalSize: allRecords.length, records: allRecords },
              null,
              2
            ),
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
      let tokens = await getTokens();
      const result = await sfRequest(`/sobjects/${sobject}/describe`, tokens);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.data, null, 2),
          },
        ],
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
      let tokens = await getTokens();
      const result = await sfRequest("/sobjects/", tokens);

      const objects = result.data.sobjects.map((obj: any) => ({
        name: obj.name,
        label: obj.label,
        custom: obj.custom,
        queryable: obj.queryable,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(objects, null, 2),
          },
        ],
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
