import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";

const CONTRACT_FIELDS: Array<{ field: string; key: string }> = [
  { field: "Contract_Start_Date__c", key: "contractStartDate" },
  { field: "Contract_End_Date__c", key: "contractEndDate" },
  { field: "Opt_Out_Period__c", key: "optOutPeriod" },
  { field: "Opt_Out_Date__c", key: "optOutDate" },
];

// Tools: sf_get_opportunity_details
export function registerOpportunityTools(
  server: McpServer,
  client: SalesforceClient
): void {
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
        const oppData = await client.request(
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

        const lineItemData = await client.request(
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

        // Try common contract/opt-out custom fields one at a time so a missing
        // field doesn't fail the entire query.
        const contractFields: Record<string, any> = {};
        for (const { field, key } of CONTRACT_FIELDS) {
          try {
            const r = await client.request(
              `/query?q=${encodeURIComponent(
                `SELECT ${field} FROM Opportunity WHERE Id = '${opportunityId}'`
              )}`
            );
            contractFields[key] = r.records?.[0]?.[field] ?? null;
          } catch {
            // Field doesn't exist in this org — skip silently
          }
        }
        if (Object.keys(contractFields).length === 0) {
          contractFields.contractFieldsNote =
            "No common contract/opt-out custom fields found in this org. Run sf_describe on Opportunity to find org-specific field names.";
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
}
