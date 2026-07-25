import type { Opportunity } from '../cli.js';

/**
 * Merge overlapping recommendations from multiple opportunities.
 * Removes duplicates and produces a coherent combined set.
 */
export function mergeOpportunities(opportunities: Opportunity[]): Opportunity[] {
  if (opportunities.length <= 1) return opportunities;

  const merged: Opportunity[] = [];
  const seen = new Set<string>();

  for (const opp of opportunities) {
    // Generate a dedup key: selector + category
    const dedupKey = `${opp.selector || ''}::${opp.category}`;
    
    const matchIdx = merged.findIndex(m => {
      // Same element + same category = same fix
      if (m.selector && opp.selector && m.selector === opp.selector && m.category === opp.category) {
        return true;
      }
      // Similar title (word overlap > 60%)
      if (titleSimilarity(m.title, opp.title) > 0.6 && m.category === opp.category) {
        return true;
      }
      return false;
    });

    if (matchIdx >= 0) {
      const existing = merged[matchIdx];
      // Merge: promote severity, combine descriptions
      if (severityRank(opp.severity) > severityRank(existing.severity)) {
        existing.severity = opp.severity;
        existing.title = opp.title;
      }
      if (!existing.description.includes(opp.description)) {
        existing.description += '\n\n' + opp.description;
      }
      if (opp.confidence > existing.confidence) {
        existing.confidence = opp.confidence;
      }
      // Merge acceptance criteria
      if (opp.acceptanceCriteria?.length) {
        existing.acceptanceCriteria = [...(existing.acceptanceCriteria || []), ...opp.acceptanceCriteria];
      }
    } else {
      merged.push({ ...opp });
    }
  }

  return merged;
}

function severityRank(s: string): number {
  const ranks: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 };
  return ranks[s] || 0;
}

function titleSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  const intersection = [...aWords].filter(w => bWords.has(w)).length;
  return intersection / Math.max(aWords.size, bWords.size);
}
