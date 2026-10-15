// Public Knowledge Base - Concept Library Loader
// Loads and parses educational concept text files from /public_data/ into structured articles.
// Canonical source files remain unchanged. Content is cached in memory at startup.

import fs from 'node:fs';
import path from 'node:path';

const ACRONYMS = new Set([
  'FNOL', 'API', 'APIS', 'CRUD', 'SQL', 'ACID', 'JVM', 'OOP', 'SOLID', 'CTE', 'CTES',
  'JSON', 'REST', 'JDBC', 'DB', 'RDBMS', 'HTTP', 'HTTPS', 'URL', 'HTML', 'XML', 'ID',
  'PC', 'CC', 'BC', 'ACV', 'GC', 'DDL', 'DML', 'DCL', 'PK', 'FK', 'ER', 'AI'
]);

const LOWERCASE_WORDS = new Set([
  'and', 'or', 'of', 'the', 'in', 'to', 'a', 'an', 'for', 'with', 'on', 'at', 'from', 'by'
]);

const CATEGORY_MAP = {
  'Guidewire': {
    slug: 'guidewire-theory',
    alias: 'guidewire',
    name: 'Guidewire Architecture & Gosu'
  },
  'Insurance': {
    slug: 'insurance',
    alias: 'insurance',
    name: 'Insurance Principles'
  },
  'Java': {
    slug: 'java',
    alias: 'java',
    name: 'Java Concepts'
  },
  'SQL': {
    slug: 'sql',
    alias: 'sql',
    name: 'SQL & Databases'
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatTitle(raw) {
  if (!raw) return '';
  // Split on spaces or hyphens while preserving punctuation
  const words = raw.trim().split(/\s+/);
  return words.map((w, idx) => {
    // Check if word contains internal hyphens e.g. "OUT-OF-SEQUENCE"
    if (w.includes('-') && !w.startsWith('-') && !w.endsWith('-')) {
      return w.split('-').map(part => formatTitleWord(part, idx)).join('-');
    }
    return formatTitleWord(w, idx);
  }).join(' ');
}

const SPECIAL_CASES = new Map([
  ['CLAIMCENTER', 'ClaimCenter'],
  ['POLICYCENTER', 'PolicyCenter'],
  ['BILLINGCENTER', 'BillingCenter'],
  ['CONTACTCENTER', 'ContactCenter'],
  ['HASHMAP', 'HashMap'],
  ['COMPLETABLEFUTURE', 'CompletableFuture'],
  ['EXECUTORSERVICE', 'ExecutorService'],
  ['STRINGBUILDER', 'StringBuilder']
]);

function formatTitleWord(word, index) {
  const clean = word.replace(/[^a-zA-Z0-9]/g, '');
  const upper = clean.toUpperCase();
  if (ACRONYMS.has(upper)) {
    return word.replace(new RegExp(clean, 'i'), upper);
  }
  if (SPECIAL_CASES.has(upper)) {
    return word.replace(new RegExp(clean, 'i'), SPECIAL_CASES.get(upper));
  }
  if (upper === 'VS') return word.replace(/vs/i, 'vs');
  if (LOWERCASE_WORDS.has(clean.toLowerCase()) && index > 0) {
    return word.replace(new RegExp(clean, 'i'), clean.toLowerCase());
  }
  if (clean.length === 0) return word;
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  return word.replace(new RegExp(clean, 'i'), capitalized);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatSectionBody(secText) {
  if (!secText || !secText.trim()) return '';
  const trimmed = secText.trim();

  // Check if content is primarily SQL or code
  const isSql = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/i.test(trimmed);
  const isJava = /^\s*(public|private|protected|class|interface|enum|import)\b/.test(trimmed);

  if (isSql || isJava) {
    const lang = isSql ? 'language-sql' : 'language-java';
    return `<div class="code-block-wrapper"><pre><code class="${lang}">${escapeHtml(trimmed)}</code></pre></div>`;
  }

  // Split into paragraphs by blank lines
  const blocks = trimmed.split(/\n\s*\n/);
  return blocks.map(block => {
    const bTrimmed = block.trim();
    if (!bTrimmed) return '';

    // Check if code block embedded inside text
    if (/^\s*(SELECT|public|private|class)\b/i.test(bTrimmed)) {
      return `<div class="code-block-wrapper"><pre><code>${escapeHtml(bTrimmed)}</code></pre></div>`;
    }

    // Numbered list
    if (/^\d+\.\s/.test(bTrimmed)) {
      const items = bTrimmed.split(/\n(?=\d+\.\s)/).map(item => {
        const itemText = item.replace(/^\d+\.\s*/, '').trim();
        return `<li>${escapeHtml(itemText)}</li>`;
      }).join('');
      return `<ol>${items}</ol>`;
    }

    // Bullet list
    if (/^[-*•]\s/.test(bTrimmed)) {
      const items = bTrimmed.split(/\n(?=[-*•]\s)/).map(item => {
        const itemText = item.replace(/^[-*•]\s*/, '').trim();
        return `<li>${escapeHtml(itemText)}</li>`;
      }).join('');
      return `<ul>${items}</ul>`;
    }

    // Normal paragraph
    return `<p>${escapeHtml(bTrimmed.replace(/\n/g, ' '))}</p>`;
  }).filter(Boolean).join('\n');
}

export function parseConceptFile(filePath, categoryInfo) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const fileName = path.basename(filePath, '.txt');

  // Slug from filename
  const slug = fileName.toLowerCase().trim();

  // Extract raw title from first non-empty line
  let rawTitle = '';
  let lineIdx = 0;
  while (lineIdx < lines.length && !rawTitle) {
    const line = lines[lineIdx].trim();
    if (line && !/^[-=]{3,}$/.test(line)) {
      rawTitle = line;
    }
    lineIdx++;
  }

  const title = formatTitle(rawTitle || fileName.replace(/-/g, ' '));

  // Skip underline under title
  while (lineIdx < lines.length && (/^[-=]{3,}$/.test(lines[lineIdx].trim()) || lines[lineIdx].trim() === '')) {
    lineIdx++;
  }

  // Collect description / intro paragraph until first section
  const introLines = [];
  while (lineIdx < lines.length) {
    const nextLine = lines[lineIdx + 1]?.trim() || '';
    if (/^[-=]{3,}$/.test(nextLine) && lines[lineIdx].trim().length > 0) {
      break;
    }
    introLines.push(lines[lineIdx]);
    lineIdx++;
  }
  const description = introLines.join(' ').replace(/\s+/g, ' ').trim();

  // Parse sections
  const sections = [];
  const tableOfContents = [];
  const questions = [];
  let summary = description;

  while (lineIdx < lines.length) {
    const headingLine = lines[lineIdx]?.trim();
    const underline = lines[lineIdx + 1]?.trim() || '';

    if (/^[-=]{3,}$/.test(underline) && headingLine) {
      const heading = formatTitle(headingLine);
      const sectionId = slugify(heading);
      lineIdx += 2; // skip heading and underline

      const secLines = [];
      while (lineIdx < lines.length) {
        const nextUnderline = lines[lineIdx + 1]?.trim() || '';
        if (/^[-=]{3,}$/.test(nextUnderline) && lines[lineIdx].trim().length > 0) {
          break;
        }
        secLines.push(lines[lineIdx]);
        lineIdx++;
      }

      const secText = secLines.join('\n').trim();

      // Check if this is the questions section
      if (/QUESTIONS/i.test(headingLine)) {
        for (const l of secLines) {
          const match = l.trim().match(/^\d+\.\s*(.+)$/);
          if (match) questions.push(match[1].trim());
        }
      }

      // Check if this is key takeaways
      if (/TAKEAWAYS/i.test(headingLine) && secText) {
        summary = secText.replace(/\s+/g, ' ').trim();
      }

      const htmlContent = formatSectionBody(secText);

      sections.push({
        id: sectionId,
        heading,
        content: htmlContent,
        rawText: secText
      });

      tableOfContents.push({
        id: sectionId,
        title: heading
      });
    } else {
      lineIdx++;
    }
  }

  // Extract tags from title and category
  const stopWords = new Set(['and', 'or', 'the', 'in', 'to', 'a', 'an', 'for', 'with', 'on', 'at', 'from', 'by', 'is', 'what']);
  const titleWords = title.split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
  const tags = Array.from(new Set([categoryInfo.name.split(' ')[0], ...titleWords])).slice(0, 5);

  const wordCount = content.split(/\s+/).length;
  const readMinutes = Math.max(2, Math.ceil(wordCount / 175));
  const readTime = `${readMinutes} min read`;

  return {
    slug,
    category: categoryInfo.slug,
    categoryAlias: categoryInfo.alias,
    categoryName: categoryInfo.name,
    title,
    description: description || `Educational guide and technical concepts for ${title}.`,
    summary: summary || description,
    readTime,
    lastUpdated: '2026-03-01',
    tags,
    tableOfContents,
    sections,
    questions,
    isConcept: true,
    filePath
  };
}

let cachedConcepts = null;

export function loadAllConcepts(baseDir) {
  if (cachedConcepts) return cachedConcepts;

  const resolvedBaseDir = baseDir || path.resolve(process.cwd(), 'public_data');
  const articles = [];

  if (!fs.existsSync(resolvedBaseDir)) {
    cachedConcepts = [];
    return cachedConcepts;
  }

  const entries = fs.readdirSync(resolvedBaseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const catInfo = CATEGORY_MAP[entry.name];
    if (!catInfo) continue;

    const dirPath = path.join(resolvedBaseDir, entry.name);
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (!file.endsWith('.txt')) continue;
      const fullPath = path.join(dirPath, file);
      try {
        const article = parseConceptFile(fullPath, catInfo);
        articles.push(article);
      } catch (err) {
        console.error(`[KnowledgeLoader] Failed to parse ${fullPath}:`, err);
      }
    }
  }

  // Sort alphabetically by title
  articles.sort((a, b) => a.title.localeCompare(b.title));
  cachedConcepts = articles;
  return cachedConcepts;
}

export function getConceptArticles() {
  return loadAllConcepts();
}

export function getConceptArticlesByCategory(categorySlug) {
  const all = loadAllConcepts();
  return all.filter(a => a.category === categorySlug || a.categoryAlias === categorySlug);
}

export function getConceptArticle(categorySlug, articleSlug) {
  const all = loadAllConcepts();
  return all.find(a =>
    (a.category === categorySlug || a.categoryAlias === categorySlug) &&
    a.slug === articleSlug
  ) || null;
}
