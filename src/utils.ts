import type { SalesforceClient } from "./SalesforceClient.js";

/** Runs tasks with a max concurrency limit to avoid overwhelming the API or exhausting memory. */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}

/** Returns short context snippets around each matched term for display. */
export function extractSnippets(
  text: string,
  terms: string[],
  contextChars = 120
): string[] {
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

/**
 * All top-level node/element types present in Salesforce flow metadata JSON.
 * "start" is included because record-triggered flows store their object/filter
 * conditions there — omitting it would silently miss those references.
 */
export const FLOW_NODE_TYPES = [
  "start",
  "decisions",
  "assignments",
  "recordUpdates",
  "recordLookups",
  "recordCreates",
  "recordDeletes",
  "subflows",
  "actionCalls",
  "apexPluginCalls",
  "loops",
  "screens",
  "waits",
  "customErrors",
  "formulas",
  "variables",
  "constants",
  "textTemplates",
] as const;

export interface FlowNodeMatch {
  nodeApiName: string;
  nodeLabel: string | null;
  nodeType: string;
  matchedTerms: string[];
}

/**
 * Searches a flow's Metadata object at the node level. Returns one entry per
 * node that contains at least one search term, with the node's API name, label,
 * and type — so callers know exactly which node to open in Flow Builder.
 */
export function extractMatchingNodes(
  metadata: any,
  terms: string[]
): FlowNodeMatch[] {
  const matches: FlowNodeMatch[] = [];

  for (const nodeType of FLOW_NODE_TYPES) {
    const nodes = metadata[nodeType];
    if (!Array.isArray(nodes)) continue;

    for (const node of nodes) {
      const nodeStr = JSON.stringify(node).toLowerCase();
      const matchedTerms = terms.filter((t) =>
        nodeStr.includes(t.toLowerCase())
      );

      if (matchedTerms.length > 0) {
        matches.push({
          nodeApiName: node.name ?? node.apiName ?? "(unnamed)",
          nodeLabel: node.label ?? null,
          nodeType,
          matchedTerms,
        });
      }
    }
  }

  return matches;
}

// ── Shared flow search ────────────────────────────────────────────────────────

export interface FlowSearchResult {
  flow: any;
  surfaceMatches: string[];
  deepMatches: string[];
  matchingNodes: FlowNodeMatch[];
  metadataNote: string | null;
}

/**
 * Searches a single flow's surface fields and full metadata for the given terms.
 * Shared between sf_search_flows and sf_impact_analysis to keep the logic in one place.
 */
export async function searchFlowMetadata(
  client: SalesforceClient,
  flow: any,
  searchTerms: string[]
): Promise<FlowSearchResult> {
  const surfaceText = [flow.MasterLabel, flow.Description, flow.ProcessType]
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
      matchingNodes = extractMatchingNodes(detail.Metadata, searchTerms);
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
}

// ── Shared validation rule search ─────────────────────────────────────────────

/** SOQL field list for ValidationRule queries — single source of truth. */
export const VALIDATION_RULE_SOQL_FIELDS =
  "Id, ValidationName, Active, ErrorDisplayField, ErrorMessage, Description";

export interface ValidationRuleMatch {
  id: string;
  name: string;
  active: boolean;
  errorDisplayField: string;
  errorMessage: string;
  description: string | null;
  conditionFormula: string | null;
  matchedTerms: string[];
  snippets: string[];
  metadataNote: string | null;
}

/**
 * Searches all validation rules on an object for the given terms.
 * Returns matched rules and any per-rule metadata limitations encountered.
 * Shared between sf_search_validation_rules and sf_impact_analysis.
 */
export async function searchValidationRules(
  client: SalesforceClient,
  entityId: string,
  searchTerms: string[]
): Promise<{ matches: ValidationRuleMatch[]; limitations: string[] }> {
  const rules = await client.toolingQueryPaginated(
    `SELECT ${VALIDATION_RULE_SOQL_FIELDS} FROM ValidationRule WHERE EntityDefinitionId = '${entityId}'`
  );

  const matches: ValidationRuleMatch[] = [];
  const limitations: string[] = [];

  for (const rule of rules) {
    let formula: string | null = null;
    let metadataNote: string | null = null;

    try {
      const detail = await client.toolingRecord("ValidationRule", rule.Id);
      formula = detail.Metadata?.conditionFormula ?? null;
      if (!formula) {
        metadataNote = "Metadata/formula was null — searched other fields only";
      }
    } catch {
      limitations.push(
        `Could not retrieve metadata for validation rule "${rule.ValidationName}" — formula not searched`
      );
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

    const matchedTerms = searchTerms.filter((t) =>
      searchableText.toLowerCase().includes(t.toLowerCase())
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

  return { matches, limitations };
}
