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

/**
 * Extracts the contract service term (in months) from PDF text.
 * Looks for patterns like "Service Term: 12 Months", "12-month term", "1 year contract".
 */
function extractServiceTermMonths(pdfText: string): number | null {
  const patterns: Array<{ regex: RegExp; unit: "month" | "year" }> = [
    { regex: /service\s+term\s*:?\s*(\d+)\s*months?/i, unit: "month" },
    { regex: /\bterm\s*:?\s*(\d+)\s*months?/i, unit: "month" },
    { regex: /(\d+)[\s-]*month\s+(?:term|contract|subscription|agreement)/i, unit: "month" },
    { regex: /service\s+term\s*:?\s*(\d+)\s*years?/i, unit: "year" },
    { regex: /\bterm\s*:?\s*(\d+)\s*years?/i, unit: "year" },
    { regex: /(\d+)[\s-]*year\s+(?:term|contract|subscription|agreement)/i, unit: "year" },
  ];

  for (const { regex, unit } of patterns) {
    const match = pdfText.match(regex);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!isNaN(n) && n > 0 && n < 120) {
        return unit === "year" ? n * 12 : n;
      }
    }
  }

  return null;
}

/** Adds N months to a YYYY-MM-DD date, then subtracts 1 day (contract end = start + term - 1 day). */
function computeEndDate(startDateStr: string, termMonths: number): string {
  const [y, m, d] = startDateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(start);
  end.setMonth(end.getMonth() + termMonths);
  end.setDate(end.getDate() - 1);
  return formatYMD(end);
}

/** Days between two YYYY-MM-DD dates, ignoring timezone. */
function daysBetween(aStr: string, bStr: string): number {
  const [ay, am, ad] = aStr.split("-").map(Number);
  const [by, bm, bd] = bStr.split("-").map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// Tools: sf_get_opportunity_details, sf_audit_multi_year_splits, sf_audit_contract_dates
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

  server.tool(
    "sf_audit_contract_dates",
    "Audit ALL active opportunities at once: compares Contract Start/End Dates against the effective date and service term in each opp's attached PDF contract. Returns a complete audit in a single call - the entire result set, not a batch. Use this for any 'audit all my contracts', 'check contract dates', or 'find date discrepancies' request. NEVER do this audit manually by calling sf_get_opportunity_files / sf_read_file_as_text per opportunity - that causes token limit errors and inconsistent batching. After getting the result, summarize discrepancies first; do not list every verified opp by name.",
    {
      startDateField: z
        .string()
        .optional()
        .describe('SF date field to compare against PDF effective date. Defaults to "Contract_Start_Date__c"'),
      endDateField: z
        .string()
        .optional()
        .describe('SF date field to compare against PDF (effective date + service term). Defaults to "Contract_End_Date__c"'),
      activeOnly: z
        .boolean()
        .optional()
        .describe("If true, only audit opportunities where the end date is today or later. Defaults to true."),
      excludeAccountIds: z
        .array(z.string())
        .optional()
        .describe('Account IDs to exclude from the audit. Defaults to ["001Hu00003DPEbtIAH"] (HockeyStack internal test account).'),
      excludeOpportunityTypes: z
        .array(z.string())
        .optional()
        .describe('Opportunity Type picklist values to exclude. Defaults to ["Multi-Year Split"] (use sf_audit_multi_year_splits for those instead).'),
      maxOpportunities: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max opportunities to audit. Defaults to 300."),
      toleranceDays: z
        .number()
        .int()
        .min(0)
        .max(30)
        .optional()
        .describe("Days of drift to tolerate before flagging a mismatch. Defaults to 0. Pass 1 to ignore common 1-day timezone drifts."),
    },
    async ({
      startDateField,
      endDateField,
      activeOnly,
      excludeAccountIds,
      excludeOpportunityTypes,
      maxOpportunities,
      toleranceDays,
    }) => {
      const startField = startDateField ?? "Contract_Start_Date__c";
      const endField = endDateField ?? "Contract_End_Date__c";
      const onlyActive = activeOnly ?? true;
      const excludeAccts = excludeAccountIds ?? ["001Hu00003DPEbtIAH"];
      const excludeTypes = excludeOpportunityTypes ?? ["Multi-Year Split"];
      const maxOpps = maxOpportunities ?? 300;
      const tolerance = toleranceDays ?? 0;

      try {
        // 1. Build SOQL filter and query active opps
        const whereClauses: string[] = [`${startField} != null`];
        if (onlyActive) whereClauses.push(`${endField} >= TODAY`);
        if (excludeAccts.length > 0) {
          const ids = excludeAccts.map((id) => `'${id}'`).join(", ");
          whereClauses.push(`AccountId NOT IN (${ids})`);
        }
        if (excludeTypes.length > 0) {
          const types = excludeTypes.map((t) => `'${t}'`).join(", ");
          whereClauses.push(`Type NOT IN (${types})`);
        }

        const oppData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT Id, Name, AccountId, Account.Name, Type, ${startField}, ${endField} FROM Opportunity WHERE ${whereClauses.join(" AND ")} ORDER BY Account.Name ASC LIMIT ${maxOpps}`
          )}`
        );

        const opps: any[] = oppData.records ?? [];

        if (opps.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message: "No opportunities matched the audit filter.",
                  filter: whereClauses.join(" AND "),
                  totalFound: 0,
                }),
              },
            ],
          };
        }

        const oppIds = opps.map((o: any) => `'${o.Id}'`).join(", ");

        // 2. Batch fetch all ContentDocumentLinks for these opps
        const linkData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${oppIds})`
          )}`
        );
        const links: any[] = linkData.records ?? [];

        const oppToDocIds: Record<string, string[]> = {};
        for (const link of links) {
          if (!oppToDocIds[link.LinkedEntityId])
            oppToDocIds[link.LinkedEntityId] = [];
          oppToDocIds[link.LinkedEntityId].push(link.ContentDocumentId);
        }

        // 3. Batch fetch PDF ContentVersion metadata
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

        // 4. Concurrently download + parse each opp's PDFs and compare
        const results = await runWithConcurrency(
          opps.map((opp: any) => async () => {
            const accountName = opp.Account?.Name ?? null;
            const oppName: string = opp.Name;
            const oppId: string = opp.Id;
            const sfStart: string | null = opp[startField] ?? null;
            const sfEnd: string | null = opp[endField] ?? null;

            const docIds = oppToDocIds[oppId] ?? [];
            const pdfVersions = docIds.flatMap((d) => versionMap[d] ?? []);

            const baseInfo = { account: accountName, oppName, oppId };

            if (pdfVersions.length === 0) {
              return { kind: "no_pdf" as const, ...baseInfo };
            }

            // Try each PDF until one yields an extractable effective date
            for (const version of pdfVersions) {
              if (version.ContentSize > MAX_PDF_BYTES) continue;

              let pdfText: string;
              try {
                const buffer = await client.requestBinary(
                  `/sobjects/ContentVersion/${version.Id}/VersionData`
                );
                const parser = new PDFParse({ data: buffer });
                const parsed = await parser.getText();
                pdfText = parsed.text;
              } catch {
                continue;
              }

              const pdfEffectiveDate = extractEffectiveDate(pdfText);
              if (!pdfEffectiveDate) continue;

              const pdfTermMonths = extractServiceTermMonths(pdfText);
              const pdfExpectedEndDate =
                pdfTermMonths !== null
                  ? computeEndDate(pdfEffectiveDate, pdfTermMonths)
                  : null;

              // Compare start dates
              const startDriftDays =
                sfStart !== null ? daysBetween(pdfEffectiveDate, sfStart) : null;
              const startMatches =
                startDriftDays !== null && Math.abs(startDriftDays) <= tolerance;

              // Compare end dates (only if we extracted a term)
              const endDriftDays =
                pdfExpectedEndDate !== null && sfEnd !== null
                  ? daysBetween(pdfExpectedEndDate, sfEnd)
                  : null;
              const endMatches =
                endDriftDays !== null && Math.abs(endDriftDays) <= tolerance;

              const startStatus = startMatches
                ? "match"
                : `off_by_${startDriftDays! > 0 ? "+" : ""}${startDriftDays}_days`;
              const endStatus =
                pdfExpectedEndDate === null
                  ? "service_term_not_extracted"
                  : endMatches
                    ? "match"
                    : `off_by_${endDriftDays! > 0 ? "+" : ""}${endDriftDays}_days`;

              const startOk = startMatches;
              const endOk =
                pdfExpectedEndDate === null /* unknown, don't flag */ || endMatches;

              if (startOk && endOk) {
                return { kind: "verified" as const, ...baseInfo };
              }

              return {
                kind: "discrepancy" as const,
                ...baseInfo,
                pdfTitle: version.Title,
                pdfEffectiveDate,
                pdfServiceTermMonths: pdfTermMonths,
                pdfExpectedEndDate,
                sfContractStartDate: sfStart,
                sfContractEndDate: sfEnd,
                startStatus,
                endStatus,
              };
            }

            // PDFs present but none yielded a usable effective date
            return {
              kind: "extraction_failed" as const,
              ...baseInfo,
              pdfTitles: pdfVersions.map((v: any) => v.Title),
              reason:
                "Could not extract effective date from any attached PDF (regex did not match known patterns)",
            };
          }),
          5
        );

        const discrepancies = results.filter((r: any) => r.kind === "discrepancy");
        const verified = results.filter((r: any) => r.kind === "verified");
        const noPdf = results.filter((r: any) => r.kind === "no_pdf");
        const extractionFailed = results.filter(
          (r: any) => r.kind === "extraction_failed"
        );

        const stripKind = ({ kind: _kind, ...rest }: any) => rest;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    totalAudited: opps.length,
                    verifiedCorrect: verified.length,
                    discrepancies: discrepancies.length,
                    noPdf: noPdf.length,
                    extractionFailed: extractionFailed.length,
                    toleranceDays: tolerance,
                    activeOnly: onlyActive,
                  },
                  discrepancies: discrepancies.map(stripKind),
                  noPdf: noPdf.map((r: any) => ({
                    account: r.account,
                    oppName: r.oppName,
                    oppId: r.oppId,
                  })),
                  extractionFailed: extractionFailed.map(stripKind),
                  verified: verified.map((r: any) => ({
                    account: r.account,
                    oppName: r.oppName,
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
              text: `Contract dates audit failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
