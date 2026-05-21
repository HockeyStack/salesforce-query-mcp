import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";
import { getPicklistValuesByRecordType } from "../metadata/retrieve.js";

// Tools: sf_get_record_type_picklists
export function registerMetadataTools(
  server: McpServer,
  client: SalesforceClient
): void {
  server.tool(
    "sf_get_record_type_picklists",
    "Return the active picklist values for a field on each record type of a Salesforce object. Use this to check which record types have a specific picklist value enabled — critical before removing or renaming a picklist option. Works for all picklist fields on any object.",
    {
      objectApiName: z
        .string()
        .describe('The Salesforce object API name (e.g. "Opportunity", "Lead")'),
      fieldApiName: z
        .string()
        .describe(
          'The picklist field API name (e.g. "Product__c", "StageName", "LeadSource")'
        ),
      filterValue: z
        .string()
        .optional()
        .describe(
          'If provided, flags which record types have this specific value active (e.g. "Marketing Intelligence"). Useful for targeted removal checks.'
        ),
    },
    async ({ objectApiName, fieldApiName, filterValue }) => {
      try {
        const results = await getPicklistValuesByRecordType(
          client,
          objectApiName,
          fieldApiName
        );

        const enriched = results.map((rt) => {
          const base = {
            recordTypeId: rt.recordTypeId,
            recordTypeName: rt.recordTypeName,
            recordTypeDeveloperName: rt.recordTypeDeveloperName,
            isMaster: rt.isMaster,
            isActive: rt.isActive,
            valueCount: rt.values.length,
            values: rt.values.map((v) => v.label),
            error: rt.error,
          };

          if (filterValue) {
            const hasValue = rt.values.some(
              (v) =>
                v.label.toLowerCase() === filterValue.toLowerCase() ||
                v.value.toLowerCase() === filterValue.toLowerCase()
            );
            return { ...base, hasFilterValue: hasValue };
          }

          return base;
        });

        // Summary when filtering for a specific value
        let filterSummary: any = null;
        if (filterValue) {
          const withValue = enriched.filter((r) => (r as any).hasFilterValue);
          const withoutValue = enriched.filter(
            (r) => !(r as any).hasFilterValue && !r.error
          );
          filterSummary = {
            filterValue,
            recordTypesWithValue: withValue.map((r) => r.recordTypeName),
            recordTypesWithoutValue: withoutValue.map((r) => r.recordTypeName),
            note:
              withValue.length > 0
                ? `"${filterValue}" is active on ${withValue.length} record type(s). Removing it will affect those record types.`
                : `"${filterValue}" is not active on any record type. Safe to remove from this perspective.`,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  objectApiName,
                  fieldApiName,
                  totalRecordTypes: results.length,
                  ...(filterSummary && { filterSummary }),
                  recordTypes: enriched,
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
              text: `Get record type picklists failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
