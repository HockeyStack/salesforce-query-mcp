import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PDFParse } from "pdf-parse";
import { SalesforceClient } from "../SalesforceClient.js";
import { runWithConcurrency } from "../utils.js";

const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30 MB

// Tools: sf_get_opportunity_files, sf_read_file_as_text, sf_scan_opportunity_pdfs
export function registerFileTools(
  server: McpServer,
  client: SalesforceClient
): void {
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
        const links = await client.request(
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

  server.tool(
    "sf_read_file_as_text",
    "Download a Salesforce file by ContentVersionId and return its text content. Supports PDF (parsed to text) and plain text files (TXT, CSV, JSON, XML). Use sf_get_opportunity_files first to get the ContentVersionId.",
    {
      contentVersionId: z
        .string()
        .describe(
          "The ContentVersion ID of the file to read (from sf_get_opportunity_files)"
        ),
    },
    async ({ contentVersionId }) => {
      try {
        const meta = await client.request(
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

        if (fileMeta.ContentSize > MAX_FILE_BYTES) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  contentVersionId,
                  title: fileMeta.Title,
                  sizeBytes: fileMeta.ContentSize,
                  error: `File is too large to download (${(fileMeta.ContentSize / 1024 / 1024).toFixed(1)} MB). Limit is 30 MB.`,
                }),
              },
            ],
            isError: true,
          };
        }

        const buffer = await client.requestBinary(
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
        .describe(
          "Max number of Opportunities to scan. Defaults to 20, max 50."
        ),
    },
    async ({
      opportunityFilter,
      searchTerms = [],
      checkProductMatch = false,
      maxOpportunities = 20,
    }) => {
      try {
        // 1. Fetch matching opportunities
        const oppData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE ${opportunityFilter} ORDER BY CloseDate DESC LIMIT ${maxOpportunities}`
          )}`
        );

        const opps: any[] = oppData.records ?? [];
        if (opps.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { message: "No opportunities matched the filter.", results: [] },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const oppIds = opps.map((o: any) => `'${o.Id}'`).join(", ");

        // 2. Fetch all ContentDocumentLinks for these opportunities in one query
        const linkData = await client.request(
          `/query?q=${encodeURIComponent(
            `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${oppIds})`
          )}`
        );
        const links: any[] = linkData.records ?? [];

        // Build map: opportunityId → [ContentDocumentId]
        const oppToDocIds: Record<string, string[]> = {};
        for (const link of links) {
          if (!oppToDocIds[link.LinkedEntityId])
            oppToDocIds[link.LinkedEntityId] = [];
          oppToDocIds[link.LinkedEntityId].push(link.ContentDocumentId);
        }

        const allDocIds = links.map((l: any) => `'${l.ContentDocumentId}'`).join(", ");

        // 3. Fetch ContentVersion metadata for all PDFs in one query
        const versionMap: Record<string, any[]> = {};
        if (allDocIds.length > 0) {
          const versionData = await client.request(
            `/query?q=${encodeURIComponent(
              `SELECT Id, Title, FileType, ContentDocumentId, ContentSize FROM ContentVersion WHERE ContentDocumentId IN (${allDocIds}) AND FileType = 'PDF' AND IsLatest = true`
            )}`
          );
          for (const v of versionData.records ?? []) {
            if (!versionMap[v.ContentDocumentId])
              versionMap[v.ContentDocumentId] = [];
            versionMap[v.ContentDocumentId].push(v);
          }
        }

        // 4. Fetch line items for all opportunities in one query (for product mismatch check)
        const lineItemsByOpp: Record<string, string[]> = {};
        if (checkProductMatch) {
          const liData = await client.request(
            `/query?q=${encodeURIComponent(
              `SELECT OpportunityId, Product2.Name FROM OpportunityLineItem WHERE OpportunityId IN (${oppIds})`
            )}`
          );
          for (const li of liData.records ?? []) {
            if (!lineItemsByOpp[li.OpportunityId])
              lineItemsByOpp[li.OpportunityId] = [];
            if (li.Product2?.Name)
              lineItemsByOpp[li.OpportunityId].push(li.Product2.Name);
          }
        }

        // 5. For each opportunity, download and parse its PDFs — capped at 5 concurrent opps,
        //    and 3 concurrent PDF downloads per opp to avoid OOM on large attachments.
        const results = await runWithConcurrency(
          opps.map((opp: any) => async () => {
            const docIds = oppToDocIds[opp.Id] ?? [];
            const pdfVersions = docIds.flatMap(
              (docId) => versionMap[docId] ?? []
            );

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

            const pdfResults = await runWithConcurrency(
              pdfVersions.map((version: any) => async () => {
                try {
                  if (version.ContentSize > MAX_FILE_BYTES) {
                    return {
                      contentVersionId: version.Id,
                      title: version.Title,
                      sizeBytes: version.ContentSize,
                      termMatches: null,
                      anyTermMatched: null,
                      productMismatch: null,
                      parseError: `File too large to scan (${(version.ContentSize / 1024 / 1024).toFixed(1)} MB, limit 30 MB)`,
                    };
                  }

                  const buffer = await client.requestBinary(
                    `/sobjects/ContentVersion/${version.Id}/VersionData`
                  );
                  const parser = new PDFParse({ data: buffer });
                  const parsed = await parser.getText();
                  const text = parsed.text.replace(/\n{3,}/g, "\n\n").trim();

                  const termMatches: Record<string, boolean> = {};
                  for (const term of searchTerms) {
                    termMatches[term] = text
                      .toLowerCase()
                      .includes(term.toLowerCase());
                  }

                  let productMismatch: {
                    lineItemProducts: string[];
                    missingFromPdf: string[];
                    note: string;
                  } | null = null;
                  if (checkProductMatch) {
                    const lineItemProducts = lineItemsByOpp[opp.Id] ?? [];
                    const missingFromPdf = lineItemProducts.filter(
                      (p) => !text.toLowerCase().includes(p.toLowerCase())
                    );
                    productMismatch = {
                      lineItemProducts,
                      missingFromPdf,
                      note:
                        missingFromPdf.length > 0
                          ? `${missingFromPdf.length} product(s) on the opportunity not found in PDF text`
                          : "All opportunity products appear in PDF",
                    };
                  }

                  return {
                    contentVersionId: version.Id,
                    title: version.Title,
                    sizeBytes: version.ContentSize,
                    termMatches: searchTerms.length > 0 ? termMatches : undefined,
                    anyTermMatched:
                      searchTerms.length > 0
                        ? Object.values(termMatches).some(Boolean)
                        : undefined,
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
                    parseError:
                      err instanceof Error ? err.message : String(err),
                  };
                }
              }),
              3
            );

            const anyMatch = pdfResults.some((p) => p.anyTermMatched);
            const hasProductMismatch = pdfResults.some(
              (p) =>
                p.productMismatch && p.productMismatch.missingFromPdf.length > 0
            );

            return {
              opportunityId: opp.Id,
              opportunityName: opp.Name,
              account: opp.Account?.Name ?? null,
              closeDate: opp.CloseDate,
              amount: opp.Amount,
              pdfsFound: pdfVersions.length,
              anyTermMatched: searchTerms.length > 0 ? anyMatch : undefined,
              hasProductMismatch: checkProductMatch
                ? hasProductMismatch
                : undefined,
              pdfs: pdfResults,
            };
          }),
          5
        );

        const summary = {
          opportunitiesScanned: opps.length,
          opportunitiesWithPdfs: results.filter((r) => r.pdfsFound > 0).length,
          ...(searchTerms.length > 0 && {
            opportunitiesWithTermMatches: results.filter(
              (r) => r.anyTermMatched
            ).length,
            searchTerms,
          }),
          ...(checkProductMatch && {
            opportunitiesWithProductMismatches: results.filter(
              (r) => r.hasProductMismatch
            ).length,
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
}
