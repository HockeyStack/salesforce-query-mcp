import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PDFParse } from "pdf-parse";
import { SalesforceClient } from "../SalesforceClient.js";
import { runWithConcurrency } from "../utils.js";

const CONTRACT_FIELDS: Array<{ field: string; key: string }> = [
  { field: "Contract_Start_Date__c", key: "contractStartDate" },
  { field: "Contract_End_Date__c", key: "contractEndDate" },
  { field: "Opt_Out_Period__c", key: "optOutPeriod" },
  { field: "Opt_Out_Date__c", key: "optOutDate" },
];

const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Scans PDF text for common effective date patterns and returns a YYYY-MM-DD string.
 * Handles formats: MM/DD/YYYY, MM-DD-YYYY, and written month names near "effective date".
 */
function extractEffectiveDate(pdfText: string): string | null {
  const numericDate = String.raw`(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})`;
  const writtenDate = String.raw`([A-Za-z]+ \d{1,2},? \d{4})`;
  const dateGroup = `(?:${numericDate}|${writtenDate})`;

  const patterns = [
    new RegExp(`effective\\s+date\\s+is\\s+${dateGroup}`, "i"),
    new RegExp(`effective\\s+date\\s*:\\s*${dateGroup}`, "i"),
    new RegExp(`effective\\s+date\\s+of\\s+${dateGroup}`, "i"),
    new RegExp(`effective\\s+as\\s+of\\s+${dateGroup}`, "i"),
    new RegExp(`effective\\s*:\\s*${dateGroup}`, "i"),
  ];

  for (const pattern of patterns) {
    const match = pdfText.match(pattern);
    const rawDate = match?.[1] ?? match?.[2]; // group 1 = numeric, group 2 = written
    if (!rawDate) continue;

    // Parse MM/DD/YYYY or MM-DD-YYYY explicitly to avoid timezone ambiguity
    const numeric = rawDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (numeric) {
      const [, m, d, y] = numeric.map(Number);
      const date = new Date(y, m - 1, d);
      if (!isNaN(date.getTime())) return formatYMD(date);
    }

    // Fallback for written months ("July 15, 2025")
    const parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) return formatYMD(parsed);
  }

  return null;
}

function formatYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Checks whether the contract start date aligns with the PDF effective date.
 * Alignment = same month/day, any number of years later.
 */
function checkDateAlignment(
  pdfDateStr: string,
  contractDateStr: string
): { status: "correct" | "wrong"; expectedStartDate: string; statusDetail: string } {
  // Salesforce dates come as YYYY-MM-DD — parse without timezone shift
  const [py, pm, pd] = pdfDateStr.split("-").map(Number);
  const [cy, cm, cd] = contractDateStr.split("-").map(Number);

  const pdfDate = new Date(py, pm - 1, pd);
  const contractDate = new Date(cy, cm - 1, cd);

  // Expected = same month/day as PDF, in the contract's year
  const expected = new Date(cy, pm - 1, pd);
  const expectedStr = formatYMD(expected);

  if (expected.getTime() === contractDate.getTime()) {
    const yearDiff = cy - py;
    return {
      status: "correct",
      expectedStartDate: expectedStr,
      statusDetail: `+${yearDiff} year(s) as expected`,
    };
  }

  const msPerDay = 86_400_000;
  const daysDiff = Math.round((contractDate.getTime() - expected.getTime()) / msPerDay);
  return {
    status: "wrong",
    expectedStartDate: expectedStr,
    statusDetail: `Expected ${expectedStr} but got ${contractDateStr} (off by ${daysDiff > 0 ? "+" : ""}${daysDiff} day(s))`,
  };
}

// Tools: sf_get_opportunity_details, sf_audit_multi_year_splits
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

  server.tool(
    "sf_audit_multi_year_splits",
    "Audit all Multi-Year Split opportunities by comparing their Contract Start Date against the effective date found in the Previous Opportunity's sales order PDF. Runs the entire analysis server-side in one call — do NOT use sf_get_opportunity_files or sf_read_file_as_text to do this manually, as that causes token limit errors. Returns a compact summary of correct dates, mismatches, and opps where no PDF was found.",
    {
      opportunityTypeField: z
        .string()
        .optional()
        .describe('API name of the opportunity type field. Defaults to "Opportunity_Type__c"'),
      opportunityTypeValue: z
        .string()
        .optional()
        .describe('Picklist value to filter on. Defaults to "Multi-Year Split"'),
      previousOppField: z
        .string()
        .optional()
        .describe('API name of the lookup field pointing to the previous/parent opportunity. Defaults to "Previous_Opportunity__c"'),
      contractStartDateField: z
        .string()
        .optional()
        .describe('API name of the date field to compare against the PDF effective date. Defaults to "Contract_Start_Date__c"'),
      maxOpportunities: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max split opps to audit. Defaults to 100"),
    },
    async ({
      opportunityTypeField,
      opportunityTypeValue,
      previousOppField,
      contractStartDateField,
      maxOpportunities,
    }) => {
      const typeField = opportunityTypeField ?? "Opportunity_Type__c";
      const typeValue = opportunityTypeValue ?? "Multi-Year Split";
      const prevField = previousOppField ?? "Previous_Opportunity__c";
      const startDateField = contractStartDateField ?? "Contract_Start_Date__c";
      const maxOpps = maxOpportunities ?? 100;
      // Relationship traversal field: Previous_Opportunity__c → Previous_Opportunity__r
      const relField = prevField.replace(/__c$/, "__r");

      try {
        // 1. Query all split opps that have a Previous Opportunity set
        const oppData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT Id, Name, Account.Name, ${prevField}, ${relField}.Name, ${startDateField} FROM Opportunity WHERE ${typeField} = '${typeValue}' AND ${prevField} != null ORDER BY Account.Name ASC LIMIT ${maxOpps}`
          )}`
        );

        const splitOpps: any[] = oppData.records ?? [];

        if (splitOpps.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message: `No opportunities found where ${typeField} = '${typeValue}' and ${prevField} is set.`,
                  totalFound: 0,
                }),
              },
            ],
          };
        }

        // 2. Collect unique previous opp IDs
        const prevOppIds: string[] = [
          ...new Set(
            splitOpps.map((o: any) => o[prevField]).filter(Boolean) as string[]
          ),
        ];
        const prevIdsSoql = prevOppIds.map((id) => `'${id}'`).join(", ");

        // 3. Batch fetch ContentDocumentLinks for all previous opps in one query
        const linkData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${prevIdsSoql})`
          )}`
        );
        const links: any[] = linkData.records ?? [];

        const prevOppToDocIds: Record<string, string[]> = {};
        for (const link of links) {
          if (!prevOppToDocIds[link.LinkedEntityId])
            prevOppToDocIds[link.LinkedEntityId] = [];
          prevOppToDocIds[link.LinkedEntityId].push(link.ContentDocumentId);
        }

        // 4. Fetch PDF ContentVersion metadata for all docs in one query
        const versionMap: Record<string, any[]> = {};
        if (links.length > 0) {
          const allDocIds = links.map((l: any) => `'${l.ContentDocumentId}'`).join(", ");
          const versionData = await client.request(
            `/query?q=${encodeURIComponent(
              `SELECT Id, Title, FileType, ContentDocumentId, ContentSize FROM ContentVersion WHERE ContentDocumentId IN (${allDocIds}) AND FileType = 'PDF' AND IsLatest = true`
            )}`
          );
          for (const v of versionData.records ?? []) {
            if (!versionMap[v.ContentDocumentId]) versionMap[v.ContentDocumentId] = [];
            versionMap[v.ContentDocumentId].push(v);
          }
        }

        // 5. For each split opp, download its previous opp's PDFs and extract effective date
        const results = await runWithConcurrency(
          splitOpps.map((opp: any) => async () => {
            const prevOppId: string = opp[prevField];
            const prevOppName: string = opp[relField]?.Name ?? prevOppId;
            const contractStartDate: string | null = opp[startDateField] ?? null;

            const docIds = prevOppToDocIds[prevOppId] ?? [];
            const pdfVersions = docIds.flatMap((docId) => versionMap[docId] ?? []);

            const base = {
              account: opp.Account?.Name ?? null,
              splitOppName: opp.Name,
              splitOppId: opp.Id,
              previousOppName: prevOppName,
              previousOppId: prevOppId,
              contractStartDate,
            };

            if (pdfVersions.length === 0) {
              return {
                ...base,
                pdfFound: false,
                pdfTitle: null,
                pdfEffectiveDate: null,
                expectedStartDate: null,
                status: "no_pdf",
                statusDetail: "No PDF attached to Previous Opportunity",
              };
            }

            // Try each PDF until we find an effective date
            for (const version of pdfVersions) {
              if (version.ContentSize > MAX_PDF_BYTES) continue;

              try {
                const buffer = await client.requestBinary(
                  `/sobjects/ContentVersion/${version.Id}/VersionData`
                );
                const parser = new PDFParse({ data: buffer });
                const parsed = await parser.getText();
                const effectiveDate = extractEffectiveDate(parsed.text);

                if (!effectiveDate) continue;

                if (!contractStartDate) {
                  return {
                    ...base,
                    pdfFound: true,
                    pdfTitle: version.Title,
                    pdfEffectiveDate: effectiveDate,
                    expectedStartDate: null,
                    status: "no_contract_date",
                    statusDetail: `${startDateField} is blank on the split opportunity`,
                  };
                }

                return {
                  ...base,
                  pdfFound: true,
                  pdfTitle: version.Title,
                  pdfEffectiveDate: effectiveDate,
                  ...checkDateAlignment(effectiveDate, contractStartDate),
                };
              } catch {
                continue;
              }
            }

            // PDFs found but none yielded an extractable effective date
            return {
              ...base,
              pdfFound: true,
              pdfTitle: pdfVersions.map((v: any) => v.Title).join(", "),
              pdfEffectiveDate: null,
              expectedStartDate: null,
              status: "date_not_found",
              statusDetail: `PDF(s) found but no effective date pattern matched. Files: ${pdfVersions.map((v: any) => v.Title).join(", ")}`,
            };
          }),
          5
        );

        const issues = results.filter(
          (r: any) => r.status === "wrong" || r.status === "no_contract_date"
        );
        const correct = results.filter((r: any) => r.status === "correct");
        const noPdf = results.filter((r: any) => r.status === "no_pdf");
        const dateNotFound = results.filter((r: any) => r.status === "date_not_found");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    totalSplitOppsAudited: splitOpps.length,
                    verifiedCorrect: correct.length,
                    issuesFound: issues.length,
                    noPdfCannotVerify: noPdf.length,
                    pdfFoundButDateNotExtracted: dateNotFound.length,
                  },
                  issues,
                  verified: correct,
                  cannotVerify: noPdf,
                  dateExtractionFailed: dateNotFound,
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
              text: `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
