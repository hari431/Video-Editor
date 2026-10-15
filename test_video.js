import { readQueryLibrary } from './src/library/local.js';
import { buildTree, findVideo } from './src/library/tree.js';
import { getFileType, isViewable, isDownloadable, requiresStreaming, getMimeType } from './src/library/file-types.js';

async function test() {
  const { files, videos, folders } = await readQueryLibrary();
  const tree = buildTree(files, videos, folders);
  
  console.log('=== Video discovery ===');
  console.log('Videos found:', videos.length);
  videos.forEach(v => {
    console.log('  -', v.path, 'type:', v.type, 'mime:', v.mimeType);
  });
  
  // Test findVideo with the actual path
  const pathValue = 'Videos/Finding Rate table & Routine Usages.mp4';
  const node = findVideo(tree, pathValue);
  console.log('\nfindVideo result:', node ? 'FOUND' : 'NOT FOUND');
  if (node) {
    console.log('  node.type:', node.type);
    console.log('  node.name:', node.name);
    console.log('  node.file.path:', node.file ? node.file.path : 'no file');
  }
  
  // Check file type
  const ext = '.mp4';
  console.log('\nextension:', ext);
  const ft = getFileType(ext);
  console.log('file type:', ft.type, ft.info);
  console.log('  viewable:', isViewable(ft.type));
  console.log('  downloadable:', isDownloadable(ft.type));
  console.log('  requiresStreaming:', requiresStreaming(ft.type));
  console.log('  mimeType:', getMimeType(ft.type));
}

test();