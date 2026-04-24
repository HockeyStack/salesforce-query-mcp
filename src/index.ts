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

      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow ${whereClause}ORDER BY Status ASC, MasterLabel ASC LIMIT 200`;

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
const FLOW_METADATA_FETCH_LIMIT = 20;

server.tool(
  "sf_search_flows",
  `Search Salesforce flows for references to fields, objects, or picklist values. All flows are checked by label/description (surface search). The first ${FLOW_METADATA_FETCH_LIMIT} flows also have their full metadata JSON searched (deep search). Defaults to active flows only.`,
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
      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow ${statusFilter}ORDER BY MasterLabel ASC LIMIT 200`;

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

      const matches: any[] = [];
      const limitations: string[] = [];
      let metadataFetched = 0;

      for (const flow of flows) {
        const surfaceText = [flow.MasterLabel, flow.Description, flow.ProcessType]
          .filter(Boolean)
          .join(" ");
        const surfaceMatches = searchTerms.filter((t) =>
          surfaceText.toLowerCase().includes(t.toLowerCase())
        );

        let deepMatches: string[] = [];
        let deepSnippets: string[] = [];
        let metadataSearched = false;
        let metadataNote: string | null = null;

        if (metadataFetched < FLOW_METADATA_FETCH_LIMIT) {
          try {
            const detail = await sfToolingRecord("Flow", flow.Id);
            metadataFetched++;
            metadataSearched = true;

            if (detail.Metadata) {
              const metaStr = JSON.stringify(detail.Metadata);
              deepMatches = searchTerms.filter((t) =>
                metaStr.toLowerCase().includes(t.toLowerCase())
              );
              deepSnippets = extractSnippets(metaStr, deepMatches, 150);
            } else {
              metadataNote = "Metadata field was null or unavailable for this flow";
            }
          } catch {
            metadataNote = "Failed to retrieve flow metadata";
          }
        } else {
          metadataNote = `Metadata depth search skipped (limit of ${FLOW_METADATA_FETCH_LIMIT} reached) — surface fields only`;
        }

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
            metadataMatch: deepMatches.length > 0,
            metadataSearched,
            snippets: deepSnippets,
            metadataNote,
          });
        }
      }

      if (flows.length > FLOW_METADATA_FETCH_LIMIT) {
        limitations.push(
          `Deep metadata search was limited to the first ${FLOW_METADATA_FETCH_LIMIT} flows. ${flows.length - metadataFetched} additional flow(s) were checked by label/description only. Use sf_tooling_query to manually inspect specific flows.`
        );
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
                metadataFetched,
                totalMatches: matches.length,
                limitations,
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
      const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow WHERE Status = 'Active' ORDER BY MasterLabel ASC LIMIT 200`;
      const flows = await sfToolingQueryPaginated(soql);
      let metadataFetched = 0;

      for (const flow of flows) {
        const surfaceText = [flow.MasterLabel, flow.Description, flow.ProcessType]
          .filter(Boolean)
          .join(" ");
        const surfaceMatches = searchTerms.filter((t) =>
          surfaceText.toLowerCase().includes(t.toLowerCase())
        );

        let deepMatches: string[] = [];
        let deepSnippets: string[] = [];
        let metadataNote: string | null = null;

        if (metadataFetched < FLOW_METADATA_FETCH_LIMIT) {
          try {
            const detail = await sfToolingRecord("Flow", flow.Id);
            metadataFetched++;
            if (detail.Metadata) {
              const metaStr = JSON.stringify(detail.Metadata);
              deepMatches = searchTerms.filter((t) =>
                metaStr.toLowerCase().includes(t.toLowerCase())
              );
              deepSnippets = extractSnippets(metaStr, deepMatches, 150);
            } else {
              metadataNote = "Metadata unavailable for this flow";
            }
          } catch {
            metadataNote = "Failed to retrieve flow metadata";
          }
        } else {
          metadataNote = `Metadata depth search skipped (limit of ${FLOW_METADATA_FETCH_LIMIT} reached)`;
        }

        const allMatchedTerms = [...new Set([...surfaceMatches, ...deepMatches])];

        if (allMatchedTerms.length > 0) {
          flowMatches.push({
            id: flow.Id,
            label: flow.MasterLabel,
            processType: flow.ProcessType,
            status: flow.Status,
            version: flow.VersionNumber,
            matchedTerms: allMatchedTerms,
            snippets: deepSnippets,
            metadataNote,
          });
        }
      }

      if (flows.length > FLOW_METADATA_FETCH_LIMIT) {
        limitations.push(
          `Flow metadata deep search was limited to ${FLOW_METADATA_FETCH_LIMIT} flows. ${flows.length} active flow(s) exist — remaining flows were checked by label/description only. Run sf_search_flows for a targeted re-search.`
        );
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
