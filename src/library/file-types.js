import path from 'node:path';

// Centralized file-type registry.
// Every discovered file gets a type from this registry.
export const fileTypeRegistry = {
  // --- TEXT ---
  text: {
    label: 'Text',
    extensions: new Set(['.txt', '.md', '.']),
    mimeTypes: new Set(['text/plain', 'text/markdown']),
    viewable: true,
    downloadable: true,
    canRenderInBrowser: false, // rendered server-side
  },

  // --- MARKDOWN ---
  markdown: {
    label: 'Markdown',
    extensions: new Set(['.md']),
    mimeTypes: new Set(['text/markdown']),
    viewable: true,
    downloadable: true,
    canRenderInBrowser: false,
  },

  // --- PDF ---
  pdf: {
    label: 'PDF',
    extensions: new Set(['.pdf']),
    mimeTypes: new Set(['application/pdf']),
    viewable: true,
    downloadable: true,
    canRenderInBrowser: true,
  },

  // --- DOCUMENT ---
  document: {
    label: 'Document',
    extensions: new Set(['.doc', '.docx']),
    mimeTypes: new Set(['application/msword', 'application/vnd.openxmlformats-officedocument.word-processingml.document']),
    viewable: true,
    downloadable: true,
    canRenderInBrowser: true,
  },

  // --- SPREADSHEET ---
  spreadsheet: {
    label: 'Spreadsheet',
    extensions: new Set(['.xls', '.xlsx', '.csv']),
    mimeTypes: new Set([
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ]),
    viewable: false,
    downloadable: true,
    canRenderInBrowser: false,
  },

  // --- PRESENTATION ---
  presentation: {
    label: 'Presentation',
    extensions: new Set(['.ppt', '.pptx']),
    mimeTypes: new Set([
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]),
    viewable: false,
    downloadable: true,
    canRenderInBrowser: false,
  },

  // --- IMAGE ---
  image: {
    label: 'Image',
    extensions: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']),
    mimeTypes: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    viewable: true,
    downloadable: true,
    canRenderInBrowser: true,
  },

  // --- VIDEO ---
  video: {
    label: 'Video',
    extensions: new Set(['.mp4', '.webm', '.mov']),
    mimeTypes: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
    viewable: true,
    downloadable: true,
    // Special: streamed, not progressive download by default
    canRenderInBrowser: true,
    requiresStreaming: true,
  },

  // --- ARCHIVE ---
  archive: {
    label: 'Archive',
    extensions: new Set(['.zip']),
    mimeTypes: new Set(['application/zip']),
    viewable: false,
    downloadable: true,
    canRenderInBrowser: false,
  },

  // --- UNKNOWN ---
  unknown: {
    label: 'Unsupported',
    extensions: new Set(),
    mimeTypes: new Set(),
    viewable: false,
    downloadable: false,
    canRenderInBrowser: false,
  },
};

// Given a file extension, return the matching file type from the registry.
// Falls back to 'unknown'.
export function getFileType(extension) {
  const ext = extension.toLowerCase();
  for (const [typeName, typeInfo] of Object.entries(fileTypeRegistry)) {
    if (typeInfo.extensions.has(ext)) {
      return { type: typeName, info: typeInfo };
    }
  }
  return { type: 'unknown', info: fileTypeRegistry.unknown };
}

// Given a filename, return the file type.
export function getFileTypeFromFilename(filename) {
  const ext = path.extname(filename);
  return getFileType(ext);
}

// Check if a file type is viewable in the browser
export function isViewable(typeName) {
  const info = fileTypeRegistry[typeName];
  return info ? info.viewable : false;
}

// Check if a file type is downloadable
export function isDownloadable(typeName) {
  const info = fileTypeRegistry[typeName];
  return info ? info.downloadable : false;
}

// Check if a file type requires streaming (video)
export function requiresStreaming(typeName) {
  const info = fileTypeRegistry[typeName];
  return info ? info.requiresStreaming : false;
}

// Get MIME type for a file type
export function getMimeType(typeName) {
  const info = fileTypeRegistry[typeName];
  return info ? [...info.mimeTypes][0] || 'application/octet-stream' : 'application/octet-stream';
}