import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";

// Tools: sf_query, sf_describe, sf_list_objects, sf_tooling_query
export function registerQueryTools(
  server: McpServer,
  client: SalesforceClient
): void {
  server.tool(
    "sf_query",
    "Execute a SOQL query against Salesforce. Returns matching records.",
    {
      query: z
        .string()
        .describe(
          "The SOQL query to execute (e.g. SELECT Id, Name FROM Account LIMIT 10)"
        ),
    },
    async ({ query }) => {
      try {
        const records = await client.queryPaginated(query);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { totalSize: records.length, records },
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
        const data = await client.request(`/sobjects/${sobject}/describe`);
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

  server.tool(
    "sf_list_objects",
    "List all available Salesforce objects (sObjects) in the org.",
    {},
    async () => {
      try {
        const data = await client.request("/sobjects/");
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
        const records = await client.toolingQueryPaginated(query);
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
}
