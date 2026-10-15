/**
 * Library search tool (provider-independent).
 * Permission-filtered keyword search over the library tree.
 */
import { allFiles } from '../../library/tree.js';
import { contentRouteForPath, canAccessLibraryPathAsync } from '../../library/local.js';

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'what','whats','what’s','which','who','where','when','why','how',
  'do','does','did','can','could','would','should','will','may','might',
  'i','me','my','we','our','you','your','it','its','this','that',
  'these','those','to','of','for','from','in','on','at','by','with',
  'about','and','or','but','as','than','then','also','please','tell',
  'give','show','explain','information','thing','things','something'
]);

function terms(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z_][a-z0-9_]*|\d+/g) || []);
}

function meaningfulTerms(text) {
  return [...terms(text)].filter(t => !STOPWORDS.has(t) && t.length > 1);
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function overlapScore(queryTerms, textTerms) {
  if (!queryTerms.length || !textTerms.size) return 0;
  let hits = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) hits += 1;
  }
  return hits / queryTerms.length;
}

function scoreFile(query, file) {
  const pathText = normalize(file.path);
  const content = normalize(file.content).slice(0, 5000);
  const queryTerms = meaningfulTerms(query);
  const pathOverlap = overlapScore(queryTerms, terms(pathText));
  const contentOverlap = overlapScore(queryTerms, terms(content));
  let score = pathOverlap * 65 + contentOverlap * 35;
  const lowerPath = pathText.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  if (lowerQuery && lowerPath.includes(lowerQuery)) score += 40;
  for (const term of queryTerms) {
    if (lowerPath.includes(term)) score += 4;
  }
  return { score, queryTerms };
}

function bestSnippet(query, text) {
  const qTerms = meaningfulTerms(query);
  const sentences = normalize(text).split(/(?<=[.!?])\s+|\n+/).map(normalize).filter(Boolean);
  const ranked = sentences
    .map(sentence => ({ sentence, score: overlapScore(qTerms, terms(sentence)) }))
    .sort((a, b) => b.score - a.score);
  return (ranked[0]?.sentence || normalize(text).slice(0, 500) || '').slice(0, 900);
}

/**
 * @returns {Promise<Array<{source,title,path,href,content,page,metadata}>>}
 */
export async function searchLibrary({ query, tree, user, topK = 5 }) {
  const limit = Math.min(Math.max(Number(topK) || 5, 1), 8);
  const rows = (
    await Promise.all(
      allFiles(tree)
        .filter(file => file && file.path)
        .map(async file => ({ file, allowed: await canAccessLibraryPathAsync(user, file.path) }))
    )
  )
    .filter(row => row.allowed)
    .map(row => {
      const { score, queryTerms } = scoreFile(query, row.file);
      const searchable = `${row.file.path}\n${row.file.content || ''}`.toLowerCase();
      const termHits = queryTerms.filter(term => searchable.includes(term)).length;
      const boosted = queryTerms.length > 0 && termHits === queryTerms.length
        ? score + 30
        : termHits > 0 ? score + 8 : score;
      return { file: row.file, score: boosted };
    })
    .filter(row => row.score >= 12)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const evidence = [];
  for (const row of rows) {
    const key = row.file.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const encoded = row.file.path.split('/').map(encodeURIComponent).join('/');
    evidence.push({
      source: 'library',
      title: row.file.path.split('/').at(-1) || row.file.path,
      path: row.file.path,
      href: contentRouteForPath(row.file.path) + encoded,
      content: bestSnippet(query, row.file.content || `Found file: ${row.file.path}`),
      page: null,
      metadata: { score: Number(row.score.toFixed(2)) }
    });
    if (evidence.length >= limit) break;
  }
  return evidence;
}

export { meaningfulTerms };
