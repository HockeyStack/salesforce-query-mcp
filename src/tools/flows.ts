import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";
import {
  runWithConcurrency,
  extractSnippets,
  extractMatchingNodes,
  FlowNodeMatch,
} from "../utils.js";

// Tools: sf_get_flows, sf_search_flows, sf_impact_analysis
export function registerFlowTools(
  server: McpServer,
  client: SalesforceClient
): void {
  server.tool(
    "sf_get_flows",
    "List Salesforce flows via the Tooling API. Optionally filter by status, process type, or active-only. Returns up to 200 flows ordered by status then label.",
    {
      status: z
        .enum(["Active", "Draft", "Obsolete", "InvalidDraft"])
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

        const FLOW_STATUS_MAP = {
          Active: "Active",
          Draft: "Draft",
          Obsolete: "Obsolete",
          InvalidDraft: "InvalidDraft",
        } as const;

        if (activeOnly) {
          conditions.push("Status = 'Active'");
        } else if (status) {
          conditions.push(`Status = '${FLOW_STATUS_MAP[status]}'`);
        }

        if (processType) {
          conditions.push(`ProcessType = '${processType}'`);
        }

        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")} ` : "";

        const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow ${whereClause}ORDER BY Status ASC, MasterLabel ASC LIMIT 2000`;

        const flows = await client.toolingQueryPaginated(soql);

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

        const flows = await client.toolingQueryPaginated(soql);

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

        const results = await runWithConcurrency(
          flows.map((flow) => async () => {
            const surfaceText = [
              flow.MasterLabel,
              flow.Description,
              flow.ProcessType,
            ]
              .filter(Boolean)
              .join(" ");
            const surfaceMatches = searchTerms.filter((t) =>
              surfaceText.toLowerCase().includes(t.toLowerCase())
            );

            let matchingNodes: FlowNodeMatch[] = [];
            let metadataNote: string | null = null;

            try {
              const detail = await client.toolingRecord("Flow", flow.Id);
              if (detail.Metadata) {
                matchingNodes = extractMatchingNodes(
                  detail.Metadata,
                  searchTerms
                );
              } else {
                metadataNote =
                  "Metadata field was null or unavailable for this flow";
              }
            } catch {
              metadataNote = "Failed to retrieve flow metadata";
            }

            const deepMatches = [
              ...new Set(matchingNodes.flatMap((n) => n.matchedTerms)),
            ];
            return { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote };
          }),
          10
        );

        const matches: any[] = [];

        for (const {
          flow,
          surfaceMatches,
          deepMatches,
          matchingNodes,
          metadataNote,
        } of results) {
          const allMatchedTerms = [
            ...new Set([...surfaceMatches, ...deepMatches]),
          ];
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

      // Validation Rule Search
      try {
        const entityId =
          await client.resolveEntityDefinitionId(objectApiName);
        const rules = await client.toolingQueryPaginated(
          `SELECT Id, ValidationName, Active, ErrorDisplayField, ErrorMessage, Description FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
        );

        for (const rule of rules) {
          let formula: string | null = null;

          try {
            const detail = await client.toolingRecord(
              "ValidationRule",
              rule.Id
            );
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
        const msg = err instanceof Error ? err.message : String(err);
        limitations.push(`Validation rule search failed: ${msg}`);
      }

      // Flow Search
      try {
        const soql = `SELECT Id, MasterLabel, Status, ProcessType, VersionNumber, Description FROM Flow WHERE Status = 'Active' ORDER BY MasterLabel ASC LIMIT 2000`;
        const flows = await client.toolingQueryPaginated(soql);

        const flowResults = await runWithConcurrency(
          flows.map((flow) => async () => {
            const surfaceText = [
              flow.MasterLabel,
              flow.Description,
              flow.ProcessType,
            ]
              .filter(Boolean)
              .join(" ");
            const surfaceMatches = searchTerms.filter((t) =>
              surfaceText.toLowerCase().includes(t.toLowerCase())
            );

            let matchingNodes: FlowNodeMatch[] = [];
            let metadataNote: string | null = null;

            try {
              const detail = await client.toolingRecord("Flow", flow.Id);
              if (detail.Metadata) {
                matchingNodes = extractMatchingNodes(
                  detail.Metadata,
                  searchTerms
                );
              } else {
                metadataNote = "Metadata unavailable for this flow";
              }
            } catch {
              metadataNote = "Failed to retrieve flow metadata";
            }

            const deepMatches = [
              ...new Set(matchingNodes.flatMap((n) => n.matchedTerms)),
            ];
            return { flow, surfaceMatches, deepMatches, matchingNodes, metadataNote };
          }),
          10
        );

        for (const {
          flow,
          surfaceMatches,
          deepMatches,
          matchingNodes,
          metadataNote,
        } of flowResults) {
          const allMatchedTerms = [
            ...new Set([...surfaceMatches, ...deepMatches]),
          ];
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
        const msg = err instanceof Error ? err.message : String(err);
        limitations.push(`Flow search failed: ${msg}`);
      }

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

      if (value) {
        recommendedNextSteps.push(
          `Run sf_get_record_type_picklists on ${objectApiName}, field ${fieldApiName}, filterValue "${value}" to see which record types have this value active — removing it will affect those record types.`
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
}
