const SOURCES = [
  {
    title: 'Guidewire PolicyCenter Cloud API',
    url: 'https://docs.guidewire.com/cloud/is/202603/cloudapibf/cloudAPI/PolicyCenter.html',
    terms: ['policycenter', 'cloud api', 'api', 'policy']
  },
  {
    title: 'PolicyCenter Job Policies',
    url: 'https://docs.guidewire.com/cloud/is/202603/cloudapibf/cloudAPI/PolicyCenter/job-policies.html',
    terms: ['job', 'submission', 'renewal', 'cancellation', 'reinstatement', 'policy transaction']
  },
  {
    title: 'PolicyCenter Modifying Jobs',
    url: 'https://docs.guidewire.com/cloud/is/202603/cloudapibf/cloudAPI/PolicyCenter/job-policies/overview-of-modifying-jobs.html',
    terms: ['coverable', 'coverage', 'modifier', 'question', 'exposure', 'exclusion', 'condition', 'job']
  },
  {
    title: 'PolicyCenter Rating Overrides',
    url: 'https://docs.guidewire.com/cloud/is/202603/cloudapibf/cloudAPI/PolicyCenter/job-support/quoting/c_rating_overrides.html',
    terms: ['rating', 'rating override', 'quote', 'quoting', 'cost', 'base rate', 'adjusted rate']
  },
  {
    title: 'Guidewire Technical Glossary',
    url: 'https://docs.guidewire.com/glossary/tech-terms.html',
    terms: ['gosu', 'entity', 'plugin', 'data model', 'rule engine', 'policycenter', 'guidewire']
  },
  {
    title: 'Gosu Secure Coding Guidance',
    url: 'https://docs.guidewire.com/security/gosu-secure-coding-guidelines/',
    terms: ['gosu', 'security', 'secure', 'injection', 'coding', 'vulnerability']
  },
  {
    title: 'Guidewire Cloud API Developer Guide',
    url: 'https://docs.guidewire.com/cloud/pc/202503/cloudapica/pdf/CloudAPI-Developer.pdf',
    terms: ['developer guide', 'cloud api', 'preload', 'endpoint', 'api role']
  }
];

const STOPWORDS = new Set(['a','an','the','is','are','what','how','to','of','for','in','on','and','or','with','can','please','me','this','that']);

function terms(text) {
  return String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]*/g) || [];
}

function score(query, source) {
  const q = new Set(terms(query).filter(t => !STOPWORDS.has(t)));
  let hits = 0;
  for (const term of source.terms) {
    const sourceTerms = terms(term);
    if (sourceTerms.some(t => q.has(t))) hits += 1;
  }
  return hits;
}

async function fetchPage(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(source.url, {
      headers: { 'user-agent': 'Learn-with-me-Luna/1.0' },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 8000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchOfficialGuidewireDocs(query, limit = 2) {
  const candidates = SOURCES
    .map(source => ({ source, score: score(query, source) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 3)));

  const results = [];
  for (const row of candidates) {
    const text = await fetchPage(row.source);
    if (!text) continue;
    const q = terms(query).filter(t => !STOPWORDS.has(t));
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const relevant = sentences
      .map(sentence => ({
        sentence,
        score: q.filter(term => sentence.toLowerCase().includes(term)).length
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(item => item.sentence)
      .join(' ');

    results.push({
      type: 'guidewire-docs',
      title: row.source.title,
      path: row.source.url,
      href: row.source.url,
      snippet: (relevant || text.slice(0, 900)).slice(0, 900),
      score: row.score * 10,
      source: 'official Guidewire documentation'
    });
  }
  return results;
}
