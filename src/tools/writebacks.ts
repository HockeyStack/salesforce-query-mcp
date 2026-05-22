import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SalesforceClient } from "../SalesforceClient.js";

const API_VERSION_NUMBER = 62.0;

// Tools: sf_create_flow, sf_create_validation_rule
//
// Both writeback tools create their target in an INACTIVE state (Flow=Draft,
// ValidationRule.Active=false). Activation is a deliberate human step in the
// Salesforce UI - the bot is never the actor that pushes anything live.
export function registerWritebackTools(
  server: McpServer,
  client: SalesforceClient
): void {
  server.tool(
    "sf_create_flow",
    "Create an INACTIVE (Draft) record-triggered Flow in Salesforce. The flow is NOT activated - the user must review and activate it in the Salesforce UI, which acts as their code/flow review before push to production. Use this when the user asks you to 'build a flow', 'write back a flow', or 'create a flow'. Before calling, briefly confirm the plan with the user (object, trigger conditions, what field gets updated). Returns a link to the created flow.",
    {
      apiName: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "API name must start with a letter and contain only letters, numbers, and underscores")
        .describe('API name for the new flow, e.g. "Contact_LinkedIn_PersonID_Update". Letters, numbers, and underscores only.'),
      label: z
        .string()
        .describe('Human-readable label, e.g. "Contact LinkedIn Person ID Update"'),
      description: z.string().optional(),
      object: z
        .string()
        .describe('Salesforce object API name, e.g. "Contact", "Account", "Opportunity"'),
      triggerType: z
        .enum(["Create", "Update", "CreateAndUpdate"])
        .describe("When the flow fires"),
      entryConditionFormula: z
        .string()
        .optional()
        .describe('Optional filter formula that gates whether the flow runs at all. e.g. ISNEW() || ISCHANGED({!$Record.LinkedIn_Profile_URL__c})'),
      formulas: z
        .array(
          z.object({
            name: z.string().describe("Formula resource API name, referenced from updateRecord.fieldAssignments"),
            dataType: z.enum(["String", "Boolean", "Number", "Date", "DateTime", "Currency"]),
            expression: z.string().describe("Salesforce formula expression"),
          })
        )
        .optional()
        .describe("Formula resources usable as values in the update step"),
      decision: z
        .object({
          name: z.string().describe("Decision element API name"),
          label: z.string(),
          conditionFormula: z
            .string()
            .describe('Formula that must evaluate to true for the flow to proceed to the update step. e.g. CONTAINS({!$Record.LinkedIn_Profile_URL__c}, "/in/")'),
        })
        .optional()
        .describe("Optional yes/no branch. If omitted, the flow goes straight from start to updateRecord."),
      updateRecord: z
        .object({
          name: z.string().describe("Update element API name"),
          label: z.string(),
          fieldAssignments: z
            .record(z.string(), z.string())
            .describe('Map of target field API name to source resource name. Each value must be the name of a declared formula resource. e.g. { "LinkedIn_Person_ID__c": "formulaLinkedInPersonId" }'),
        })
        .describe("The actual writeback. Sets fields on the triggering record using formula references."),
    },
    async ({
      apiName,
      label,
      description,
      object,
      triggerType,
      entryConditionFormula,
      formulas,
      decision,
      updateRecord,
    }) => {
      try {
        // Validate that every field assignment references a declared formula
        const formulaNames = new Set((formulas ?? []).map((f) => f.name));
        for (const [field, ref] of Object.entries(updateRecord.fieldAssignments)) {
          if (!formulaNames.has(ref)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Field assignment "${field}" references "${ref}" which is not a declared formula. Declare it in the formulas array or use a different reference.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Build Flow Metadata JSON
        // Layout: start (50,0) -> decision (300,0) -> update (550,0)
        // (Salesforce will auto-layout in the UI; coordinates are just persisted.)
        const firstElementAfterStart = decision?.name ?? updateRecord.name;

        const metadata: any = {
          label,
          description: description ?? null,
          processType: "AutoLaunchedFlow",
          status: "Draft",
          interviewLabel: `${label} {!$Flow.CurrentDateTime}`,
          runInMode: "DefaultMode",
          apiVersion: API_VERSION_NUMBER,
          start: {
            locationX: 50,
            locationY: 0,
            object,
            recordTriggerType: triggerType,
            triggerType: "RecordAfterSave",
            ...(entryConditionFormula && { filterFormula: entryConditionFormula }),
            connector: { targetReference: firstElementAfterStart },
          },
          recordUpdates: [
            {
              name: updateRecord.name,
              label: updateRecord.label,
              locationX: 550,
              locationY: 0,
              inputReference: "$Record",
              inputAssignments: Object.entries(updateRecord.fieldAssignments).map(
                ([field, ref]) => ({
                  field,
                  value: { elementReference: ref },
                })
              ),
            },
          ],
          formulas: (formulas ?? []).map((f) => ({
            name: f.name,
            dataType: f.dataType,
            expression: f.expression,
          })),
        };

        if (decision) {
          metadata.decisions = [
            {
              name: decision.name,
              label: decision.label,
              locationX: 300,
              locationY: 0,
              defaultConnectorLabel: "No",
              rules: [
                {
                  name: `${decision.name}_Yes`,
                  label: "Yes",
                  conditionLogic: "and",
                  conditions: [
                    {
                      leftValueReference: "$GlobalConstant.True",
                      operator: "EqualTo",
                      rightValue: {
                        formulaExpression: decision.conditionFormula,
                      },
                    },
                  ],
                  connector: { targetReference: updateRecord.name },
                },
              ],
            },
          ];
        }

        const body = { FullName: apiName, Metadata: metadata };
        const result = await client.requestPost("/tooling/sobjects/Flow", body);

        if (!result?.id) {
          return {
            content: [
              {
                type: "text",
                text: `Flow creation returned no ID. Raw response: ${JSON.stringify(result)}`,
              },
            ],
            isError: true,
          };
        }

        const url = `https://hockeystack.lightning.force.com/lightning/setup/Flows/page?address=%2F${result.id}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                created: "Flow",
                flowId: result.id,
                apiName,
                status: "Draft",
                note: "Flow is INACTIVE. Open the URL below in Salesforce to review and activate.",
                url,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Flow creation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "sf_create_validation_rule",
    "Create an INACTIVE Validation Rule in Salesforce. The rule is NOT enforced until the user reviews and activates it in the Salesforce UI. Use when the user asks to 'create a validation rule' or 'add a validation rule'. Before calling, briefly confirm the plan with the user (object, formula, error message). Returns a link to the created rule.",
    {
      object: z
        .string()
        .describe('Salesforce object API name the rule applies to, e.g. "Opportunity"'),
      apiName: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "API name must start with a letter and contain only letters, numbers, and underscores")
        .describe('API name (no spaces), e.g. "Require_Contract_Start_Date"'),
      description: z.string().optional(),
      errorConditionFormula: z
        .string()
        .describe("Formula that evaluates to true when the record should be REJECTED with the error message"),
      errorMessage: z
        .string()
        .describe("Message shown to the user when the rule fires"),
      errorDisplayField: z
        .string()
        .optional()
        .describe("Field API name to attach the error to. If omitted, the error appears at the top of the page."),
    },
    async ({
      object,
      apiName,
      description,
      errorConditionFormula,
      errorMessage,
      errorDisplayField,
    }) => {
      try {
        const fullName = `${object}.${apiName}`;
        const metadata: any = {
          active: false,
          description: description ?? null,
          errorConditionFormula,
          errorMessage,
          ...(errorDisplayField && { errorDisplayField }),
        };

        const body = { FullName: fullName, Metadata: metadata };
        const result = await client.requestPost(
          "/tooling/sobjects/ValidationRule",
          body
        );

        if (!result?.id) {
          return {
            content: [
              {
                type: "text",
                text: `Validation rule creation returned no ID. Raw response: ${JSON.stringify(result)}`,
              },
            ],
            isError: true,
          };
        }

        const url = `https://hockeystack.lightning.force.com/lightning/setup/ObjectManager/${object}/ValidationRules/${result.id}/view`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                created: "ValidationRule",
                validationRuleId: result.id,
                fullName,
                active: false,
                note: "Rule is INACTIVE. Open the URL below in Salesforce to review and activate.",
                url,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Validation rule creation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
