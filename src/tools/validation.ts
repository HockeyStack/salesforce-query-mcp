import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";
import {
  extractSnippets,
  searchValidationRules,
  VALIDATION_RULE_SOQL_FIELDS,
} from "../utils.js";

// Tools: sf_get_validation_rules, sf_search_validation_rules
export function registerValidationTools(
  server: McpServer,
  client: SalesforceClient
): void {
  server.tool(
    "sf_get_validation_rules",
    "Return all validation rules for a Salesforce object via the Tooling API, including active/inactive status, error messages, and the condition formula (rule logic).",
    {
      sobject: z
        .string()
        .describe(
          "The API name of the Salesforce object (e.g. Opportunity, Account, Contact)"
        ),
    },
    async ({ sobject }) => {
      try {
        const entityId = await client.resolveEntityDefinitionId(sobject);

        const rules = await client.toolingQueryPaginated(
          `SELECT ${VALIDATION_RULE_SOQL_FIELDS} FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
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
              const detail = await client.toolingRecord(
                "ValidationRule",
                rule.Id
              );
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
              text: JSON.stringify(
                { sobject, totalSize: enriched.length, rules: enriched },
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
              text: `Get validation rules failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

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
        const entityId = await client.resolveEntityDefinitionId(sobject);
        const { matches } = await searchValidationRules(
          client,
          entityId,
          searchTerms
        );

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sobject,
                  searchTerms,
                  totalRulesSearched: 0,
                  totalMatches: 0,
                  matches: [],
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sobject,
                  searchTerms,
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
}
