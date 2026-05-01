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
