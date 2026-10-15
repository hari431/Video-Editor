import 'dotenv/config';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { FREE_TECHNICAL_BOOKS } from '../src/free-books/data.js';

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'free-books-pdf');
const MAX_BYTES = 50 * 1024 * 1024;
const USER_AGENT = 'GosuQueryLibrary-FreeBooks/1.0';

const books = FREE_TECHNICAL_BOOKS.filter(item => item.kind === 'host' && item.slug && item.readUrl);

function assertAllowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS free-book source: ${url}`);
  }
}

async function fetchBook(book) {
  assertAllowedUrl(book.readUrl);
  const destination = path.join(OUTPUT_DIR, `${book.slug}.pdf`);

  const response = await fetch(book.readUrl, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow'
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${book.title}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/pdf(?:;|$)/i.test(contentType)) {
    throw new Error(`Refusing non-PDF response for ${book.title}: ${contentType || 'unknown content type'}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_BYTES) {
    throw new Error(`${book.title} exceeds the ${MAX_BYTES / 1024 / 1024} MB build limit.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new Error(`Invalid PDF size for ${book.title}: ${bytes.length} bytes`);
  }

  await writeFile(destination, bytes);
  return { title: book.title, slug: book.slug, bytes: bytes.length };
}

await mkdir(OUTPUT_DIR, { recursive: true });

const results = [];
for (const book of books) {
  try {
    results.push(await fetchBook(book));
  } catch (error) {
    const destination = path.join(OUTPUT_DIR, `${book.slug}.pdf`);
    try {
      const existing = await readFile(destination);
      if (existing.length > 0) {
        console.warn(`Keeping existing cached PDF for ${book.title}: ${error.message}`);
        results.push({ title: book.title, slug: book.slug, bytes: existing.length, cached: true });
        continue;
      }
    } catch {}

    await rm(destination, { force: true });
    throw error;
  }
}

console.log(`Prepared ${results.length} free technical book PDFs in ${path.relative(process.cwd(), OUTPUT_DIR)}:`);
for (const result of results) {
  const suffix = result.cached ? ' (cached)' : '';
  console.log(`- ${result.title}: ${(result.bytes / 1024 / 1024).toFixed(2)} MB${suffix}`);
}
