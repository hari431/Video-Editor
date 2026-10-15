import { stat, writeFile, mkdir } from 'node:fs/promises';
import mammoth from 'mammoth';

async function run() {
  const file = 'src/config/content-manifest.json';
  const html = `<html><body>test</body></html>`;
  console.log("mammoth installed:", typeof mammoth.convertToHtml);
}
run();
