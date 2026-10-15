/**
 * Guidewire-docs tool: thin provider-independent wrapper over the existing
 * official-docs search (kept in ../guidewire-docs.js for reuse).
 */
import { searchOfficialGuidewireDocs as searchDocs } from '../guidewire-docs.js';

export async function searchGuidewireDocs(query, limit = 2) {
  const rows = await searchDocs(query, limit);
  return rows.map(row => ({
    source: 'guidewire-docs',
    title: row.title,
    path: row.path,
    href: row.href,
    content: row.snippet,
    page: null,
    metadata: { source: row.source || 'official Guidewire documentation', score: row.score }
  }));
}
