import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '../../queries');

async function main() {
  try {
    // 1. Create Videos directory and fixture
    const videosDir = path.join(QUERIES_DIR, 'Videos');
    await mkdir(videosDir, { recursive: true });
    await writeFile(path.join(videosDir, 'Finding Rate table & Routine Usages.mp4'), Buffer.alloc(1024 * 1024)); // 1MB dummy mp4

    // 2. Create Tutorials directory and fixture
    const tutorialsDir = path.join(QUERIES_DIR, 'Tutorials');
    await mkdir(tutorialsDir, { recursive: true });
    await writeFile(path.join(tutorialsDir, 'Finding Rate table & Routine Usages.mp4'), Buffer.alloc(1024 * 1024)); // 1MB dummy mp4

    // 3. Create Guidewire/Tutorial Videos folder
    const tutorialVideosDir = path.join(QUERIES_DIR, 'Guidewire', 'Tutorial Videos');
    await mkdir(tutorialVideosDir, { recursive: true });

    console.log('Successfully created test video fixtures and folders!');
  } catch (error) {
    console.error('Error setting up fixtures:', error);
    process.exit(1);
  }
}

main();
