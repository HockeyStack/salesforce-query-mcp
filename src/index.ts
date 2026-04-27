#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PDFParse } from "pdf-parse";

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

// HTTP Helper
// Works for both standard REST and Tooling API paths since both live under
// /services/data/{version}/. Pass paths like:
//   /query?q=...              → standard data API
//   /tooling/query?q=...      → Tooling API
//   /tooling/sobjects/Foo/id  → Tooling API record fetch
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

// Tooling API Helpers
async function sfToolingQueryPaginated(soql: string): Promise<any[]> {
  const allRecords: any[] = [];
  let nextPath: string | null = `/tooling/query?q=${encodeURIComponent(soql)}`;

  while (nextPath) {
    const data = await sfRequest(nextPath);
    if (data.records) {
      allRecords.push(...data.records);
    }
    if (data.done) {
      nextPath = null;
    } else if (data.nextRecordsUrl) {
      nextPath = data.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "");
    } else {
      nextPath = null;
    }
  }

  return allRecords;
}

async function sfToolingRecord(type: string, id: string): Promise<any> {
  return sfRequest(`/tooling/sobjects/${type}/${id}`);
}

// Returns the EntityDefinition DurableId (used as EntityDefinitionId on
// ValidationRule and other Tooling API objects).
async function resolveEntityDefinitionId(objectApiName: string): Promise<string> {
  const records = await sfToolingQueryPaginated(
    `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${objectApiName}'`
  );
  if (!records.length) {
    throw new Error(`Object "${objectApiName}" not found in EntityDefinition. Verify the API name is correct.`);
  }
  return records[0].DurableId;
}

// Returns short context snippets around each matched term for display.
function extractSnippets(text: string, terms: string[], contextChars = 120): string[] {
  const snippets: string[] = [];
  const lowerText = text.toLowerCase();

  for (const term of terms) {
    const idx = lowerText.indexOf(term.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - contextChars);
      const end = Math.min(text.length, idx + term.length + contextChars);
      snippets.push(`[...${text.slice(start, end)}...]`);
    }
  }

  return snippets;
}

// Downloads binary content (e.g. file attachments) from Salesforce and returns
// a Buffer. Used for PDF and other file content endpoints.
async function sfRequestBinary(path: string): Promise<Buffer> {
  await ensureToken();

  const url = `${instanceUrl}/services/data/${API_VERSION}${path}`;

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// All top-level node/element types present in Salesforce flow metadata JSON.
const FLOW_NODE_TYPES = [
  "decisions",
  "assignments",
  "recordUpdates",
  "recordLookups",
  "recordCreates",
  "recordDeletes",
  "subflows",
  "actionCalls",
  "apexPluginCalls",
  "loops",
  "screens",
  "waits",
  "customErrors",
  "formulas",
  "variables",
  "constants",
  "textTemplates",
] as const;

interface FlowNodeMatch {
  nodeApiName: string;
  nodeLabel: string | null;
  nodeType: string;
  matchedTerms: string[];
}

// Searches a flow's Metadata object at the node level. Returns one entry per
// node that contains at least one search term, with the node's API name, label,
// and type — so callers know exactly which node to open in Flow Builder.
function extractMatchingNodes(metadata: any, terms: string[]): FlowNodeMatch[] {
  const matches: FlowNodeMatch[] = [];

  for (const nodeType of FLOW_NODE_TYPES) {
    const nodes = metadata[nodeType];
    if (!Array.isArray(nodes)) continue;

    for (const node of nodes) {
      const nodeStr = JSON.stringify(node).toLowerCase();
      const matchedTerms = terms.filter((t) => nodeStr.includes(t.toLowerCase()));

      if (matchedTerms.length > 0) {
        matches.push({
          nodeApiName: node.name ?? node.apiName ?? "(unnamed)",
          nodeLabel: node.label ?? null,
          nodeType,
          matchedTerms,
        });
      }
    }
  }

  return matches;
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
    query: z
      .string()
      .describe("The SOQL query to execute (e.g. SELECT Id, Name FROM Account LIMIT 10)"),
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
    sobject: z
      .string()
      .describe(
        "The API name of the Salesforce object (e.g. Account, Contact, Custom_Object__c)"
      ),
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

// Tool: tooling query
server.tool(
  "sf_tooling_query",
  "Execute a SOQL query against the Salesforce Tooling API. Use for metadata objects like ValidationRule, Flow, ApexClass, CustomField, etc. that are not accessible via the standard data API.",
  {
    query: z
      .string()
      .describe(
        "SOQL query targeting Tooling API objects (e.g. SELECT Id, ValidationName, Active FROM ValidationRule LIMIT 10)"
      ),
  },
  async ({ query }) => {
    try {
      const records = await sfToolingQueryPaginated(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ totalSize: records.length, records }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Tooling query failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: get validation rules
server.tool(
  "sf_get_validation_rules",
  "Return all validation rules for a Salesforce object via the Tooling API, including active/inactive status, error messages, and the condition formula (rule logic).",
  {
    sobject: z
      .string()
      .describe("The API name of the Salesforce object (e.g. Opportunity, Account, Contact)"),
  },
  async ({ sobject }) => {
    try {
      const entityId = await resolveEntityDefinitionId(sobject);

      const rules = await sfToolingQueryPaginated(
        `SELECT Id, ValidationName, Active, ErrorDisplayField, ErrorMessage, Description FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
      );

      if (!rules.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sobject,
                totalSize: 0,
                rules: [],
                note: "No validation rules found for this object.",
              }),
            },
          ],
        };
      }

      // Fetch per-rule Metadata to get conditionFormula (not available in bulk SOQL)
      const enriched = await Promise.all(
        rules.map(async (rule) => {
          try {
            const detail = await sfToolingRecord("ValidationRule", rule.Id);
            return {
              id: rule.Id,
              name: rule.ValidationName,
              active: rule.Active,
              errorDisplayField: rule.ErrorDisplayField,
              errorMessage: rule.ErrorMessage,
              description: rule.Description ?? null,
              conditionFormula: detail.Metadata?.conditionFormula ?? null,
              metadataNote: detail.Metadata
                ? null
                : "Metadata field was null — formula unavailable",
            };
          } catch {
            return {
              id: rule.Id,
              name: rule.ValidationName,
              active: rule.Active,
              errorDisplayField: rule.ErrorDisplayField,
              errorMessage: rule.ErrorMessage,
              description: rule.Description ?? null,
              conditionFormula: null,
              metadataNote: "Failed to retrieve metadata for this rule",
            };
          }
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sobject, totalSize: enriched.length, rules: enriched }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Get validation rules failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: search validation rules
server.tool(
  "sf_search_validation_rules",
  "Search validation rules for a Salesforce object by field API name, picklist value, or any other term. Searches condition formulas, error messages, display fields, descriptions, and rule names.",
  {
    sobject: z
      .string()
      .describe("The API name of the Salesforce object (e.g. Opportunity)"),
    searchTerms: z
      .array(z.string())
      .describe(
        'Terms to search for (e.g. ["Product__c", "Marketing Intelligence"]). All text fields and the condition formula are searched.'
      ),
  },
  async ({ sobject, searchTerms }) => {
    try {
      const entityId = await resolveEntityDefinitionId(sobject);

      const rules = await sfToolingQueryPaginated(
        `SELECT Id, ValidationName, Active, ErrorDisplayField, ErrorMessage, Description FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
      );

      if (!rules.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sobject,
                searchTerms,
                matches: [],
                note: "No validation rules found for this object.",
              }),
            },
          ],
        };
      }

      const matches: any[] = [];

      for (const rule of rules) {
        let formula: string | null = null;
        let metadataNote: string | null = null;

        try {
          const detail = await sfToolingRecord("ValidationRule", rule.Id);
          formula = detail.Metadata?.conditionFormula ?? null;
          if (!formula) {
            metadataNote = "Metadata/formula was null — searched other fields only";
          }
        } catch {
          metadataNote = "Failed to retrieve metadata — searched other fields only";
        }

        const searchableText = [
          formula,
          rule.ErrorMessage,
          rule.ErrorDisplayField,
          rule.Description,
          rule.ValidationName,
        ]
          .filter(Boolean)
          .join(" ");

        const matchedTerms = searchTerms.filter((term) =>
          searchableText.toLowerCase().includes(term.toLowerCase())
        );

        if (matchedTerms.length > 0) {
          matches.push({
            id: rule.Id,
            name: rule.ValidationName,
            active: rule.Active,
            errorDisplayField: rule.ErrorDisplayField,
            errorMessage: rule.ErrorMessage,
            description: rule.Description ?? null,
            conditionFormula: formula,
            matchedTerms,
            snippets: extractSnippets(searchableText, matchedTerms),
            metadataNote,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sobject,
                searchTerms,
                totalRulesSearched: rules.length,
                totalMatches: matches.length,
                matches,
              },
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
            text: `Search validation rules failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: get flows
server.tool(
  "sf_get_flows",
  "List Salesforce flows via the Tooling API. Optionally filter by status, process type, or active-only. Returns up to 200 flows ordered by status then label.",
  {
    status: z
      .string()
      .optional()
      .describe(
        'Filter by flow Status: "Active", "Draft", "Obsolete", "InvalidDraft". Omit for all statuses.'
      ),
    processType: z
      .string()
      .optional()
      .describe(
        'Filter by ProcessType: e.g. "Flow", "AutoLaunchedFlow", "Workflow", "InvocableProcess", "CustomEvent". Omit for all types.'
      ),
    activeOnly: z
      .boolean()
      .optional()
      .describe(
        "If true, returns only Active flows. Overrides the status parameter."
      ),
  },
  async ({ status, processType, activeOnly }) => {
    try {
      const conditions: string[] = [];

      if (activeOnly) {
        conditions.push("Status = 'Active'");
      } else if (status) {
        conditions.push(`Status = '${status}'`);
      }

      if (processType) {
        conditions.push(`ProcessType = '${processType}'`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")} ` : "";

      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow ${whereClause}ORDER BY Status ASC, MasterLabel ASC LIMIT 2000`;

      const flows = await sfToolingQueryPaginated(soql);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalSize: flows.length,
                filters: {
                  status: activeOnly ? "Active" : (status ?? "any"),
                  processType: processType ?? "any",
                },
                note: "Flow records are version-level. Each active deployment is one record. Use sf_search_flows to find flows referencing specific fields or values.",
                flows: flows.map((f) => ({
                  id: f.Id,
                  label: f.MasterLabel,
                  processType: f.ProcessType,
                  status: f.Status,
                  version: f.VersionNumber,
                  description: f.Description ?? null,
                })),
              },
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
            text: `Get flows failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: search flows
server.tool(
  "sf_search_flows",
  "Search Salesforce flows for references to fields, objects, or picklist values. All flows are fetched and have their full metadata JSON searched in parallel. Defaults to active flows only.",
  {
    searchTerms: z
      .array(z.string())
      .describe(
        'Terms to search for in flow metadata (e.g. ["Product__c", "Marketing Intelligence", "Opportunity"])'
      ),
    activeOnly: z
      .boolean()
      .optional()
      .describe(
        "If true (default), search only Active flows. Set to false to include Draft/Obsolete flows."
      ),
  },
  async ({ searchTerms, activeOnly = true }) => {
    try {
      const statusFilter = activeOnly ? "WHERE Status = 'Active' " : "";
      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow ${statusFilter}ORDER BY MasterLabel ASC LIMIT 2000`;

      const flows = await sfToolingQueryPaginated(soql);

      if (!flows.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                searchTerms,
                activeOnly,
                matches: [],
                note: "No flows found matching the filter criteria.",
              }),
            },
          ],
        };
      }

      const results = await Promise.all(
        flows.map(async (flow) => {
          const surfaceText = [flow.MasterLabel, flow.Description, flow.ProcessType]
            .filter(Boolean)
            .join(" ");
          const surfaceMatches = searchTerms.filter((t) =>
            surfaceText.toLowerCase().includes(t.toLowerCase())
          );

          let matchingNodes: FlowNodeMatch[] = [];
          let metadataNote: string | null = null;

          try {
            const detail = await sfToolingRecord("Flow", flow.Id);
            if (detail.Metadata) {
              matchingNodes = extractMatchingNodes(detail.Metadata, searchTerms);
            } else {
              metadataNote = "Metadata field was null or unavailable for this flow";
            }
          } catch {
            metadataNote = "Failed to retrieve flow metadata";
          }

          const deepMatches = [...new Set(matchingNodes.flatMap((n) => n.matchedTerms))];
          return { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote };
        })
      );

      const matches: any[] = [];

      for (const { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote } of results) {
        const allMatchedTerms = [...new Set([...surfaceMatches, ...deepMatches])];
        if (allMatchedTerms.length > 0) {
          matches.push({
            id: flow.Id,
            label: flow.MasterLabel,
            processType: flow.ProcessType,
            status: flow.Status,
            version: flow.VersionNumber,
            description: flow.Description ?? null,
            matchedTerms: allMatchedTerms,
            surfaceMatch: surfaceMatches.length > 0,
            matchingNodes,
            metadataNote,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                searchTerms,
                activeOnly,
                totalFlowsChecked: flows.length,
                totalMatches: matches.length,
                matches,
              },
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
            text: `Search flows failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: impact analysis
server.tool(
  "sf_impact_analysis",
  "Analyze the potential impact of removing or changing a Salesforce field or picklist value. Searches active validation rules and flows for references to the field and optional value. Returns a structured JSON report with matches, limitations, and recommended next steps.",
  {
    objectApiName: z
      .string()
      .describe('The Salesforce object API name (e.g. "Opportunity")'),
    fieldApiName: z
      .string()
      .describe('The field API name to search for (e.g. "Product__c")'),
    value: z
      .string()
      .optional()
      .describe(
        'A specific picklist value or field value to search for (e.g. "Marketing Intelligence"). When provided, both the field name and the value are searched.'
      ),
    changeDescription: z
      .string()
      .optional()
      .describe(
        'Plain-English description of the proposed change, included in the summary for context (e.g. "Remove Marketing Intelligence as a picklist option")'
      ),
  },
  async ({ objectApiName, fieldApiName, value, changeDescription }) => {
    const searchTerms = [fieldApiName];
    if (value) searchTerms.push(value);

    const limitations: string[] = [];
    const recommendedNextSteps: string[] = [];
    const validationRuleMatches: any[] = [];
    const flowMatches: any[] = [];
    let vrError: string | null = null;
    let flowError: string | null = null;

    // Validation Rule Search
    try {
      const entityId = await resolveEntityDefinitionId(objectApiName);
      const rules = await sfToolingQueryPaginated(
        `SELECT Id, ValidationName, Active, ErrorDisplayField, ErrorMessage, Description FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
      );

      for (const rule of rules) {
        let formula: string | null = null;

        try {
          const detail = await sfToolingRecord("ValidationRule", rule.Id);
          formula = detail.Metadata?.conditionFormula ?? null;
        } catch {
          limitations.push(
            `Could not retrieve metadata for validation rule "${rule.ValidationName}" — formula not searched`
          );
        }

        const searchableText = [
          formula,
          rule.ErrorMessage,
          rule.ErrorDisplayField,
          rule.Description,
          rule.ValidationName,
        ]
          .filter(Boolean)
          .join(" ");

        const matchedTerms = searchTerms.filter((t) =>
          searchableText.toLowerCase().includes(t.toLowerCase())
        );

        if (matchedTerms.length > 0) {
          validationRuleMatches.push({
            id: rule.Id,
            name: rule.ValidationName,
            active: rule.Active,
            errorDisplayField: rule.ErrorDisplayField,
            errorMessage: rule.ErrorMessage,
            conditionFormula: formula,
            matchedTerms,
            snippets: extractSnippets(searchableText, matchedTerms),
          });
        }
      }
    } catch (err) {
      vrError = err instanceof Error ? err.message : String(err);
      limitations.push(`Validation rule search failed: ${vrError}`);
    }

    // Flow Search
    try {
      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow WHERE Status = 'Active' ORDER BY MasterLabel ASC LIMIT 2000`;
      const flows = await sfToolingQueryPaginated(soql);

      const flowResults = await Promise.all(
        flows.map(async (flow) => {
          const surfaceText = [flow.MasterLabel, flow.Description, flow.ProcessType]
            .filter(Boolean)
            .join(" ");
          const surfaceMatches = searchTerms.filter((t) =>
            surfaceText.toLowerCase().includes(t.toLowerCase())
          );

          let matchingNodes: FlowNodeMatch[] = [];
          let metadataNote: string | null = null;

          try {
            const detail = await sfToolingRecord("Flow", flow.Id);
            if (detail.Metadata) {
              matchingNodes = extractMatchingNodes(detail.Metadata, searchTerms);
            } else {
              metadataNote = "Metadata unavailable for this flow";
            }
          } catch {
            metadataNote = "Failed to retrieve flow metadata";
          }

          const deepMatches = [...new Set(matchingNodes.flatMap((n) => n.matchedTerms))];
          return { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote };
        })
      );

      for (const { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote } of flowResults) {
        const allMatchedTerms = [...new Set([...surfaceMatches, ...deepMatches])];
        if (allMatchedTerms.length > 0) {
          flowMatches.push({
            id: flow.Id,
            label: flow.MasterLabel,
            processType: flow.ProcessType,
            status: flow.Status,
            version: flow.VersionNumber,
            matchedTerms: allMatchedTerms,
            matchingNodes,
            metadataNote,
          });
        }
      }
    } catch (err) {
      flowError = err instanceof Error ? err.message : String(err);
      limitations.push(`Flow search failed: ${flowError}`);
    }

    // Static limitations always present for this MVP
    limitations.push(
      "Apex classes and triggers are not searched — use sf_tooling_query on ApexClass to check for references manually."
    );
    limitations.push(
      "Reports, dashboards, and list views are not accessible via Tooling API and must be reviewed manually in Salesforce."
    );
    limitations.push(
      "Process Builder automations use ProcessType = 'Workflow' — run sf_get_flows with processType='Workflow' to review them separately."
    );
    limitations.push(
      "Flow search is limited to 2000 active flows per query. If your org exceeds this, add processType filters to narrow the scope."
    );

    // Recommended Next Steps
    if (validationRuleMatches.some((r) => r.active)) {
      recommendedNextSteps.push(
        "Review matched active validation rules — they may block record saves if this field/value is removed or renamed."
      );
    }

    if (flowMatches.length > 0) {
      recommendedNextSteps.push(
        "Open matched flows in Flow Builder and confirm whether they branch on, filter by, or assign this field/value."
      );
    }

    recommendedNextSteps.push(
      `Run: sf_tooling_query with "SELECT Id, Name, Body FROM ApexClass" and search results for "${fieldApiName}"${value ? ` and "${value}"` : ""} to check Apex.`
    );
    recommendedNextSteps.push(
      "Run sf_describe on the object to confirm the field type and current picklist values before making changes."
    );
    recommendedNextSteps.push(
      "Check Change Data Capture or platform event subscribers if this field is used in integration triggers."
    );

    // Summary
    const intro = changeDescription
      ? `Proposed change: "${changeDescription}".`
      : `Impact analysis for ${objectApiName}.${fieldApiName}${value ? ` (value: "${value}")` : ""}.`;

    const summary = [
      intro,
      `Found ${validationRuleMatches.length} validation rule match(es) (${validationRuleMatches.filter((r) => r.active).length} active) and ${flowMatches.length} flow match(es).`,
      limitations.length > 0
        ? `${limitations.length} limitation(s) apply — results may be incomplete. See the limitations field.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              summary,
              objectApiName,
              fieldApiName,
              value: value ?? null,
              searchTerms,
              validationRuleMatches,
              flowMatches,
              limitations,
              recommendedNextSteps,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: sf_get_opportunity_files
server.tool(
  "sf_get_opportunity_files",
  "List all files and attachments linked to a Salesforce Opportunity. Returns file name, type, size, and ContentVersionId needed to download the file.",
  {
    opportunityId: z
      .string()
      .describe("The Salesforce Opportunity ID (e.g. 006aZ000001234QQAQ)"),
  },
  async ({ opportunityId }) => {
    try {
      const links = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileType, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '${opportunityId}' ORDER BY ContentDocument.CreatedDate DESC`
        )}`
      );

      if (!links.records?.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                opportunityId,
                totalFiles: 0,
                files: [],
                note: "No files found attached to this Opportunity.",
              }),
            },
          ],
        };
      }

      const files = links.records.map((r: any) => ({
        contentDocumentId: r.ContentDocumentId,
        contentVersionId: r.ContentDocument.LatestPublishedVersionId,
        title: r.ContentDocument.Title,
        fileType: r.ContentDocument.FileType,
        fileExtension: r.ContentDocument.FileExtension,
        sizeBytes: r.ContentDocument.ContentSize,
        createdDate: r.ContentDocument.CreatedDate,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                opportunityId,
                totalFiles: files.length,
                files,
                note: "Use sf_read_file_as_text with a contentVersionId to read file contents.",
              },
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
            text: `Get opportunity files failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: sf_read_file_as_text
server.tool(
  "sf_read_file_as_text",
  "Download a Salesforce file by ContentVersionId and return its text content. Supports PDF (parsed to text) and plain text files (TXT, CSV, JSON, XML). Use sf_get_opportunity_files first to get the ContentVersionId.",
  {
    contentVersionId: z
      .string()
      .describe("The ContentVersion ID of the file to read (from sf_get_opportunity_files)"),
  },
  async ({ contentVersionId }) => {
    try {
      const meta = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT Id, Title, FileType, FileExtension, ContentSize FROM ContentVersion WHERE Id = '${contentVersionId}'`
        )}`
      );

      if (!meta.records?.length) {
        return {
          content: [
            {
              type: "text",
              text: `File not found for ContentVersionId: ${contentVersionId}`,
            },
          ],
          isError: true,
        };
      }

      const fileMeta = meta.records[0];
      const fileType = (fileMeta.FileType ?? "").toUpperCase();
      const fileExtension = (fileMeta.FileExtension ?? "").toLowerCase();

      const buffer = await sfRequestBinary(
        `/sobjects/ContentVersion/${contentVersionId}/VersionData`
      );

      let text: string;
      let parseMethod: string;

      if (fileType === "PDF" || fileExtension === "pdf") {
        const parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        text = parsed.text;
        parseMethod = "pdf-parse v2";
      } else if (
        ["TXT", "CSV", "JSON", "XML", "HTML", "MD"].includes(fileType) ||
        ["txt", "csv", "json", "xml", "html", "md"].includes(fileExtension)
      ) {
        text = buffer.toString("utf-8");
        parseMethod = "utf-8 text";
      } else {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                contentVersionId,
                title: fileMeta.Title,
                fileType,
                error: `Unsupported file type "${fileType}". Only PDF and plain text formats (TXT, CSV, JSON, XML, HTML) are currently supported.`,
              }),
            },
          ],
          isError: true,
        };
      }

      const cleanedText = text.replace(/\n{3,}/g, "\n\n").trim();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                contentVersionId,
                title: fileMeta.Title,
                fileType,
                sizeBytes: fileMeta.ContentSize,
                parseMethod,
                characterCount: cleanedText.length,
                text: cleanedText,
              },
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
            text: `Read file failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: sf_get_opportunity_details
server.tool(
  "sf_get_opportunity_details",
  "Return full details for a Salesforce Opportunity including core fields (dates, stage, amount) and all line items (products, quantities, prices). Use this alongside sf_read_file_as_text to compare a Sales Order PDF against the actual Opportunity data.",
  {
    opportunityId: z
      .string()
      .describe("The Salesforce Opportunity ID (e.g. 006aZ000001234QQAQ)"),
  },
  async ({ opportunityId }) => {
    try {
      const oppData = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT Id, Name, StageName, Amount, CloseDate, Type, LeadSource, Description, OwnerId, Owner.Name, AccountId, Account.Name, CreatedDate, LastModifiedDate FROM Opportunity WHERE Id = '${opportunityId}'`
        )}`
      );

      if (!oppData.records?.length) {
        return {
          content: [
            {
              type: "text",
              text: `No Opportunity found with Id: ${opportunityId}`,
            },
          ],
          isError: true,
        };
      }

      const opp = oppData.records[0];

      const lineItemData = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT Id, Name, Product2Id, Product2.Name, ProductCode, Quantity, UnitPrice, TotalPrice, Discount, ServiceDate, Description FROM OpportunityLineItem WHERE OpportunityId = '${opportunityId}' ORDER BY CreatedDate ASC`
        )}`
      );

      const lineItems = (lineItemData.records ?? []).map((li: any) => ({
        id: li.Id,
        name: li.Name,
        productName: li.Product2?.Name ?? null,
        productCode: li.ProductCode ?? null,
        quantity: li.Quantity,
        unitPrice: li.UnitPrice,
        totalPrice: li.TotalPrice,
        discount: li.Discount ?? null,
        serviceDate: li.ServiceDate ?? null,
        description: li.Description ?? null,
      }));

      // Try common contract/opt-out custom fields — fails gracefully if they don't exist
      let contractFields: Record<string, any> = {};
      try {
        const contractData = await sfRequest(
          `/query?q=${encodeURIComponent(
            `SELECT Contract_Start_Date__c, Contract_End_Date__c, Opt_Out_Period__c, Opt_Out_Date__c FROM Opportunity WHERE Id = '${opportunityId}'`
          )}`
        );
        if (contractData.records?.length) {
          const r = contractData.records[0];
          contractFields = {
            contractStartDate: r.Contract_Start_Date__c ?? null,
            contractEndDate: r.Contract_End_Date__c ?? null,
            optOutPeriod: r.Opt_Out_Period__c ?? null,
            optOutDate: r.Opt_Out_Date__c ?? null,
          };
        }
      } catch {
        contractFields = {
          contractFieldsNote:
            "Common contract/opt-out custom fields not found in this org. Run sf_describe on Opportunity to find your org-specific field names, then use sf_query to fetch them.",
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                opportunity: {
                  id: opp.Id,
                  name: opp.Name,
                  stage: opp.StageName,
                  amount: opp.Amount,
                  closeDate: opp.CloseDate,
                  type: opp.Type ?? null,
                  owner: opp.Owner?.Name ?? null,
                  account: opp.Account?.Name ?? null,
                  createdDate: opp.CreatedDate,
                  lastModifiedDate: opp.LastModifiedDate,
                  description: opp.Description ?? null,
                  ...contractFields,
                },
                lineItems: {
                  totalCount: lineItems.length,
                  items: lineItems,
                },
              },
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
            text: `Get opportunity details failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: sf_scan_opportunity_pdfs
server.tool(
  "sf_scan_opportunity_pdfs",
  "Scan PDF attachments across multiple Opportunities to find specific terms (e.g. 'opt-out', 'termination') or check for product mismatches against Opportunity Line Items. Returns a summary per opportunity. Use a SOQL WHERE clause to filter opportunities (e.g. \"StageName = 'Closed Won' AND CloseDate = THIS_YEAR\").",
  {
    opportunityFilter: z
      .string()
      .describe(
        "SOQL WHERE clause to filter Opportunities, e.g. \"StageName = 'Closed Won' AND CloseDate = THIS_YEAR\""
      ),
    searchTerms: z
      .array(z.string())
      .optional()
      .describe(
        "Terms to search for in each PDF, e.g. ['opt-out', 'termination', 'cancellation']. If omitted, only metadata and product mismatches are returned."
      ),
    checkProductMatch: z
      .boolean()
      .optional()
      .describe(
        "If true, compare products found in the PDF text against the Opportunity Line Items and flag mismatches. Defaults to false."
      ),
    maxOpportunities: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max number of Opportunities to scan. Defaults to 20, max 50."),
  },
  async ({ opportunityFilter, searchTerms = [], checkProductMatch = false, maxOpportunities = 20 }) => {
    try {
      // 1. Fetch matching opportunities
      const oppData = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE ${opportunityFilter} ORDER BY CloseDate DESC LIMIT ${maxOpportunities}`
        )}`
      );

      const opps: any[] = oppData.records ?? [];
      if (opps.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ message: "No opportunities matched the filter.", results: [] }, null, 2) }],
        };
      }

      const oppIds = opps.map((o: any) => `'${o.Id}'`).join(", ");

      // 2. Fetch all ContentDocumentLinks for these opportunities in one query
      const linkData = await sfRequest(
        `/query?q=${encodeURIComponent(
          `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${oppIds})`
        )}`
      );
      const links: any[] = linkData.records ?? [];

      // Build map: opportunityId → [ContentDocumentId]
      const oppToDocIds: Record<string, string[]> = {};
      for (const link of links) {
        if (!oppToDocIds[link.LinkedEntityId]) oppToDocIds[link.LinkedEntityId] = [];
        oppToDocIds[link.LinkedEntityId].push(link.ContentDocumentId);
      }

      const allDocIds = links.map((l: any) => `'${l.ContentDocumentId}'`).join(", ");

      // 3. Fetch ContentVersion metadata for all PDFs in one query
      let versionMap: Record<string, any[]> = {};
      if (allDocIds.length > 0) {
        const versionData = await sfRequest(
          `/query?q=${encodeURIComponent(
            `SELECT Id, Title, FileType, ContentDocumentId, ContentSize FROM ContentVersion WHERE ContentDocumentId IN (${allDocIds}) AND FileType = 'PDF' AND IsLatest = true`
          )}`
        );
        for (const v of versionData.records ?? []) {
          if (!versionMap[v.ContentDocumentId]) versionMap[v.ContentDocumentId] = [];
          versionMap[v.ContentDocumentId].push(v);
        }
      }

      // 4. Fetch line items for all opportunities in one query (for product mismatch check)
      let lineItemsByOpp: Record<string, string[]> = {};
      if (checkProductMatch) {
        const liData = await sfRequest(
          `/query?q=${encodeURIComponent(
            `SELECT OpportunityId, Product2.Name FROM OpportunityLineItem WHERE OpportunityId IN (${oppIds})`
          )}`
        );
        for (const li of liData.records ?? []) {
          if (!lineItemsByOpp[li.OpportunityId]) lineItemsByOpp[li.OpportunityId] = [];
          if (li.Product2?.Name) lineItemsByOpp[li.OpportunityId].push(li.Product2.Name);
        }
      }

      // 5. For each opportunity, download and parse its PDFs in parallel
      const results = await Promise.all(
        opps.map(async (opp: any) => {
          const docIds = oppToDocIds[opp.Id] ?? [];
          const pdfVersions = docIds.flatMap((docId) => versionMap[docId] ?? []);

          if (pdfVersions.length === 0) {
            return {
              opportunityId: opp.Id,
              opportunityName: opp.Name,
              account: opp.Account?.Name ?? null,
              closeDate: opp.CloseDate,
              amount: opp.Amount,
              pdfsFound: 0,
              pdfs: [],
            };
          }

          const pdfResults = await Promise.all(
            pdfVersions.map(async (version: any) => {
              try {
                const buffer = await sfRequestBinary(`/sobjects/ContentVersion/${version.Id}/VersionData`);
                const parser = new PDFParse({ data: buffer });
                const parsed = await parser.getText();
                const text = parsed.text.replace(/\n{3,}/g, "\n\n").trim();

                // Search for terms
                const termMatches: Record<string, boolean> = {};
                for (const term of searchTerms) {
                  termMatches[term] = text.toLowerCase().includes(term.toLowerCase());
                }

                // Product mismatch check
                let productMismatch: { lineItemProducts: string[]; missingFromPdf: string[]; note: string } | null = null;
                if (checkProductMatch) {
                  const lineItemProducts = lineItemsByOpp[opp.Id] ?? [];
                  const missingFromPdf = lineItemProducts.filter(
                    (p) => !text.toLowerCase().includes(p.toLowerCase())
                  );
                  productMismatch = {
                    lineItemProducts,
                    missingFromPdf,
                    note: missingFromPdf.length > 0
                      ? `${missingFromPdf.length} product(s) on the opportunity not found in PDF text`
                      : "All opportunity products appear in PDF",
                  };
                }

                return {
                  contentVersionId: version.Id,
                  title: version.Title,
                  sizeBytes: version.ContentSize,
                  termMatches: searchTerms.length > 0 ? termMatches : undefined,
                  anyTermMatched: searchTerms.length > 0 ? Object.values(termMatches).some(Boolean) : undefined,
                  productMismatch: checkProductMatch ? productMismatch : undefined,
                  parseError: null,
                };
              } catch (err) {
                return {
                  contentVersionId: version.Id,
                  title: version.Title,
                  sizeBytes: version.ContentSize,
                  termMatches: null,
                  anyTermMatched: null,
                  productMismatch: null,
                  parseError: err instanceof Error ? err.message : String(err),
                };
              }
            })
          );

          const anyMatch = pdfResults.some((p) => p.anyTermMatched);
          const hasProductMismatch = pdfResults.some(
            (p) => p.productMismatch && p.productMismatch.missingFromPdf.length > 0
          );

          return {
            opportunityId: opp.Id,
            opportunityName: opp.Name,
            account: opp.Account?.Name ?? null,
            closeDate: opp.CloseDate,
            amount: opp.Amount,
            pdfsFound: pdfVersions.length,
            anyTermMatched: searchTerms.length > 0 ? anyMatch : undefined,
            hasProductMismatch: checkProductMatch ? hasProductMismatch : undefined,
            pdfs: pdfResults,
          };
        })
      );

      const summary = {
        opportunitiesScanned: opps.length,
        opportunitiesWithPdfs: results.filter((r) => r.pdfsFound > 0).length,
        ...(searchTerms.length > 0 && {
          opportunitiesWithTermMatches: results.filter((r) => r.anyTermMatched).length,
          searchTerms,
        }),
        ...(checkProductMatch && {
          opportunitiesWithProductMismatches: results.filter((r) => r.hasProductMismatch).length,
        }),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ summary, results }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
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
