import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import mammoth from "mammoth";
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pool } from './db/pool.js';
import { perfStorage, getReqId } from './utils/perf.js';
import { configurePassport } from './auth/passport.js';
import { requireApiAuth, requireAuth, requireAdmin, requireOwner, requireSameOrigin } from './auth/middleware.js';
import { isExpenseTrackerAvailable, isLocalExpenseTrackerRequest, safePasscodeEqual, parseBrokerCsv, isHistoricalMonthLocked, isFutureMonth, resetFutureMonth } from './expense-tracker/store.js';
import { readExpenseData, writeExpenseData } from './expense-tracker/db-store.js';
import { isAdminEmail, isAdminUser, isOwnerUser, getUserRole } from './auth/admin.js';
import { getAccessExpiryReminder } from './auth/access-expiry.js';
import {
  getUsersForAdmin,
  getAuditLog,
  getRoleAuditLog,
  approveUser,
  extendUserByDays,
  extendUserToDate,
  revokeUser,
  reactivateUser,
  grantAdmin,
  revokeAdmin,
  grantPremium,
  revokePremium,
  bulkGrantPremium,
  getExpiringUsers,
  bulkExtendUsers,
  bulkActivateUsers,
  bulkExtendUsersSafe,
  bulkRevokeUsers,
  logLifecycleEvent,
  hasUserActiveAccess,
  getUserHeaderStatus
} from './auth/users.js';
import { renderImageEffectsToBuffer, validateImageEffectSpec } from './library/image-effects.js';
import { readQueryLibrary, isSafeLibraryPath, resolveLibraryPath, isPathRestricted, canAccessLibraryPath, canAccessLibraryPathAsync, loadFolderPermissions, invalidatePermissionCache, getTypeDisplayName, contentRouteForPath, isExternalFileName, getExternalFriendlyName, isValidExternalUrl, extractYouTubeId, isBloggerUrl, extractDriveFileId, isDriveUrl, loadLibraryMetadata, isCompanionMetadataFilename, isHiddenCompanionOnDisk } from './library/local.js';
import { parsePinnedReferences, getPinnedForItem, stripPinnedParagraphsFromHtml } from './library/pinned.js';
import { pinReferencePath } from './library/pin-generator.js';
import { isValidShareCode, findShareTarget, getOrCreateShareCode } from './library/share-links.js';
import { createExternalVideoToken, resolveExternalVideoToken } from './library/externalTokens.js';
import { buildTree, findFile, findVideo, findExternal, folderAt, searchFiles, legacyQueryPath, filterTreeForUser, searchFilesFiltered } from './library/tree.js';
import { streamVideoFile, videoMimeType } from './library/video.js';
import { buildVideoProtectionContext, touchVideoProtectionSession, searchVideoProtectionSession, PROTECTION_EVENT_TYPES, resolveWatermarkVisible } from './library/video-protection.js';
import { getVideoBranding, setVideoBranding, resolveBrandOverlayVisible } from './library/video-branding.js';
import { getMimeType, getFileTypeFromFilename } from './library/file-types.js';
import { getLikeState, toggleLike } from './library/likes.js';
import { getRelatedContent } from './library/related.js';
import {
  getAllCategories,
  getCategory,
  getAllArticles,
  getArticlesByCategory,
  getArticle,
  searchArticles,
  getRelatedArticles,
  isPublicKnowledgeEnabled
} from './knowledge/data.js';
import {
  getQuestionKey,
  saveNote,
  getNote,
  getUserNotes,
  getUserNotesForArticle,
  getUserNotesForCategory,
  getUserNotesMap,
  deleteNote,
  getAllNotesForAdmin,
  getAdminNotesStats
} from './knowledge/notes.js';
import { FREE_TECHNICAL_BOOKS, FREE_TECHNICAL_BOOK_CATEGORIES, getFreeTechnicalBooks } from './free-books/data.js';
import { recordRecentlyViewed, getRecentlyViewed } from './library/recently-viewed.js';
import { markContentSeen, markContentIgnored, markContentsIgnored, getNewContentForUser } from './library/new-content.js';
import { getFolderProgressForUser } from './library/folder-progress.js';
import { getAnalyticsOverview } from './library/analytics.js';
import {
  hasContentPermission,
  hasNotesPermission,
  getUserContentPermissions,
  getAllContentPermissions,
  grantContentPermission,
  revokeContentPermission,
  bulkUpdateContentPermissions,
  getContentPermissionAuditLog,
  PERMISSIONS
} from './auth/content-permissions.js';
import { getRecentActivities } from './auth/recent-activity.js';
import {
  createDiscussion,
  getDiscussion,
  getDiscussionWithReplies,
  getDiscussionReplies,
  deleteDiscussionAsUser,
  deleteReplyAsUser,
  adminHideDiscussion,
  adminUnhideDiscussion,
  adminHideReply,
  adminUnhideReply,
  adminDeleteDiscussion,
  adminDeleteReply,
  adminRestoreDiscussion,
  adminRestoreReply,
  adminApproveDiscussion,
  adminApproveReply,
  listDiscussions,
  listAllDiscussionsForAdmin,
  listAllDiscussionsForAdminCount,
  adminListDiscussionReplies,
  adminListDiscussionRepliesBatch,
  getDiscussionCounts,
  getLatestModerationForTargets,
  isValidFilter,
  isValidAdminFilter,
  acceptReply,
  unacceptReply,
  getNeedsAttention,
  toggleDiscussionLike,
  toggleReplyLike
} from './library/discussions.js';
import { metricsMiddleware, recordContentAccess as recordMetricsContentAccess, recordPdfPreview, recordPdfDownload, getMetrics as getSystemMetrics, getHealth as getSystemHealth } from './monitoring/metrics.js';
import { getHealthIndicators } from './monitoring/health.js';
import { getSystemIntegrityReport } from './monitoring/integrity.js';
import { registerAdminAssistantRoutes } from './admin-assistant/router.js';
import { registerSecurityLabRoutes } from './security-lab/router.js';
import { registerNanobotRoutes } from './nanobot/router.js';
import { registerAvatarFaceReplacementRoutes } from './avatar-face-replacement/router.js';
import { flushDailyUsage, getDailyHistory, scheduleDailyFlush } from './monitoring/history.js';
import { shouldShowAdSlot } from './library/ad-slot.js';
import { loadAdSettings } from './library/ad-eligibility.js';
import { getAdsConfig, isLiveAdsEnabled } from './config/ads.js';
import { scheduleRetentionCleanup, scheduleInactiveUserCleanup } from './cleanup/scheduler.js';
import { schedulePremiumReconcile } from './auth/premium-reconcile-scheduler.js';
import { schedulePaidProductsReconcile } from './auth/paid-products-scheduler.js';
import { isLunaEnabled } from './luna/config.js';
import { isPremiumMembershipEnabled, createRazorpaySubscription, cancelRazorpaySubscription, verifyRazorpayWebhookSignature, createRazorpayOrder } from './library/razorpay.js';
import { handleSubscriptionWebhook, getSubscriptionDetailsForUser, validatePromoCode } from './auth/premium.js';
import { hasAdFreeCapability } from './library/ad-visibility.js';
import { recordOneTimePremiumPayment, getProductByCode, getPlanByCode, createPaidOrder, upsertPaidSubscription, recordPromotionRedemption } from './auth/paidProducts.js';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import {
  isVideoEditorAvailable,
  validateEditSpec,
  validateSpecV2,
  buildFfmpegArgs,
  buildScreenRecordingFfmpegArgs,
  getMultipartBoundary,
  parseMultipartForm,
  isAllowedEditorInput,
  isAllowedEditorImage,
  isAllowedEditorAudio,
  EDITOR_MAX_IMAGE_BYTES,
  EDITOR_MAX_IMAGE_FILES,
  EDITOR_MAX_AUDIO_BYTES,
  EDITOR_MAX_VIDEO_FILES,
  EDITOR_MAX_AUDIO_FILES,
  EDITOR_MAX_SPEC_BYTES,
  editorMaxVideoMb,
  editorMaxVideoBytes,
  editorMaxRequestBytes,
  EDITOR_FFMPEG_TIMEOUT_MS,
  normalizeExportResolution
} from './library/video-editor.js';
import {
  createAiVideoJobStore,
  validateAiVideoRequest,
  dispatchToWorker,
  aiVideoConfig,
  isAiVideoEnabled
} from './library/ai-video.js';
import {
  checkEdlEvidence,
  validateEdlStructure,
  allowlistedEdlSource,
  edlToSpecV2,
  edlCutSummary
} from './library/edl-evidence.js';
import {
  isPdfEditorAvailable,
  validatePdfEditSpec,
  renderPdfExport,
  isAllowedPdfInput,
  isAllowedPdfImage,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_SPEC_BYTES,
  PDF_EDITOR_MAX_FILES,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_IMAGE_BYTES,
  PDF_EDITOR_MAX_IMAGE_FILES
} from './library/pdf-editor.js';
import {
  isPdfMergeAvailable,
  validatePdfMergeSelection,
  validatePdfMergeOrder,
  mergePdfs,
  pdfMergeMaxRequestBytes,
  PDF_MERGE_MAX_FILES,
  PDF_MERGE_MAX_FILE_BYTES,
  PDF_MERGE_MAX_FILE_MB
} from './library/pdf-merge.js';
import {
  isPdfUnlockAvailable,
  validatePdfUnlockUpload,
  validatePdfUnlockPassword,
  unlockDownloadName,
  unlockPdf,
  pdfUnlockMaxRequestBytes,
  PDF_UNLOCK_MAX_FILE_BYTES,
  PDF_UNLOCK_MAX_FILE_MB
} from './library/pdf-unlock.js';
import {
  isPdfProtectAvailable,
  validatePdfProtectUpload,
  validatePdfProtectPasswords,
  protectDownloadName,
  protectPdf,
  pdfProtectMaxRequestBytes,
  PDF_PROTECT_MAX_FILE_BYTES,
  PDF_PROTECT_MAX_FILE_MB
} from './library/pdf-protect.js';
import {
  isPdfCompressAvailable,
  validatePdfCompressUpload,
  validatePdfCompressLevel,
  compressDownloadName,
  compressPdf,
  pdfCompressMaxRequestBytes,
  PDF_COMPRESS_MAX_FILE_BYTES,
  PDF_COMPRESS_MAX_FILE_MB
} from './library/pdf-compress.js';
import {
  isPdfSplitAvailable,
  validatePdfSplitUpload,
  splitPdf,
  splitPartNames,
  splitZipName,
  buildZip,
  pdfSplitMaxRequestBytes,
  PDF_SPLIT_MAX_FILE_BYTES,
  PDF_SPLIT_MAX_FILE_MB
} from './library/pdf-split.js';
import {
  isPdfImagesAvailable,
  validatePdfImagesUpload,
  validatePdfImagesOptions,
  imagesToPdf,
  imagesDownloadName,
  pdfImagesMaxRequestBytes,
  PDF_IMAGES_MAX_FILE_BYTES,
  PDF_IMAGES_MAX_FILE_MB,
  PDF_IMAGES_MAX_FILES
} from './library/pdf-images.js';
import {
  isPdfToImagesAvailable,
  validatePdfToImagesUpload,
  zipRenderedImages,
  renderedZipName,
  pdfToImagesMaxRequestBytes,
  PDF_TO_IMAGES_MAX_PART_BYTES,
  PDF_TO_IMAGES_MAX_PART_MB,
  PDF_TO_IMAGES_MAX_PARTS
} from './library/pdf-to-images.js';
import {
  isPdfRotateAvailable,
  validatePdfRotateUpload,
  validatePdfRotateAngle,
  rotateDownloadName,
  rotatePdf,
  pdfRotateMaxRequestBytes,
  PDF_ROTATE_MAX_FILE_BYTES,
  PDF_ROTATE_MAX_FILE_MB,
  PDF_ROTATE_DEFAULT_ANGLE
} from './library/pdf-rotate.js';
import {
  isPdfCropAvailable,
  validatePdfCropUpload,
  validatePdfCropMargins,
  cropDownloadName,
  cropPdf,
  pdfCropMaxRequestBytes,
  PDF_CROP_MAX_FILE_BYTES,
  PDF_CROP_MAX_FILE_MB
} from './library/pdf-crop.js';
import {
  isPdfNumbersAvailable,
  validatePdfNumbersUpload,
  validatePdfNumbersOptions,
  numbersDownloadName,
  addPageNumbers,
  pdfNumbersMaxRequestBytes,
  PDF_NUMBERS_MAX_FILE_BYTES,
  PDF_NUMBERS_MAX_FILE_MB
} from './library/pdf-page-numbers.js';
import {
  isPdfWatermarkAvailable,
  validatePdfWatermarkUpload,
  validatePdfWatermarkOptions,
  watermarkDownloadName,
  addWatermark,
  pdfWatermarkMaxRequestBytes,
  PDF_WATERMARK_MAX_FILE_BYTES,
  PDF_WATERMARK_MAX_FILE_MB
} from './library/pdf-watermark.js';
import {
  isPdfFlattenAvailable,
  validatePdfFlattenUpload,
  flattenDownloadName,
  flattenPdf,
  pdfFlattenMaxRequestBytes,
  PDF_FLATTEN_MAX_FILE_BYTES,
  PDF_FLATTEN_MAX_FILE_MB
} from './library/pdf-flatten.js';
import {
  isPdfTextAvailable,
  validatePdfTextUpload,
  textDownloadName,
  extractPdfText,
  pdfTextMaxRequestBytes,
  PDF_TEXT_MAX_FILE_BYTES,
  PDF_TEXT_MAX_FILE_MB
} from './library/pdf-text.js';
import {
  isPdfBookmarksAvailable,
  validatePdfBookmarksUpload,
  validatePdfBookmarksMode,
  parseBookmarkEntries,
  bookmarksDownloadName,
  getPdfBookmarks,
  setPdfBookmarks,
  pdfBookmarksMaxRequestBytes,
  PDF_BOOKMARKS_MAX_FILE_BYTES,
  PDF_BOOKMARKS_MAX_FILE_MB
} from './library/pdf-bookmarks.js';
import {
  isPdfSignAvailable,
  validatePdfSignUpload,
  validatePdfSignOptions,
  signDownloadName,
  signPdf,
  pdfSignMaxRequestBytes,
  PDF_SIGN_MAX_FILE_BYTES,
  PDF_SIGN_MAX_FILE_MB,
  PDF_SIGN_MAX_IMAGE_BYTES,
  PDF_SIGN_MAX_IMAGE_MB
} from './library/pdf-sign.js';
import {
  isPdfHeaderFooterAvailable,
  validatePdfHeaderFooterUpload,
  validatePdfHeaderFooterOptions,
  expandHeaderFooterTokens,
  headerFooterDownloadName,
  addHeaderFooter,
  pdfHeaderFooterMaxRequestBytes,
  PDF_HEADER_FOOTER_MAX_FILE_BYTES,
  PDF_HEADER_FOOTER_MAX_FILE_MB
} from './library/pdf-header-footer.js';
import {
  isPdfMetadataAvailable,
  validatePdfMetadataUpload,
  validatePdfMetadataFields,
  metadataDownloadName,
  getPdfMetadata,
  setPdfMetadata,
  pdfMetadataMaxRequestBytes,
  PDF_METADATA_MAX_FILE_BYTES,
  PDF_METADATA_MAX_FILE_MB
} from './library/pdf-metadata.js';
import {
  isPdfExtractImagesAvailable,
  validatePdfExtractImagesUpload,
  extractPdfImages,
  selectExtractedImages,
  extractedImageNames,
  extractedZipName,
  zipExtractedImages,
  pdfExtractImagesMaxRequestBytes,
  PDF_EXTRACT_MAX_FILE_BYTES,
  PDF_EXTRACT_MAX_FILE_MB
} from './library/pdf-extract-images.js';
import { inspectAcroFormFields } from './library/pdf-acroform-inspector.js';
import {
  getRates as getExchangeRates,
  normalizeBaseCurrency,
  POPULAR_CURRENCIES as EXCHANGE_POPULAR_CURRENCIES
} from './library/exchange-rates.js';
import {
  isFreeTvEnabled,
  hasFreeTvAccess,
  isFreeTvVisibleToUser,
  getChannels as getFreeTvChannels
} from './library/free-tv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { addDiagRoute } from '../diag_route.js';

// --- TEMPORARY PERF DIAGNOSTICS (P2 diagnostic-only) ---
// Feature flag: PERF_DIAGNOSTICS=true enables low-overhead timing logs.
// Default false = zero behavior change, no logs, no extra work.
const perfDiagnosticsEnabled = String(process.env.PERF_DIAGNOSTICS || 'false').toLowerCase() === 'true';
function perfLog(req, label, extraTimings = {}) {
  if (!perfDiagnosticsEnabled) return;
  const total = req && req._perfStart ? Date.now() - req._perfStart : 0;
  const auth = !!(req && req.isAuthenticated && req.isAuthenticated());
  const reqId = (req && req._perfReqId) ? req._perfReqId : (perfDiagnosticsEnabled ? getReqId() : '-');
  const merged = { ...(req && req._perfTimings ? req._perfTimings : {}), ...extraTimings };
  const parts = [`PERF route=${label} method=${req ? req.method : 'GET'} total=${total}ms auth=${auth} reqId=${reqId}`];
  for (const [k, v] of Object.entries(merged)) {
    // only numeric timings, no PII
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${k}=${v}ms`);
  }
  console.log(parts.join(' '));
}

const app = express();

// Expose feature visibility to EJS without exposing private configuration values.
app.locals.lunaEnabled = isLunaEnabled();
app.locals.expenseTrackerVisible = isExpenseTrackerAvailable();
app.locals.expenseTrackerLocalMode = process.env.NODE_ENV === 'development';

// Initial perf marker — low overhead, only when enabled
// Generates 4-6 char random request ID (no PII) to correlate pool queries with route
app.use((req, _res, next) => {
  if (!perfDiagnosticsEnabled) return next();
  const reqId = Math.random().toString(36).substring(2, 8).slice(0, 6);
  req._perfReqId = reqId;
  req._perfStart = Date.now();
  req._perfTimings = {};
  // Propagate via AsyncLocalStorage so pool.js can retrieve it
  return perfStorage.run({ reqId }, () => next());
});

addDiagRoute(app);

// Run migrations automatically on startup
import { runMigrations } from '../scripts/migrate.js';
if (process.env.DATABASE_URL) {
  runMigrations({ client: pool }).then(res => {
    console.log('Migrations executed successfully on startup:', res);
  }).catch(err => {
    console.error('Failed to run migrations on startup:', err);
  });
}


// Helper for Phase 8A ad-slot view context (keeps isAdVisibleForUser as single authority)
function adSlotViewContext(user, contentPath, slotId) {
  const cfg = getAdsConfig();
  const adLive = isLiveAdsEnabled();
  return {
    showAd: shouldShowAdSlot(user, contentPath),
    slotId,
    adLive,
    adClientId: cfg.clientId,
    adSlotId: (cfg.slots && cfg.slots[slotId]) ? cfg.slots[slotId] : cfg.slotId
  };
}

// Hidden folders configuration: HIDDEN_FOLDERS=Videos,Internal,Drafts
// Comma-separated, trimmed, empty values ignored. If not set, all content is visible.
const hiddenFolders = process.env.HIDDEN_FOLDERS
  ? process.env.HIDDEN_FOLDERS
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  : [];

// View deduplication window: 24 hours. A user's view of a video is only
// counted once per 24-hour window to prevent inflating the count from
// repeated refreshes or multiple browser windows.
function recordView(userId, videoPath) {
  return pool.query(
    `SELECT COUNT(*) AS cnt FROM video_views
       WHERE video_path = $1 AND user_id = $2 AND viewed_at >= NOW() - INTERVAL '24 hours'`,
    [videoPath, userId]
  ).then(result => {
    if (Number(result.rows[0].cnt) === 0) {
      return pool.query(
        `INSERT INTO video_views (video_path, user_id, viewed_at) VALUES ($1, $2, NOW())`,
        [videoPath, userId]
      );
    }
  }).catch(err => {
    console.error('Failed to record view:', err);
  });
}

// Connect-Pg-Simple session store class.
const PgSession = connectPgSimple(session);

// URL-encode a library path segment-by-segment so slashes survive encoding.
function encodeLibraryPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// An item is "in the library" if it appears in the tree (txt queries, videos)
// OR exists as a file on disk inside the queries root (pdf, docs, spreadsheets,
// images, archives, ...). Unknown or missing paths are rejected.
async function itemExistsInLibrary(pathValue) {
  const tree = await getLibrary();
  if (findVideo(tree, pathValue)) return true;
  if (findFile(tree, pathValue)) return true;
  const absPath = resolveLibraryPath(pathValue);
  if (!absPath) return false;
  try {
    const stats = await stat(absPath);
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false;
  }
}

// Strict existence check for Related Content candidates: verifies the file
// still exists on disk right now, even if the cached library tree is stale.
// (itemExistsInLibrary trusts the tree for txt/video, which would leak a
// file deleted after the last library scan.)
async function relatedExistsOnDisk(pathValue) {
  const absPath = resolveLibraryPath(pathValue);
  if (!absPath) return false;
  try {
    const stats = await stat(absPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

// Build enriched new/missed content items for display.
// Delegates eligibility to src/library/new-content.js (mtime > first_login_at,
// unseen, accessible, exists, supported; newest first, max 20). Never throws:
// failures resolve to [] so the library page still renders.
async function getEnrichedNewContent(user, tree, opts = {}) {
  try {
    if (!user || !user.id) return [];
    const libraryTree = tree || await getLibrary();
    return await getNewContentForUser(user, libraryTree, opts);
  } catch {
    return [];
  }
}

// Record both Recently Viewed (capped recency history) and New-Content seen
// state (persistent acknowledgement) on actual content access. Recently Viewed
// behavior is unchanged; seen-state is additive and never blocks rendering.
async function recordContentAccess(userId, itemPath) {
  try { await recordRecentlyViewed(userId, itemPath); } catch {}
  try { await markContentSeen(userId, itemPath); } catch {}
}

// Build enriched recently viewed items for display.
// Filters out inaccessible, missing, or unsupported items and maps to UI shape.
// Uses existing contentRouteForPath for hrefs – no new URL scheme.
// Accepts optional libraryTree to reuse already-loaded tree and avoid duplicate getLibrary() + per-row getLibrary() calls (Fix 3, Fix 2).
async function getEnrichedRecentlyViewed(user, libraryTree = null) {
  try {
    const rows = await getRecentlyViewed(user.id);
    if (!rows || rows.length === 0) return [];
    const tree = libraryTree || await getLibrary();
    const items = [];
    for (const row of rows) {
      const itemPath = row.item_path;
      if (!isSafeLibraryPath(itemPath)) continue;
      if (!canAccessLibraryPath(user, itemPath)) continue;
      // Reuse provided tree for existence check to avoid per-row getLibrary() (was itemExistsInLibrary which re-fetches tree)
      let exists = false;
      const extNode = findExternal(tree, itemPath);
      if (extNode) {
        exists = true;
      } else if (findVideo(tree, itemPath) || findFile(tree, itemPath)) {
        exists = true;
      } else {
        const absPath = resolveLibraryPath(itemPath);
        if (absPath) {
          try {
            const stats = await stat(absPath);
            exists = stats.isFile() || stats.isDirectory();
          } catch {
            exists = false;
          }
        }
      }
      if (!exists) continue;
      // External resources use friendlyName and external route
      if (extNode) {
        const hrefExt = '/external/' + encodeLibraryPath(itemPath);
        items.push({
          path: itemPath,
          name: extNode.file.friendlyName || itemPath.split('/').at(-1).replace(/^external - /i,'').trim(),
          typeLabel: 'External',
          kind: 'external',
          href: hrefExt,
          category: categoryForPath(itemPath),
          lastViewedAt: row.last_viewed_at
        });
        if (items.length >= 4) break;
        continue;
      }
      const typeInfo = getFileTypeFromFilename(itemPath.split('/').at(-1));
      if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) continue;
      let kind = typeInfo.type;
      let href;
      if (findVideo(tree, itemPath)) {
        kind = 'video';
        href = '/watch/' + encodeLibraryPath(itemPath);
      } else if (findFile(tree, itemPath)) {
        kind = 'text';
        href = '/query/' + encodeLibraryPath(itemPath);
      } else {
        href = '/item/' + encodeLibraryPath(itemPath);
      }
      items.push({
        path: itemPath,
        name: itemPath.split('/').at(-1),
        typeLabel: kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : getTypeDisplayName(typeInfo.type),
        kind,
        href,
        category: categoryForPath(itemPath),
        lastViewedAt: row.last_viewed_at
      });
      if (items.length >= 4) break;
    }
    return items;
  } catch {
    return [];
  }
}

// Request-scoped hasNotesPermission cache (Fix 4) — avoids duplicate DB query within same request.
// Not global, not persisted across requests. Stores promise strictly on req.
async function getHasNotesCached(req) {
  if (!req || !req.user) return false;
  if (req._cachedHasNotesPromise) return req._cachedHasNotesPromise;
  const p = hasNotesPermission(req.user).catch(() => false);
  req._cachedHasNotesPromise = p;
  return p;
}

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'development-only-change-me');
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});
if (perfDiagnosticsEnabled) {
  app.use((req, res, next) => {
    const t = Date.now();
    sessionMiddleware(req, res, (err) => {
      req._perfTimings = req._perfTimings || {};
      req._perfTimings.sessionMiddleware = Date.now() - t;
      next(err);
    });
  });
} else {
  app.use(sessionMiddleware);
}
configurePassport();
if (perfDiagnosticsEnabled) {
  const initMw = passport.initialize();
  const sessMw = passport.session();
  app.use((req, res, next) => {
    const t = Date.now();
    initMw(req, res, (err) => {
      req._perfTimings = req._perfTimings || {};
      req._perfTimings.passportInitialize = Date.now() - t;
      next(err);
    });
  });
  app.use((req, res, next) => {
    const t = Date.now();
    sessMw(req, res, (err) => {
      req._perfTimings = req._perfTimings || {};
      req._perfTimings.passportSession = Date.now() - t;
      if (req._perfStart) req._perfTimings.authMiddleware = Date.now() - req._perfStart;
      next(err);
    });
  });
} else {
  app.use(passport.initialize());
  app.use(passport.session());
}

// --- Optional Luna assistant (disabled unless LUNA_ENABLED=true) ---
if (isLunaEnabled()) {
  const { askLuna } = await import('./luna/agent.js');

  app.get('/luna', requireAuth, (req, res) => {
    res.render('luna/index', { user: req.user || null });
  });

  // Key-free provider/model catalog for the Beta setup UI.
  // Single source of truth stays in src/luna/model.js; never includes secrets.
  app.get('/api/luna/providers', requireApiAuth, async (_req, res) => {
    try {
      const { listProviders } = await import('./luna/model.js');
      return res.json({ ok: true, providers: listProviders() });
    } catch (error) {
      return res.status(500).json({ ok: false, error: 'Provider catalog unavailable.' });
    }
  });

  // Validate a runtime-only provider API key with a minimal provider request.
  // The key is never persisted, never logged, and never echoed back.
  // Success: { ok:true, provider, model }. Failure: { ok:false, error } (redacted).
  app.post('/api/luna/validate-key', requireApiAuth, async (req, res) => {
    const isActiveUser = req.user?.status === 'active';
    const isAdmin = req.user?.app_role === 'ADMIN' || req.user?.app_role === 'OWNER';
    if (!isActiveUser && !isAdmin) {
      return res.status(403).json({ error: 'Luna is available only to active users and admins.' });
    }
    try {
      const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'gemini';
      const model = typeof req.body?.model === 'string' ? req.body.model : '';
      const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key : '';
      if (!apiKey.trim()) return res.status(400).json({ ok: false, error: 'An API key is required.' });
      const { validateLunaConnection } = await import('./luna/agent.js');
      const result = await validateLunaConnection({ provider, model, apiKey });
      return res.json({ ok: true, provider: result.provider, model: result.model });
    } catch (error) {
      const { redactError, validationHttpStatus } = await import('./luna/model.js');
      const message = redactError(error?.message || 'Key validation failed.');
      return res.status(validationHttpStatus(message)).json({ ok: false, error: message });
    }
  });

  app.post('/api/luna/query', requireApiAuth, async (req, res) => {
    const isActiveUser = req.user?.status === 'active';
    const isAdmin = req.user?.app_role === 'ADMIN' || req.user?.app_role === 'OWNER';
    if (!isActiveUser && !isAdmin) {
      return res.status(403).json({ error: 'Luna is available only to active users and admins.' });
    }

    try {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const topK = Number.isInteger(req.body?.top_k) ? req.body.top_k : 5;
      const bodyContextPath = typeof req.body?.context_path === 'string' ? req.body.context_path.trim() : '';
      const referer = typeof req.get === 'function' ? String(req.get('referer') || '') : '';
      const contextPath = bodyContextPath || referer;
      // Runtime-only provider config: never persisted, never logged.
      const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : null;
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : null;
      const apiKey = typeof req.body?.api_key === 'string' && req.body.api_key ? req.body.api_key : null;
      const result = await askLuna({ query, history, user: req.user, topK, contextPath, provider, model, apiKey });
      return res.json(result);
    } catch (error) {
      const message = error?.message || 'Luna request failed.';
      const status = /required|exceeds the maximum|invalid/i.test(message) ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  });
}

// Reliable last_activity tracking – throttled to at most once per 24h, non-blocking
// Uses last_activity_at only (never last_login_at/updated_at/session expire). OWNER/ADMIN also tracked but excluded from deletion later.
app.use((req, _res, next) => {
  try {
    if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.id) {
      const user = req.user;
      let lastMs = 0;
      if (user.last_activity_at) {
        const d = new Date(user.last_activity_at);
        if (!Number.isNaN(d.getTime())) lastMs = d.getTime();
      }
      if (!lastMs || Date.now() - lastMs >= 24 * 60 * 60 * 1000) {
        pool.query(`UPDATE users SET last_activity_at = NOW() WHERE id = $1 AND (last_activity_at IS NULL OR last_activity_at < NOW() - INTERVAL '24 hours')`, [user.id])
          .then(r => {
            if (r && r.rowCount > 0) {
              try { user.last_activity_at = new Date(); } catch {}
            } else {
              // DB throttled (another request already updated within 24h) – still update in-memory to avoid repeat attempts
              try { if (r && r.rowCount === 0 && lastMs === 0) user.last_activity_at = new Date(); } catch {}
            }
          })
          .catch(err => {
            const msg = err && err.message ? err.message : String(err);
            if (msg.includes('last_activity_at') && msg.includes('does not exist')) return;
            console.warn(`[activity] failed to update last_activity_at user=${user.id} err=${msg}`);
          });
      }
    }
  } catch {}
  next();
});

// Load ad settings at startup
loadAdSettings().catch(err => {
  console.error('Failed to load ad settings on startup:', err);
});

// Bounded request timeout — prevents hanging requests from leaving the frontend waiting forever.
// Express will emit 'timeout' and we convert it to a controlled 503 JSON/HTML error instead of hanging.
app.use((req, res, next) => {
  req.setTimeout(15000, () => {
    if (!res.headersSent) {
      const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
      if (wantsJson) res.status(503).json({ status: 'error', message: 'Request timed out. Please try again.' });
      else res.status(503).send('Request timed out. Please try again.');
    }
  });
  res.setTimeout(15000, () => {
    if (!res.headersSent) {
      const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
      if (wantsJson) res.status(503).json({ status: 'error', message: 'Request timed out. Please try again.' });
      else res.status(503).send('Request timed out. Please try again.');
    }
  });
  next();
});

app.use(async (req, _res, next) => {
  if (!perfDiagnosticsEnabled) {
    await Promise.all([
      Promise.race([
        loadFolderPermissions(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadFolderPermissions timeout')), 4000))
      ]).catch(e => {
        console.error('loadFolderPermissions timeout/error:', e.message);
      }),
      Promise.race([
        loadAdSettings(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadAdSettings timeout')), 4000))
      ]).catch(err => {
        console.error('Failed to load ad settings in middleware:', err.message);
      })
    ]);
    return next();
  }
  const mwStart = Date.now();
  let permMs = 0, adMs = 0;
  const tPerm = Date.now();
  const tAd = Date.now();
  await Promise.all([
    Promise.race([
      loadFolderPermissions(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadFolderPermissions timeout')), 4000))
    ]).then(() => { permMs = Date.now() - tPerm; }).catch(e => {
      permMs = Date.now() - tPerm;
      console.error('loadFolderPermissions timeout/error:', e.message);
    }),
    Promise.race([
      loadAdSettings(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadAdSettings timeout')), 4000))
    ]).then(() => { adMs = Date.now() - tAd; }).catch(err => {
      adMs = Date.now() - tAd;
      console.error('Failed to load ad settings in middleware:', err.message);
    })
  ]);
  req._perfTimings = req._perfTimings || {};
  req._perfTimings.loadFolderPermissions = permMs;
  req._perfTimings.loadAdSettings = adMs;
  req._perfTimings.middleware = Date.now() - mwStart;
  next();
});

// Display-only access-expiry reminder (never authorizes anything).
// Uses only the currently authenticated user's existing access_expires_at.
// Expired/unauthenticated users get no reminder; requireAuth/requireApiAuth
// remain the sole authority on access control.
app.use((req, res, next) => {
  try {
    res.locals.accessExpiryReminder = getAccessExpiryReminder(req.user || null);
  } catch {
    res.locals.accessExpiryReminder = null;
  }
  next();
});

// DevTools UX deterrent flags – server-rendered for OWNER/ADMIN and authenticated state (used by devtools-restrict.js)
app.use((req, res, next) => {
  try {
    res.locals.isPrivileged = !!(req.user && (isOwnerUser(req.user) || isAdminUser(req.user)));
    res.locals.isAuthenticated = !!(req.user && req.isAuthenticated && req.isAuthenticated());
  } catch {
    res.locals.isPrivileged = false;
    res.locals.isAuthenticated = false;
  }
  next();
});

// Lightweight system/usage metrics — in-memory aggregates, no PII, no per-request DB writes
app.use(metricsMiddleware);

// Phase 8B: AdSense verification meta tag — sourced from ADSENSE_CLIENT_ID config, safe when missing
app.use((req, res, next) => {
  try {
    const cfg = getAdsConfig();
    res.locals.adsenseClientId = cfg.clientId || '';
  } catch {
    res.locals.adsenseClientId = '';
  }
  next();
});

app.locals.hasUserActiveAccess = hasUserActiveAccess;
app.locals.getUserHeaderStatus = getUserHeaderStatus;

// Show footer and "Connect With Us" section on public pages (Home, Login, and legal/info pages)
app.use((req, res, next) => {
  const publicFooterPaths = new Set(['/', '/login', '/about', '/privacy', '/terms', '/contact', '/pricing', '/content-policy', '/refund-policy', '/exchange-rates']);
  const isPublicFooterPage = publicFooterPaths.has(req.path);
  res.locals.showFooter = isPublicFooterPage;
  res.locals.showConnectWithUs = isPublicFooterPage;
  res.locals.paidPlansEnabled = process.env.PAID_PLANS_ENABLED === 'true';
  res.locals.knowledgeEnabled = isPublicKnowledgeEnabled();
  res.locals.user = req.user || null;
  res.locals.req = req;
  res.locals.currentUrl = req.originalUrl || req.url || '';
  res.locals.contentRouteForPath = contentRouteForPath;
  res.locals.hasUserActiveAccess = hasUserActiveAccess;
  res.locals.getUserHeaderStatus = getUserHeaderStatus;
  res.locals.hasActiveAccess = hasUserActiveAccess(req.user);
  res.locals.headerUserStatus = getUserHeaderStatus(req.user);
  // Entertainment nav visibility: kill switch AND strict Active-only access.
  // Inactive/expired/logged-out users get false (no link rendered anywhere).
  res.locals.freeTvVisible = isFreeTvVisibleToUser(req.user);
  next();
});

// Likes / My Liked Items — reuse existing effective Notes permission ONLY (no independent hasLikes flag)
// Uses request-scoped cache (Fix 4) to avoid duplicate DB query within same request
app.use(async (req, res, next) => {
  if (!perfDiagnosticsEnabled) {
    try {
      const canNotes = req.user ? await getHasNotesCached(req) : false;
      res.locals.hasNotes = canNotes;
      res.locals.hasNotesPermission = canNotes;
    } catch {
      res.locals.hasNotes = false;
      res.locals.hasNotesPermission = false;
    }
    return next();
  }
  const tHasNotes = Date.now();
  try {
    const canNotes = req.user ? await getHasNotesCached(req) : false;
    res.locals.hasNotes = canNotes;
    res.locals.hasNotesPermission = canNotes;
  } catch {
    res.locals.hasNotes = false;
    res.locals.hasNotesPermission = false;
  }
  req._perfTimings = req._perfTimings || {};
  req._perfTimings.hasNotesMiddleware = Date.now() - tHasNotes;
  next();
});

let libraryCache = { expiresAt: 0, tree: null };

async function getLibrary() {
  const seconds = Number.parseInt(process.env.LIBRARY_CACHE_SECONDS || '300', 10);
  const ttl = (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
  if (libraryCache.tree && Date.now() < libraryCache.expiresAt) return libraryCache.tree;
  const { files, videos, folders, items = [] } = await readQueryLibrary();
  libraryCache = { tree: buildTree(files, videos, folders, items), expiresAt: Date.now() + ttl };
  return libraryCache.tree;
}

export function _clearLibraryCache() {
  libraryCache = { expiresAt: 0, tree: null };
}

// v1 Pins: companion metadata files ("<stem>_1.txt" next to an existing
// "<stem>.pdf"/"<stem>.xlsx"/"<stem>.docx") must never appear as standalone
// library items. They are hidden from the tree; these guards make direct
// /query|/item|/file|/download access return 404 too (checked on disk so a
// stale library cache cannot leak them). Files without an existing target
// stay normal .txt files.
async function isBlockedCompanionRequest(pathValue) {
  try {
    if (typeof pathValue !== 'string' || !pathValue) return false;
    const base = pathValue.split('/').pop() || '';
    if (!isCompanionMetadataFilename(base)) return false;
    return await isHiddenCompanionOnDisk(pathValue);
  } catch {
    return false;
  }
}

function displayName(filename) {
  return filename.replace(/\.txt$/i, '');
}

function prettyTitle(name) {
  return name.replace(/\.[^.]+$/i, '');
}

function categoryForPath(filePath) {
  const parts = filePath.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Uncategorized';
}

function parseUserId(value) {
  if (!value || isNaN(Number(value))) throw new Error('Invalid user.');
  return String(value);
}

function escapeHtmlBasic(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
function linkifyBody(text) {
  const escaped = escapeHtmlBasic(text || '');
  // Linkify http/https URLs to external anchors that navigate normally
  // escaped is already HTML-escaped, so url is safe to use directly (avoid double-escaping)
  return escaped.replace(/https?:\/\/[^\s<]+/gi, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}
app.locals.linkifyBody = linkifyBody;

// Resolve the selected access duration from an admin form submission.
// Server-side only: the browser never supplies an expiry directly.
function resolveExpiry(body) {
  const raw = String(body.duration || '').trim();
  if (raw === 'custom') {
    const dateValue = String(body.expiry || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw new Error('Invalid expiry date.');
    const expiry = new Date(`${dateValue}T23:59:59.999Z`);
    if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
    if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
    return expiry;
  }
  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days <= 0 || days > 3650) throw new Error('Invalid access duration.');
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Parse a single YYYY-MM-DD date to end-of-day UTC and validate it is in the future.
function parseFutureExpiryDate(dateValue) {
  const raw = String(dateValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('Invalid expiry date.');
  const expiry = new Date(`${raw}T23:59:59.999Z`);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid expiry date.');
  if (expiry.getTime() <= Date.now()) throw new Error('Expiry date must be in the future.');
  return expiry;
}

// Display-level status. The database status remains pending/active/revoked;
// an active user whose expiry has passed is shown as 'expired' in the UI.
function statusDisplay(user) {
  if (!user) return 'active';
  if (user.status === 'pending') return 'pending';
  if (user.status === 'revoked') return 'revoked';
  if (user.status === 'expired') return 'expired';
  if (!user.access_expires_at || new Date(user.access_expires_at) <= new Date()) return 'expired';
  return 'active';
}

function adminError(res, error) {
  res.redirect('/admin?error=' + encodeURIComponent(error.message || 'Request failed.'));
}

function buildAdminUsersBulkRedirect(req, msg, errorMsg) {
  const valid = ['all', 'pending', 'active', 'expired', 'revoked'];
  let rawStatus = null;
  if (req.body?.status != null) rawStatus = String(req.body.status);
  else if (req.body?.filter != null) rawStatus = String(req.body.filter);
  else if (req.query?.status != null) rawStatus = String(req.query.status);
  else if (req.query?.filter != null) rawStatus = String(req.query.filter);
  else if (typeof req.get === 'function' && req.get('referer')) {
    try {
      const u = new URL(req.get('referer'));
      rawStatus = u.searchParams.get('status') || u.searchParams.get('filter');
    } catch {}
  }
  const status = rawStatus ? String(rawStatus).trim().toLowerCase() : null;
  const params = new URLSearchParams();
  if (status && valid.includes(status) && status !== 'all') params.set('status', status);
  if (msg) params.set('msg', msg);
  if (errorMsg) params.set('error', errorMsg);
  const qs = params.toString();
  return '/admin' + (qs ? '?' + qs : '') + '#users';
}

function buildAdminDiscussionsRedirect(req, msg, errorMsg) {
  const params = new URLSearchParams();
  // Preserve admin discussion context from POST body (hidden inputs) or query
  const rawFilter = String(req.body?.filter || req.query?.filter || '').trim();
  if (rawFilter && isValidAdminFilter(rawFilter) && rawFilter !== 'all') {
    params.set('filter', rawFilter);
  }
  const rawSearch = String(req.body?.search ?? req.body?.q ?? req.query?.search ?? req.query?.q ?? '').trim().slice(0, 200);
  if (rawSearch) params.set('search', rawSearch);
  const rawPage = String(req.body?.page ?? req.query?.page ?? '').trim();
  if (rawPage && /^\d+$/.test(rawPage)) {
    const n = Number.parseInt(rawPage, 10);
    if (Number.isFinite(n) && n > 1 && n <= 1000) params.set('page', String(n));
  }
  if (msg) params.set('msg', msg);
  if (errorMsg) params.set('error', errorMsg);
  const qs = params.toString();
  // Only allow same-origin admin route – no open redirect
  return '/admin/discussions' + (qs ? '?' + qs : '');
}

function buildThreadRedirect(discussionId, msg, errorMsg) {
  const params = new URLSearchParams();
  if (msg) params.set('msg', msg);
  if (errorMsg) params.set('error', errorMsg);
  const qs = params.toString();
  return `/discussions/${discussionId}` + (qs ? '?' + qs : '');
}

app.get('/health', (_req, res) => res.json({ status: 'ok', ...getSystemHealth() }));

// Phase 1 System/Usage — backend foundation for future Owner/Admin dashboard.
// Lightweight, in-memory aggregates. No Google Ads. Does not change RBAC.
// Protected: Owner/Admin only, no public API for non-admins.
app.get('/api/system/metrics', requireAuth, requireAdmin, (_req, res) => {
  res.json(getSystemMetrics());
});
app.get('/api/system/health', (_req, res) => res.json(getSystemHealth()));
// Phase 4 — persisted daily aggregates (no per-request writes, Owner/Admin only)
app.get('/api/system/history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 90);
    const history = await getDailyHistory(limit);
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

app.get('/privacy', (_req, res) => res.render('privacy'));
app.get('/terms', (_req, res) => res.render('terms'));
app.get('/contact', (_req, res) => res.render('contact'));
app.get('/pricing', (_req, res) => res.render('pricing'));
app.get('/refund-policy', (_req, res) => res.render('refund-policy'));
app.get('/cancellation-policy', (_req, res) => res.redirect(302, '/refund-policy'));
app.get('/about', (_req, res) => res.render('about'));

// --- Public Exchange Rates utility (key-free, no login required) ---
// Data source: https://github.com/fawazahmed0/exchange-api
// Primary: jsDelivr currency-api; Fallback: currency-api.pages.dev.
// The browser calls our backend endpoint; it never depends on the third party directly.
app.get('/exchange-rates', (req, res) => {
  res.render('exchange-rates', { user: req.user || null });
});

app.get('/api/exchange-rates', async (req, res) => {
  const base = normalizeBaseCurrency(req.query.base || 'usd');
  if (!base) return res.status(400).json({ ok: false, error: 'Invalid base currency.' });
  try {
    const data = await getExchangeRates(base);
    return res.json({
      ok: true,
      base: data.base,
      date: data.date,
      rates: data.rates,
      source: data.source,
      cached: !!data.cached,
      popular: EXCHANGE_POPULAR_CURRENCIES
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Exchange-rate service unavailable.' });
  }
});

// --- Entertainment (Free-TV) API — Active-only, kill-switched, metadata-only ---
// Data source: https://github.com/Free-TV/IPTV (playlist metadata only).
// Render never proxies video bytes: the browser plays the third-party HTTPS
// HLS URL directly. No DB, no history, no grants, no payment changes.
// Strict guard (deliberately NOT requireApiAuth): expired users stay denied
// even when EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED=true.
const requireFreeTvApiAuth = (req, res, next) => {
  if (!isFreeTvEnabled()) {
    return res.status(404).json({ ok: false, error: 'Not found.' });
  }
  if (!req.isAuthenticated?.() || !req.user) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }
  if (!hasFreeTvAccess(req.user)) {
    return res.status(403).json({ ok: false, error: 'Entertainment is available only to users with active access.' });
  }
  next();
};

function normalizeFreeTvFilter(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > 80 ? text.slice(0, 80).trim() : text;
}

app.get('/api/entertainment/channels', requireFreeTvApiAuth, async (req, res) => {
  try {
    const data = await getFreeTvChannels();
    const country = normalizeFreeTvFilter(req.query.country).toLowerCase();
    const search = normalizeFreeTvFilter(req.query.search).toLowerCase();
    let channels = data.channels;
    if (country) channels = channels.filter(c => c.group.toLowerCase() === country);
    if (search) channels = channels.filter(c => c.name.toLowerCase().includes(search));
    return res.json({
      ok: true,
      count: channels.length,
      total: data.count,
      groups: data.groups,
      channels,
      fetchedAt: data.fetchedAt,
      source: data.source,
      cached: !!data.cached,
      stale: !!data.stale
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Entertainment service unavailable.' });
  }
});

// Entertainment page — same strict visibility as the API: kill switch AND
// Active-only access. Logged-out users go to /login; disabled or inactive
// users get a generic 404 so the surface stays invisible to them.
// The page carries no stream data: the browser loads channel metadata from
// GET /api/entertainment/channels and plays the third-party HTTPS HLS URL
// directly. Render never proxies video bytes.
app.get('/entertainment', (req, res) => {
  if (!isFreeTvEnabled()) {
    return res.status(404).render('error', { message: 'Page not found.' });
  }
  if (!req.isAuthenticated?.() || !req.user) {
    return res.redirect(302, '/login');
  }
  if (!hasFreeTvAccess(req.user)) {
    return res.status(404).render('error', { message: 'Page not found.' });
  }
  res.render('entertainment', { user: req.user || null });
});

// Curated free technical books/resources. Public, read-only, licence-aware catalog.
// Prefer PDFs fetched into the deployment during build; never accept arbitrary remote URLs.
app.get('/free-books/read/:slug', async (req, res, next) => {
  try {
    const book = FREE_TECHNICAL_BOOKS.find(item => item.kind === 'host' && item.slug === req.params.slug && item.readUrl);
    if (!book) return res.status(404).render('error', { message: 'Book reader is unavailable for this resource.' });

    const localPdf = path.join(process.cwd(), 'public', 'free-books-pdf', `${book.slug}.pdf`);
    if (existsSync(localPdf)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(localPdf);
    }

    // Development/failure fallback: preserve the existing allowlisted reader if a build
    // artifact is unavailable. The URL still comes only from the curated catalog.
    const upstream = await fetch(book.readUrl, {
      headers: { 'User-Agent': 'GosuQueryLibrary-FreeBooks/1.0' },
      redirect: 'follow'
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).render('error', { message: 'The book source is temporarily unavailable.' });
    }

    const contentType = upstream.headers.get('content-type') || 'application/pdf';
    if (!/^application\/pdf(?:;|$)/i.test(contentType)) {
      return res.status(502).render('error', { message: 'The configured book source did not return a PDF.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.get('/free-books', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const kind = typeof req.query.kind === 'string' ? req.query.kind.trim().toLowerCase() : '';
  const books = getFreeTechnicalBooks({ category, kind: ['host', 'link'].includes(kind) ? kind : '' });
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const canonicalUrl = `${proto}://${host}/free-books`;
  res.render('free-books', {
    user: req.user || null,
    books,
    categories: FREE_TECHNICAL_BOOK_CATEGORIES,
    selectedCategory: category,
    selectedKind: ['host', 'link'].includes(kind) ? kind : '',
    canonicalUrl
  });
});
app.get('/content-policy', (_req, res) => res.render('content-policy'));
app.get('/copyright', (_req, res) => res.redirect(302, '/content-policy'));

// --- Public Knowledge Base Routes (Public, Read-Only, Search-Engine Crawlable) ---

// Feature gate: governed strictly by PUBLIC_KNOWLEDGE_ENABLED
const requirePublicKnowledge = (req, res, next) => {
  if (!isPublicKnowledgeEnabled()) {
    return res.status(404).render('error', {
      message: 'Knowledge Base is currently unavailable.'
    });
  }
  next();
};

app.use('/knowledge', requirePublicKnowledge);

// 1. Knowledge Base Landing
app.get('/knowledge', (req, res) => {
  const categories = getAllCategories().map(cat => ({
    ...cat,
    articleCount: getArticlesByCategory(cat.slug).length
  }));
  const articles = getAllArticles();
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const canonicalUrl = `${proto}://${host}/knowledge`;

  res.render('knowledge/index', {
    user: req.user || null,
    categories,
    articles,
    canonicalUrl
  });
});

// 2. Search across knowledge articles (GET only, read-only)
app.get('/knowledge/search', (req, res) => {
  const query = (req.query.q || '').toString().trim();
  const results = searchArticles(query);
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const canonicalUrl = `${proto}://${host}/knowledge/search?q=${encodeURIComponent(query)}`;

  res.render('knowledge/search', {
    user: req.user || null,
    query,
    results,
    canonicalUrl
  });
});

// 3. Knowledge Base Category List
app.get('/knowledge/:category', async (req, res, next) => {
  const categorySlug = req.params.category;
  const category = getCategory(categorySlug);
  if (!category) {
    return next();
  }

  const articles = getArticlesByCategory(categorySlug);
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const canonicalUrl = `${proto}://${host}/knowledge/${encodeURIComponent(categorySlug)}`;

  let hasNotes = false;
  let userNotes = {};
  if (req.user && req.user.id) {
    try {
      hasNotes = await hasNotesPermission(req.user);
      if (hasNotes) {
        userNotes = await getUserNotesMap(req.user.id, { categorySlug });
      }
    } catch {
      userNotes = {};
      hasNotes = false;
    }
  }

  res.render('knowledge/category', {
    user: req.user || null,
    category,
    articles,
    userNotes,
    hasNotes,
    getQuestionKey,
    canonicalUrl
  });
});

// 4. Knowledge Base Individual Article — duplicate consolidation (AdSense remediation)
// Short public_data articles that are subsets of curated long-forms redirect to canonical long-form.
// Safest: 301 to curated, remove duplicate URLs from sitemap, keep source files private but not indexed.
const KNOWLEDGE_CANONICAL_REDIRECTS = {
  'java/abstraction-and-interfaces': 'java/java-oop-principles',
  'java/encapsulation': 'java/java-oop-principles',
  'java/polymorphism': 'java/java-oop-principles',
  'java/inheritance': 'java/java-oop-principles',
  'java/collections-framework': 'java/java-collections-framework',
  'java/multithreading': 'java/java-multithreading-concurrency',
  'java/solid-principles': 'programming-concepts/solid-design-principles',
  'sql/joins': 'sql/sql-joins-deep-dive',
  'sql/window-functions': 'sql/sql-window-functions',
  'sql/transactions-and-acid': 'sql/sql-transactions-acid-isolation',
  'sql/isolation-levels': 'sql/sql-transactions-acid-isolation',
  'sql/aggregate-functions': 'sql/group-by-and-having',
  'java/operators-and-expressions': 'java/variables-and-data-types',
  'sql/constraints': 'sql/database-normalization'
};

app.get('/knowledge/:category/:slug', async (req, res, next) => {
  const { category: categorySlug, slug: articleSlug } = req.params;
  const dupKey = `${categorySlug}/${articleSlug}`.toLowerCase();
  const dupTarget = KNOWLEDGE_CANONICAL_REDIRECTS[dupKey];
  if (dupTarget) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    return res.redirect(301, `${proto}://${host}/knowledge/${dupTarget}`);
  }
  const category = getCategory(categorySlug);
  if (!category) {
    return next();
  }

  const article = getArticle(categorySlug, articleSlug);
  if (!article) {
    return next();
  }

  const relatedArticles = getRelatedArticles(categorySlug, articleSlug, 3);
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const canonicalUrl = `${proto}://${host}/knowledge/${encodeURIComponent(categorySlug)}/${encodeURIComponent(articleSlug)}`;

  let hasNotes = false;
  let userNotes = {};
  if (req.user && req.user.id) {
    try {
      hasNotes = await hasNotesPermission(req.user);
      if (hasNotes) {
        userNotes = await getUserNotesMap(req.user.id, { articleSlug });
      }
    } catch {
      userNotes = {};
      hasNotes = false;
    }
  }

  res.render('knowledge/article', {
    user: req.user || null,
    article,
    category,
    relatedArticles,
    userNotes,
    hasNotes,
    getQuestionKey,
    canonicalUrl
  });
});

// 4b. Private Learner Notes Endpoints
const handleSaveNote = async (req, res) => {
  try {
    const canNotes = await hasNotesPermission(req.user);
    if (!canNotes) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ status: 'error', success: false, message: 'Notes permission required.' });
      }
      return res.status(403).render('error', { message: 'You do not have permission to manage private notes.' });
    }

    const { questionKey, contentKey, itemPath, categorySlug, articleSlug, questionIndex, questionText, title, noteText, returnTo, contentType } = req.body;
    const targetKey = String(contentKey || questionKey || itemPath || '').trim();

    // If saving a note for a library item/file, verify the user has access to that content
    if (itemPath || (targetKey && !targetKey.includes('/q') && !categorySlug && !articleSlug)) {
      const pathToCheck = itemPath || targetKey;
      if (isSafeLibraryPath(pathToCheck)) {
        const canAccess = await canAccessLibraryPathAsync(req.user, pathToCheck);
        if (!canAccess) {
          if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ status: 'error', success: false, message: 'Content is not accessible.' });
          }
          return res.status(403).render('error', { message: 'Content is not accessible.' });
        }
      }
    }

    const note = await saveNote({
      userId: req.user.id,
      questionKey,
      contentKey: targetKey,
      itemPath,
      categorySlug,
      articleSlug,
      questionIndex,
      questionText,
      title,
      noteText,
      contentType
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ status: 'success', success: true, note });
    }
    let target = (returnTo && typeof returnTo === 'string' && returnTo.startsWith('/')) ? returnTo : '';
    if (!target) {
      if (itemPath || (targetKey && !targetKey.includes('/q') && !categorySlug && !articleSlug)) {
        const p = itemPath || targetKey;
        target = contentRouteForPath(p) + p.split('/').map(encodeURIComponent).join('/');
      } else if (categorySlug && articleSlug) {
        target = `/knowledge/${encodeURIComponent(categorySlug)}/${encodeURIComponent(articleSlug)}`;
        if (targetKey) {
          target += `#iqn-${targetKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        }
      } else if (categorySlug) {
        target = `/knowledge/${encodeURIComponent(categorySlug)}`;
      } else {
        target = '/';
      }
    }
    res.redirect(target);
  } catch (err) {
    const statusCode = err.status || 400;
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(statusCode).json({ status: 'error', success: false, message: err.message });
    }
    const fallbackTarget = (req.body.returnTo && typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/')) 
      ? req.body.returnTo 
      : (req.body.itemPath ? (contentRouteForPath(req.body.itemPath) + req.body.itemPath.split('/').map(encodeURIComponent).join('/')) : '/');
    res.redirect(fallbackTarget);
  }
};

const handleDeleteNote = async (req, res) => {
  try {
    const canNotes = await hasNotesPermission(req.user);
    if (!canNotes) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ status: 'error', success: false, message: 'Notes permission required.' });
      }
      return res.status(403).render('error', { message: 'You do not have permission to manage private notes.' });
    }

    const { questionKey, contentKey, itemPath, id, returnTo, categorySlug, articleSlug } = req.body;
    const cleanKey = String(contentKey || questionKey || itemPath || '').trim();
    const result = await deleteNote(req.user.id, { id, questionKey: cleanKey, contentKey: cleanKey, itemPath });
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ status: 'success', success: true, deleted: result.deleted });
    }
    let target = (returnTo && typeof returnTo === 'string' && returnTo.startsWith('/')) ? returnTo : '';
    if (!target) {
      if (itemPath || (cleanKey && !cleanKey.includes('/q') && !categorySlug && !articleSlug)) {
        const p = itemPath || cleanKey;
        target = contentRouteForPath(p) + p.split('/').map(encodeURIComponent).join('/');
      } else if (categorySlug && articleSlug) {
        target = `/knowledge/${encodeURIComponent(categorySlug)}/${encodeURIComponent(articleSlug)}`;
      } else if (categorySlug) {
        target = `/knowledge/${encodeURIComponent(categorySlug)}`;
      } else {
        target = '/';
      }
    }
    res.redirect(target);
  } catch (err) {
    const statusCode = err.status || 400;
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(statusCode).json({ status: 'error', success: false, message: err.message });
    }
    const fallbackTarget = (req.body.returnTo && typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/')) 
      ? req.body.returnTo 
      : (req.body.itemPath ? (contentRouteForPath(req.body.itemPath) + req.body.itemPath.split('/').map(encodeURIComponent).join('/')) : '/');
    res.redirect(fallbackTarget);
  }
};

app.post('/knowledge/notes', requireAuth, handleSaveNote);
app.post('/notes', requireAuth, handleSaveNote);
app.post('/knowledge/notes/delete', requireAuth, handleDeleteNote);
app.post('/notes/delete', requireAuth, handleDeleteNote);

// REST API for Learner Notes
const handleApiGetNotes = async (req, res) => {
  try {
    const canNotes = await hasNotesPermission(req.user);
    if (!canNotes) {
      return res.status(403).json({ status: 'error', success: false, message: 'Notes permission required.' });
    }

    const { questionKey, contentKey, itemPath, articleSlug, categorySlug } = req.query;
    const cleanKey = String(contentKey || questionKey || itemPath || '').trim();

    if (cleanKey) {
      if (itemPath || (!questionKey && !cleanKey.includes('/q'))) {
        const pathToCheck = itemPath || cleanKey;
        if (isSafeLibraryPath(pathToCheck)) {
          const canAccess = await canAccessLibraryPathAsync(req.user, pathToCheck);
          if (!canAccess) {
            return res.status(403).json({ status: 'error', success: false, message: 'Content is not accessible.' });
          }
        }
      }
      const note = await getNote(req.user.id, cleanKey);
      return res.json({ status: 'success', note });
    }
    if (articleSlug) {
      const notes = await getUserNotesForArticle(req.user.id, articleSlug);
      return res.json({ status: 'success', notes });
    }
    if (categorySlug) {
      const notes = await getUserNotesForCategory(req.user.id, categorySlug);
      return res.json({ status: 'success', notes });
    }
    const notes = await getUserNotes(req.user.id);
    res.json({ status: 'success', notes });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};

const handleApiSaveNote = async (req, res) => {
  try {
    const canNotes = await hasNotesPermission(req.user);
    if (!canNotes) {
      return res.status(403).json({ status: 'error', success: false, message: 'Notes permission required.' });
    }

    const { questionKey, contentKey, itemPath, categorySlug, articleSlug, questionIndex, questionText, title, noteText, contentType } = req.body;
    const cleanKey = String(contentKey || questionKey || itemPath || '').trim();

    if (itemPath || (cleanKey && !cleanKey.includes('/q') && !categorySlug && !articleSlug)) {
      const pathToCheck = itemPath || cleanKey;
      if (isSafeLibraryPath(pathToCheck)) {
        const canAccess = await canAccessLibraryPathAsync(req.user, pathToCheck);
        if (!canAccess) {
          return res.status(403).json({ status: 'error', success: false, message: 'Content is not accessible.' });
        }
      }
    }

    const note = await saveNote({
      userId: req.user.id,
      questionKey,
      contentKey: cleanKey,
      itemPath,
      categorySlug,
      articleSlug,
      questionIndex,
      questionText,
      title,
      noteText,
      contentType
    });
    res.json({ status: 'success', success: true, note });
  } catch (err) {
    res.status(400).json({ status: 'error', success: false, message: err.message });
  }
};

const handleApiDeleteNote = async (req, res) => {
  try {
    const canNotes = await hasNotesPermission(req.user);
    if (!canNotes) {
      return res.status(403).json({ status: 'error', success: false, message: 'Notes permission required.' });
    }

    const { questionKey, contentKey, itemPath, id } = { ...(req.query || {}), ...(req.body || {}), ...(req.params || {}) };
    const cleanKey = String(contentKey || questionKey || itemPath || '').trim();
    const result = await deleteNote(req.user.id, { id, questionKey: cleanKey, contentKey: cleanKey, itemPath });
    res.json({ status: 'success', success: true, deleted: result.deleted });
  } catch (err) {
    res.status(400).json({ status: 'error', success: false, message: err.message });
  }
};

app.get('/api/interview-notes', requireApiAuth, handleApiGetNotes);
app.get('/api/notes', requireApiAuth, handleApiGetNotes);
app.post('/api/interview-notes', requireApiAuth, handleApiSaveNote);
app.post('/api/notes', requireApiAuth, handleApiSaveNote);
app.delete('/api/interview-notes/:id', requireApiAuth, handleApiDeleteNote);
app.delete('/api/notes/:id', requireApiAuth, handleApiDeleteNote);
app.delete('/api/interview-notes', requireApiAuth, handleApiDeleteNote);
app.delete('/api/notes', requireApiAuth, handleApiDeleteNote);

app.get('/api/admin/interview-notes', requireApiAuth, requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const notes = await getAllNotesForAdmin({ limit, offset });
    const stats = await getAdminNotesStats();
    res.json({ status: 'success', notes, stats });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});
app.get('/api/admin/notes', requireApiAuth, requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const notes = await getAllNotesForAdmin({ limit, offset });
    const stats = await getAdminNotesStats();
    res.json({ status: 'success', notes, stats });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 4b. Ads.txt for AdSense verification (public, no auth)
app.get('/ads.txt', (_req, res) => {
  res.type('text/plain').send('google.com, pub-7858693637239882, DIRECT, f08c47fec0942fa0');
});

// 5. Robots.txt for Search Engines
app.get('/robots.txt', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const sitemapUrl = `${proto}://${host}/sitemap.xml`;
  const knowledgeAllowed = isPublicKnowledgeEnabled();

  const robots = [
    'User-agent: *',
    'Allow: /',
    ...(knowledgeAllowed ? ['Allow: /knowledge'] : []),
    'Allow: /about',
    'Allow: /contact',
    'Allow: /pricing',
    'Allow: /content-policy',
    'Allow: /privacy',
    'Allow: /terms',
    'Allow: /refund-policy',
    'Disallow: /admin',
    'Disallow: /my',
    'Disallow: /watch',
    'Disallow: /query',
    'Disallow: /item',
    'Disallow: /browse',
    'Disallow: /api',
    'Disallow: /account',
    'Disallow: /login',
    'Disallow: /auth',
    ...(!knowledgeAllowed ? ['Disallow: /knowledge'] : []),
    '',
    `Sitemap: ${sitemapUrl}`
  ].join('\n');

  res.type('text/plain').send(robots);
});

// 6. Sitemap.xml for Search Engines
app.get('/sitemap.xml', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const baseUrl = `${proto}://${host}`;
  const knowledgeAllowed = isPublicKnowledgeEnabled();

  const staticUrls = [
    { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'daily' },
    ...(knowledgeAllowed ? [{ loc: `${baseUrl}/knowledge`, priority: '0.9', changefreq: 'daily' }] : []),
    { loc: `${baseUrl}/about`, priority: '0.6', changefreq: 'monthly' },
    { loc: `${baseUrl}/contact`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${baseUrl}/pricing`, priority: '0.7', changefreq: 'weekly' },
    { loc: `${baseUrl}/content-policy`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${baseUrl}/privacy`, priority: '0.3', changefreq: 'yearly' },
    { loc: `${baseUrl}/terms`, priority: '0.3', changefreq: 'yearly' },
    { loc: `${baseUrl}/refund-policy`, priority: '0.3', changefreq: 'yearly' }
  ];

  const categoryUrls = knowledgeAllowed ? getAllCategories().map(cat => ({
    loc: `${baseUrl}/knowledge/${cat.slug}`,
    priority: '0.8',
    changefreq: 'weekly'
  })) : [];

  const articleUrls = knowledgeAllowed ? getAllArticles()
    .filter(art => {
      const key = `${art.category}/${art.slug}`.toLowerCase();
      return !KNOWLEDGE_CANONICAL_REDIRECTS[key];
    })
    .map(art => ({
      loc: `${baseUrl}/knowledge/${art.category}/${art.slug}`,
      lastmod: art.lastUpdated,
      priority: '0.8',
      changefreq: 'monthly'
    })) : [];

  const allUrls = [...staticUrls, ...categoryUrls, ...articleUrls];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...allUrls.map(u => {
      let item = '  <url>\n';
      item += `    <loc>${u.loc}</loc>\n`;
      if (u.lastmod) item += `    <lastmod>${u.lastmod}</lastmod>\n`;
      if (u.changefreq) item += `    <changefreq>${u.changefreq}</changefreq>\n`;
      if (u.priority) item += `    <priority>${u.priority}</priority>\n`;
      item += '  </url>';
      return item;
    }),
    '</urlset>'
  ].join('\n');

  res.type('application/xml').send(xml);
});

// --- Premium Membership Routes (Phase 1 Infrastructure) ---

app.get('/premium', requireAuth, async (req, res) => {
  try {
    const enabled = isPremiumMembershipEnabled();
    const details = await getSubscriptionDetailsForUser(req.user.id);
    const premiumMonthlyAmount = parseInt(process.env.PREMIUM_MONTHLY_AMOUNT_INR || '300', 10);
    const premiumOneTimeAmount = parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10);
    const premiumCurrency = process.env.PREMIUM_CURRENCY || 'INR';
    const premiumAccessDays = parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
    
    // Fetch active promotions that can be displayed on payment screen for PREMIUM product
    let activePromotions = [];
    try {
      const promoQuery = `
        SELECT p.*, prod.name as product_name, prod.code as product_code
        FROM paid_product_promotions p
        JOIN paid_products prod ON p.product_id = prod.id
        WHERE prod.code = 'PREMIUM'
          AND (p.show_on_payment_screen = TRUE OR p.show_on_payment_screen IS NULL)
          AND p.is_enabled = TRUE
        ORDER BY p.code ASC
      `;
      const promoRes = await pool.query(promoQuery);
      const candidates = promoRes.rows;

      // UI-only: fetch current user's already-redeemed promotions to hide them from Available One-Time Offers
      let userRedeemedIds = new Set();
      let userRedeemedCodes = new Set();
      try {
        const redeemedIdsRes = await pool.query('SELECT promotion_id FROM paid_product_promo_redemptions WHERE user_id = $1', [req.user.id]);
        for (const r of redeemedIdsRes.rows) if (r.promotion_id != null) userRedeemedIds.add(Number(r.promotion_id));
      } catch {}
      try {
        const redeemedCodesRes = await pool.query('SELECT promotion_code FROM premium_promo_redemptions WHERE user_id = $1', [req.user.id]);
        for (const r of redeemedCodesRes.rows) if (r.promotion_code) userRedeemedCodes.add(String(r.promotion_code).toUpperCase());
      } catch {}

      const now = new Date();
      for (const promo of candidates) {
        // Evaluate timing windows consistently with validateProductPromotion
        if (promo.valid_from && new Date(promo.valid_from) > now) {
          continue;
        }
        if (promo.valid_until) {
          const validUntilDate = new Date(promo.valid_until);
          if (typeof promo.valid_until === 'string' && promo.valid_until.length === 10) {
            validUntilDate.setHours(23, 59, 59, 999);
          } else if (validUntilDate.getHours() === 0 && validUntilDate.getMinutes() === 0 && validUntilDate.getSeconds() === 0) {
            validUntilDate.setHours(23, 59, 59, 999);
          }
          if (validUntilDate < now) {
            continue;
          }
        }

        // Evaluate redemption limit consistently with validateProductPromotion
        if (promo.max_redemptions && promo.max_redemptions > 0) {
          const countRes = await pool.query(
            'SELECT COUNT(*)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_id = $1',
            [promo.id]
          );
          if (countRes.rows[0].count >= promo.max_redemptions) {
            continue;
          }
        }

        // Hide promotions the current user has already redeemed (UI only, no validation change)
        if (userRedeemedIds.has(Number(promo.id)) || userRedeemedCodes.has(String(promo.code).toUpperCase())) {
          continue;
        }

        activePromotions.push(promo);
      }

      // Also check PREMIUM_PROMO_CODES_JSON fallback env variable
      const { getPromoCodes } = await import('./auth/premium.js');
      const envPromos = getPromoCodes();
      for (const envPromo of envPromos) {
        if (envPromo.enabled === false || envPromo.showOnPaymentScreen === false) {
          continue;
        }
        if (activePromotions.some(p => p.code.toUpperCase() === envPromo.code.toUpperCase())) {
          continue;
        }
        if (envPromo.maxRedemptions && envPromo.maxRedemptions > 0) {
          const totalRes = await pool.query(
            'SELECT COUNT(*)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_code = $1',
            [envPromo.code]
          );
          const count = parseInt(totalRes.rows[0].count, 10);
          if (count >= envPromo.maxRedemptions) {
            continue;
          }
        }
        // Hide env promos already redeemed by this user (UI only)
        if (userRedeemedCodes.has(String(envPromo.code).toUpperCase())) {
          continue;
        }
        activePromotions.push({
          code: envPromo.code,
          discount_type: envPromo.type || 'percentage',
          discount_value: envPromo.value || 0,
          product_code: 'PREMIUM'
        });
      }
    } catch (promoErr) {
      console.error('Error fetching active promotions for premium page:', promoErr);
    }
    
    let hasNotesPrem = false;
    try { hasNotesPrem = await hasNotesPermission(req.user); } catch { hasNotesPrem = false; }
    res.render('premium', {
      enabled,
      subscription: details,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
      premiumMonthlyAmount,
      premiumOneTimeAmount,
      premiumCurrency,
      premiumAccessDays,
      activePromotions,
      hasNotes: hasNotesPrem,
      successMessage: req.query.success === 'true' ? 'Your premium membership has been successfully initialized! Verification is running in the background.' : null,
      errorMessage: null
    });
  } catch (err) {
    let hasNotesPremErr = false;
    try { hasNotesPremErr = await hasNotesPermission(req.user); } catch { hasNotesPremErr = false; }
    res.render('premium', {
      user: req.user,
      enabled: isPremiumMembershipEnabled(),
      subscription: null,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
      premiumMonthlyAmount: parseInt(process.env.PREMIUM_MONTHLY_AMOUNT_INR || '300', 10),
      premiumOneTimeAmount: parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10),
      premiumCurrency: process.env.PREMIUM_CURRENCY || 'INR',
      premiumAccessDays: parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10),
      activePromotions: [],
      hasNotes: hasNotesPremErr,
      successMessage: null,
      errorMessage: err.message
    });
  }
});

// GET /account - Customer-Facing My Access Page
app.get('/account', requireAuth, async (req, res, next) => {
  try {
    const { pool } = await import('./db/pool.js');
    
    // Fetch all generic grants (both active and expired) to keep duplicate purchase/grant history intact
    // but show each clearly without deleting historical records
    const grantsRes = await pool.query(
      `SELECT g.id, g.valid_until, g.status, p.name as product_name, p.code as product_code,
              pl.name as plan_name, pl.billing_type
       FROM user_product_grants g
       JOIN paid_products p ON g.product_id = p.id
       LEFT JOIN paid_product_plans pl ON g.plan_id = pl.id
       WHERE g.user_id = $1 
       ORDER BY 
         CASE WHEN g.status = 'active' AND (g.valid_until IS NULL OR g.valid_until > NOW()) THEN 0 ELSE 1 END ASC,
         g.created_at DESC`,
      [req.user.id]
    );
    let allProducts = grantsRes.rows;
    let hasNotesAcc = false;
    try { hasNotesAcc = await hasNotesPermission(req.user); } catch { hasNotesAcc = false; }

    res.render("account", { user: req.user, allProducts, hasNotes: hasNotesAcc });
  } catch (err) {
    next(err);
  }
});
// GET /plans - Customer-Facing Paid Products Catalog
app.get('/plans', requireAuth, async (req, res, next) => {
  try {
    const paidPlansEnabled = process.env.PAID_PLANS_ENABLED === 'true';
    if (!paidPlansEnabled && !isAdminUser(req.user)) {
      return res.status(403).render('error', { message: 'Available plans catalog is currently disabled.' });
    }

    const { pool } = await import('./db/pool.js');
    const { validateUserEntitlement } = await import('./auth/paidProducts.js');

    // Fetch enabled products
    const productsRes = await pool.query(
      `SELECT id, code, name, description, max_active_members FROM paid_products WHERE is_enabled = true ORDER BY name`
    );
    const products = productsRes.rows;

    const { countUniqueActiveProductMembers } = await import('./auth/paidProducts.js');

    // Fetch active plans for each product
    for (const prod of products) {
      const plansRes = await pool.query(
        `SELECT id, product_id, code, name, billing_type, price_amount_paise, currency, duration_days, razorpay_plan_id 
         FROM paid_product_plans 
         WHERE product_id = $1 AND is_active = true 
         ORDER BY price_amount_paise ASC`,
        [prod.id]
      );
      prod.plans = plansRes.rows;

      const activeCount = await countUniqueActiveProductMembers(prod.id, pool);
      prod.atCapacity = (prod.max_active_members !== null && activeCount >= prod.max_active_members);

      // Check current entitlement status for this product
      const entitlement = await validateUserEntitlement(req.user.id, prod.id, pool);
      prod.entitlement = entitlement;
      // Detect pending cancellation (active + cancel_at_period_end pending) for resume UI — includes created with NULL period
      try {
        const pendingRes = await pool.query(
          `SELECT provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('active','authenticated','created') AND cancel_at_period_end=TRUE AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1`,
          [req.user.id, prod.id]
        );
        prod.pendingCancellation = pendingRes.rows[0] || null;
      } catch { prod.pendingCancellation = null; }
    }

    // Fetch active promotions that can be displayed on payment screen
    let activePromotions = [];
    try {
      const promoQuery = `
        SELECT p.*, prod.name as product_name, prod.code as product_code
        FROM paid_product_promotions p
        JOIN paid_products prod ON p.product_id = prod.id
        WHERE p.show_on_payment_screen = TRUE
          AND p.is_enabled = TRUE
        ORDER BY p.code ASC
      `;
      const promoRes = await pool.query(promoQuery);
      const candidates = promoRes.rows;

      // UI-only: fetch current user's already-redeemed promotion IDs to hide them from Available One-Time Offers
      let userRedeemedIdsPlans = new Set();
      try {
        const redeemedRes = await pool.query('SELECT promotion_id FROM paid_product_promo_redemptions WHERE user_id = $1', [req.user.id]);
        for (const r of redeemedRes.rows) if (r.promotion_id != null) userRedeemedIdsPlans.add(Number(r.promotion_id));
      } catch {}

      const now = new Date();
      for (const promo of candidates) {
        if (promo.valid_from && new Date(promo.valid_from) > now) {
          continue;
        }
        if (promo.valid_until) {
          const validUntilDate = new Date(promo.valid_until);
          if (typeof promo.valid_until === 'string' && promo.valid_until.length === 10) {
            validUntilDate.setHours(23, 59, 59, 999);
          } else if (validUntilDate.getHours() === 0 && validUntilDate.getMinutes() === 0 && validUntilDate.getSeconds() === 0) {
            validUntilDate.setHours(23, 59, 59, 999);
          }
          if (validUntilDate < now) {
            continue;
          }
        }
        if (promo.max_redemptions && promo.max_redemptions > 0) {
          const countRes = await pool.query(
            'SELECT COUNT(*)::integer AS count FROM paid_product_promo_redemptions WHERE promotion_id = $1',
            [promo.id]
          );
          if (countRes.rows[0].count >= promo.max_redemptions) {
            continue;
          }
        }
        // Hide promotions the current user has already redeemed (UI only, no validation change)
        if (userRedeemedIdsPlans.has(Number(promo.id))) {
          continue;
        }
        activePromotions.push(promo);
      }
    } catch (promoErr) {
      console.error('Error fetching active promotions for plans page:', promoErr);
    }

    const { isSimulationAllowed } = await import('./library/razorpay.js');
    let hasNotesPlans = false;
    try { hasNotesPlans = await hasNotesPermission(req.user); } catch { hasNotesPlans = false; }

    res.render('plans', {
      user: req.user,
      products,
      activePromotions,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
      successMessage: req.query.success === 'true' ? 'Your payment was successfully verified! Access granted.' : null,
      errorMessage: req.query.error || null,
      isDev: isSimulationAllowed(),
      hasNotes: hasNotesPlans
    });
  } catch (err) {
    console.error('Error fetching customer plans:', err);
    res.status(500).render('error', { message: 'Failed to load plans.' });
  }
});

app.post('/api/premium/subscribe', requireAuth, async (req, res, next) => {
  const pgClient = await pool.connect();
  let lockAcquired = false;
  try {
    if (!isPremiumMembershipEnabled()) {
      return res.status(400).json({ status: 'error', message: 'Premium subscription is currently disabled.' });
    }
    const { promoCode } = req.body;
    let offerId = null;
    let cleanPromoCode = '';

    if (promoCode) {
      const promoResult = await validatePromoCode(req.user.id, promoCode, 'recurring');
      if (!promoResult.valid) {
        return res.status(400).json({ status: 'error', message: promoResult.error });
      }
      offerId = promoResult.recurringOfferId;
      cleanPromoCode = promoResult.promo.code;
    }

    // F1+F5: Server-side duplicate subscription protection (legacy PREMIUM).
    // Advisory lock prevents concurrent double-click / two-tab race where both pass the
    // duplicate check before either inserts. Lock is per-user, held for the transaction.
    await pgClient.query('BEGIN');
    const lockKey = Number(req.user.id) % 2147483647;
    await pgClient.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    lockAcquired = true;
    {
      const { validateUserEntitlement } = await import('./auth/paidProducts.js');
      const dupSub = await pgClient.query(
        `SELECT id, cancel_at_period_end, current_period_end FROM premium_subscriptions WHERE user_id=$1 AND provider='razorpay' AND status IN ('created','authenticated','active') LIMIT 1`,
        [req.user.id]
      );
      const premiumProdForDup = await pgClient.query(`SELECT id FROM paid_products WHERE code='PREMIUM' LIMIT 1`);
      const premiumProductIdForDup = premiumProdForDup.rows[0]?.id;
      const dupPaidSub = premiumProductIdForDup ? await pgClient.query(
        `SELECT id, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('created','authenticated','active') LIMIT 1`,
        [req.user.id, premiumProductIdForDup]
      ) : { rowCount: 0, rows: [] };
      const pendingRow = (dupSub.rowCount > 0 && dupSub.rows[0].cancel_at_period_end === true && (!dupSub.rows[0].current_period_end || new Date(dupSub.rows[0].current_period_end) > new Date())) ? dupSub.rows[0] : (dupPaidSub.rowCount > 0 && dupPaidSub.rows[0].cancel_at_period_end === true && (!dupPaidSub.rows[0].current_period_end || new Date(dupPaidSub.rows[0].current_period_end) > new Date()) ? dupPaidSub.rows[0] : null);
      if (pendingRow) {
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ status: 'error', message: 'You have cancelled this premium subscription. It remains active until the end of the current billing period. Please resume your existing subscription instead of creating a new one.', code: 'PENDING_CANCELLATION', resumeRequired: true, currentPeriodEnd: pendingRow.current_period_end });
      }
      if (dupSub.rowCount > 0 || dupPaidSub.rowCount > 0) {
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ status: 'error', message: 'You already have a pending or active premium subscription. Please complete or cancel the existing subscription before creating a new one.' });
      }
      const entitlement = await validateUserEntitlement(req.user.id, 'PREMIUM', pgClient);
      if (entitlement.hasEntitlement) {
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ status: 'error', message: 'You already have active premium access. No additional subscription is needed.' });
      }

      // Validate capacity limit for PREMIUM
      const premiumProd = await getProductByCode('PREMIUM', pgClient);
      if (premiumProd) {
        try {
          const { verifyAndEnforceCapacity } = await import('./auth/paidProducts.js');
          await verifyAndEnforceCapacity(req.user.id, premiumProd.id, pgClient);
        } catch (capErr) {
          await pgClient.query('ROLLBACK');
          return res.status(403).json({ status: 'error', message: capErr.message });
        }
      }
    }
    
    // Create subscription in Razorpay (while holding advisory lock to prevent duplicate Razorpay subs)
    const subscription = await createRazorpaySubscription(req.user.id, null, offerId, cleanPromoCode);
    
    // Store in our database as 'created' state
    const currentStart = subscription.current_start ? new Date(subscription.current_start * 1000) : null;
    const currentEnd = subscription.current_end ? new Date(subscription.current_end * 1000) : null;
    
    // Insert subscription into database (within advisory-lock transaction)
    await pgClient.query(
      `INSERT INTO premium_subscriptions 
       (user_id, provider, provider_customer_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end)
       VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_subscription_id) DO UPDATE 
       SET status = EXCLUDED.status, updated_at = NOW()`,
      [
        req.user.id,
        subscription.customer_id || null,
        subscription.id,
        subscription.plan_id,
        subscription.status || 'created',
        currentStart,
        currentEnd,
        false
      ]
    );

    // Record subscription event
    const subResult = await pgClient.query('SELECT id FROM premium_subscriptions WHERE provider_subscription_id = $1', [subscription.id]);
    const subDbId = subResult.rows[0].id;

    await pgClient.query(
      `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message)
       VALUES ($1, $2, 'created', NULL, NULL, $3, 'Subscription checkout initialized.')`,
      [req.user.id, subDbId, subscription.status || 'created']
    );

    // Connect to generic paid product framework (paid_subscriptions)
    try {
      const product = await getProductByCode('PREMIUM', pgClient);
      if (product) {
        let plan = await getPlanByCode(product.id, 'monthly', pgClient);
        if (!plan) plan = await getPlanByCode(product.id, 'recurring_monthly', pgClient);
        await upsertPaidSubscription({
          userId: req.user.id,
          productId: product.id,
          planId: plan ? plan.id : null,
          provider: 'razorpay',
          providerCustomerId: subscription.customer_id || null,
          providerSubscriptionId: subscription.id,
          status: subscription.status || 'created',
          currentPeriodStart: currentStart,
          currentPeriodEnd: currentEnd,
          cancelAtPeriodEnd: false,
          metadata: { offerId, promoCode: cleanPromoCode }
        }, pgClient);
      }
    } catch (err) {
      console.warn('Generic paid subscription integration notice:', err.message);
    }
    
    await pgClient.query('COMMIT');
    res.json({
      status: 'success',
      subscriptionId: subscription.id
    });
  } catch (err) {
    try { if (lockAcquired) await pgClient.query('ROLLBACK'); } catch {}
    console.error('Subscription creation failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    pgClient.release();
  }
});

app.post('/api/premium/validate-promo', requireAuth, async (req, res, next) => {
  try {
    const { promoCode, membershipType } = req.body;
    if (!promoCode) {
      return res.json({ status: 'success', valid: false, message: 'Please enter a promo code.' });
    }
    if (membershipType !== 'recurring' && membershipType !== 'one_time') {
      return res.json({ status: 'success', valid: false, message: 'Invalid membership type specified.' });
    }
    const result = await validatePromoCode(req.user.id, promoCode, membershipType);
    if (!result.valid) {
      return res.json({ status: 'success', valid: false, message: result.error });
    }
    res.json({
      status: 'success',
      valid: true,
      baseAmount: result.baseAmount,
      discountAmount: result.discountAmount,
      finalAmount: result.finalAmount
    });
  } catch (err) {
    console.error('Promo validation error:', err);
    res.status(500).json({ status: 'error', message: 'An internal error occurred.' });
  }
});

app.post('/api/premium/create-order', requireAuth, async (req, res, next) => {
  try {
    if (!isPremiumMembershipEnabled()) {
      return res.status(400).json({ status: 'error', message: 'Premium registration is currently disabled.' });
    }
    const { promoCode } = req.body;
    let finalAmount = parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10);
    let cleanPromoCode = '';

    if (promoCode) {
      const promoResult = await validatePromoCode(req.user.id, promoCode, 'one_time');
      if (!promoResult.valid) {
        return res.status(400).json({ status: 'error', message: promoResult.error });
      }
      finalAmount = promoResult.finalAmount;
      cleanPromoCode = promoResult.promo.code;
    }

    const amountPaise = finalAmount * 100;
    const currency = process.env.PREMIUM_CURRENCY || 'INR';

    // Verify offering capacity
    const { getProductByCode, verifyAndEnforceCapacity } = await import('./auth/paidProducts.js');
    const premiumProd = await getProductByCode('PREMIUM', pool);
    if (premiumProd) {
      await verifyAndEnforceCapacity(req.user.id, premiumProd.id, pool);
    }

    const receipt = `receipt_ot_${req.user.id}_${Date.now()}`;
    const order = await createRazorpayOrder(amountPaise, currency, receipt, {
      userId: String(req.user.id),
      promoCode: cleanPromoCode
    });

    // Connect to generic paid product framework (paid_orders: pending/created)
    try {
      const product = await getProductByCode('PREMIUM', pool);
      if (product) {
        let plan = await getPlanByCode(product.id, 'one_time_pass', pool);
        if (!plan) plan = await getPlanByCode(product.id, 'one_time', pool);
        const baseAmountPaise = parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10) * 100;
        const discountPaise = Math.max(0, baseAmountPaise - amountPaise);
        await createPaidOrder({
          userId: req.user.id,
          productId: product.id,
          planId: plan ? plan.id : null,
          amountPaise,
          currency,
          provider: 'razorpay',
          providerOrderId: order.id,
          promoCode: cleanPromoCode || null,
          discountPaise,
          metadata: { receipt }
        }, pool);
      }
    } catch (e) {}

    res.json({
      status: 'success',
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || ''
    });
  } catch (err) {
    console.error('Order creation failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/premium/verify-order', requireAuth, async (req, res, next) => {
  const client = pool;
  const pgClient = await client.connect();
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Missing payment details for verification.' });
    }

    // 1. Verify Razorpay signature locally
    const cryptoModule = await import('node:crypto');
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ status: 'error', message: 'Razorpay key secret is not configured.' });
    }
    const hmac = cryptoModule.default.createHmac('sha256', keySecret);
    hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
    const expected_signature = hmac.digest('hex');

    if (expected_signature !== razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Invalid payment signature. Verification failed.' });
    }

    // 2. Fetch order details from Razorpay safely to verify status and notes (bounded)
    const razorpay = (await import('./library/razorpay.js')).getRazorpayClient();
    const order = await Promise.race([
      razorpay.orders.fetch(razorpay_order_id),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Provider fetch timeout'), {code:'PROVIDER_TIMEOUT'})), 6000))
    ]).catch(e => { if(e && e.message==='Provider fetch timeout') throw Object.assign(new Error('Provider request timed out. Please try again.'), {status:504}); throw e; });
    const userIdRaw = order.notes?.userId || order.notes?.user_id;
    const userId = userIdRaw ? String(userIdRaw) : null;

    if (!userId || userId !== String(req.user.id)) {
      return res.status(400).json({ status: 'error', message: 'Payment user mismatch or invalid user ID.' });
    }

    await pgClient.query('BEGIN');

    // 3. Idempotency: check if this payment has already been processed
    const eventCheck = await pgClient.query(
      "SELECT id FROM premium_subscription_events WHERE provider_event_id = $1 AND event_type = 'one_time_purchase'",
      [razorpay_payment_id]
    );

    if (eventCheck.rowCount > 0) {
      await pgClient.query('COMMIT');
      return res.json({ status: 'success', message: 'Payment already processed.' });
    }

    // 4. Record promo redemption if promoCode note is present
    const orderPromoCode = order.notes?.promoCode || null;
    if (orderPromoCode) {
      const promoResult = await validatePromoCode(userId, orderPromoCode, 'one_time');
      if (promoResult.valid) {
        await recordPromotionRedemption({
          userId,
          promotionIdOrCode: promoResult.promo.code,
          providerReference: razorpay_order_id,
          originalAmount: promoResult.baseAmount * 100,
          discountAmount: promoResult.discountAmount * 100,
          finalAmount: promoResult.finalAmount * 100
        }, pgClient);
      }
    }

    // 5. Grant Premium status using safe entitlement rule
    const days = parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10);
    const userCheck = await pgClient.query('SELECT app_role, premium_source FROM users WHERE id = $1', [userId]);
    const user = userCheck.rows[0];

    // Ensure PREMIUM RBAC role in user_roles (payment → RBAC)
    try {
      await pgClient.query(`INSERT INTO roles (name, description) VALUES ('PREMIUM', 'Built-in Premium role') ON CONFLICT (name) DO NOTHING`);
        const premiumRoleRes = await pgClient.query(`SELECT id FROM roles WHERE name = 'PREMIUM'`);
        if (premiumRoleRes.rowCount > 0) {
          const premiumRoleId = premiumRoleRes.rows[0].id;
          await pgClient.query(
            `INSERT INTO user_roles (user_id, role_id, assignment_source) 
             VALUES ($1, $2, 'payment_system') 
             ON CONFLICT (user_id, role_id) 
             DO UPDATE SET assignment_source = 'payment_system'`,
            [userId, premiumRoleId]
          );
        }
      } catch {}

      // Connect to generic paid product framework: paid_orders + user_product_grants + syncProductRbacRole
      try {
        // Compute Premium grant valid_until from Premium grant duration (days), never users.access_expires_at
        const existingGrantRes = await pgClient.query(
          `SELECT MAX(g.valid_until) as max_until
           FROM user_product_grants g
           JOIN paid_products p ON g.product_id = p.id
           WHERE g.user_id = $1 AND (p.code = 'PREMIUM' OR LOWER(p.code) = 'premium') AND g.status = 'active'
             AND (g.valid_until IS NULL OR g.valid_until > NOW())`,
          [userId]
        );
        const maxUntil = existingGrantRes.rows[0]?.max_until;
        const validUntil = maxUntil
          ? new Date(new Date(maxUntil).getTime() + days * 24 * 3600 * 1000)
          : new Date(Date.now() + days * 24 * 3600 * 1000);
        const baseAmountPaise = parseInt(process.env.PREMIUM_ONE_TIME_AMOUNT_INR || '300', 10) * 100;
        const discountPaise = Math.max(0, baseAmountPaise - order.amount);

        await recordOneTimePremiumPayment({
          userId,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          amountPaise: order.amount,
          currency: order.currency || 'INR',
          promoCode: orderPromoCode,
          discountPaise,
          validUntil,
          metadata: { notes: order.notes }
        }, pgClient);
      } catch (err) {
        console.warn('Generic paid product integration notice:', err.message);
      }

    // 6. Record purchase event
    await pgClient.query(
      `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message)
       VALUES ($1, NULL, 'one_time_purchase', $2, NULL, 'success', $3)`,
      [userId, razorpay_payment_id, `Successfully processed one-time payment. Amount: ${order.amount} paise.`]
    );

    await pgClient.query('COMMIT');
    res.json({ status: 'success' });
  } catch (err) {
    try { await pgClient.query('ROLLBACK'); } catch {}
    // F3: concurrent duplicate -> 23505 unique_violation should return idempotent success
    if (err && (err.code === '23505' || String(err.message).includes('duplicate key'))) {
      try {
        const dup = await pool.query(
          "SELECT id FROM premium_subscription_events WHERE provider_event_id=$1 AND event_type='one_time_purchase' LIMIT 1",
          [req.body.razorpay_payment_id]
        );
        if (dup.rowCount > 0) {
          return res.json({ status: 'success', message: 'Payment already processed.' });
        }
      } catch {}
    }
    console.error('One-time verification failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    pgClient.release();
  }
});

app.post('/api/premium/cancel', requireAuth, async (req, res, next) => {
  try {
    // Check if user has an active subscription in DB
    const subResult = await pool.query(
      `SELECT provider_subscription_id FROM premium_subscriptions 
       WHERE user_id = $1 AND provider = 'razorpay' AND status IN ('created', 'authenticated', 'active')
       LIMIT 1`,
      [req.user.id]
    );
    
    if (subResult.rowCount === 0) {
      return res.status(400).json({ status: 'error', message: 'No active premium subscription found to cancel.' });
    }
    
    const providerSubId = subResult.rows[0].provider_subscription_id;
    
    // Cancel in Razorpay (default at end of billing cycle)
    await cancelRazorpaySubscription(providerSubId, true);
    
    // Update local subscription to reflect the intent of cancellation (the webhook will do status = 'cancelled')
    await pool.query(
      `UPDATE premium_subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() 
       WHERE provider_subscription_id = $1`,
      [providerSubId]
    );

    // Also sync cancellation intent to generic paid_subscriptions if present
    try {
      await pool.query(
        `UPDATE paid_subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() 
         WHERE provider_subscription_id = $1`,
        [providerSubId]
      );
    } catch (err) {}
    
    // Log audit event
    const details = await getSubscriptionDetailsForUser(req.user.id);
    await pool.query(
      `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message)
       VALUES ($1, $2, 'cancel_requested', NULL, $3, $3, 'User requested subscription cancellation.')`,
      [req.user.id, details.id, details.status]
    );
    
    res.redirect('/premium');
  } catch (err) {
    console.error('Subscription cancellation failed:', err.message);
    res.render('premium', {
      user: req.user,
      enabled: isPremiumMembershipEnabled(),
      subscription: await getSubscriptionDetailsForUser(req.user.id),
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
      successMessage: null,
      errorMessage: err.message
    });
  }
});

// === Generic Paid Product Cancellation (F4) ===
app.post('/api/payments/cancel', requireAuth, async (req, res, next) => {
  try {
    const { subscriptionId, productId, productCode } = req.body;
    const { pool } = await import('./db/pool.js');
    const { cancelRazorpaySubscription } = await import('./library/razorpay.js');
    const { logPaidProductEvent } = await import('./auth/paidProducts.js');

    let targetRow = null;

    if (subscriptionId) {
      const r = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end FROM paid_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`,
        [String(subscriptionId).trim()]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ status: 'error', message: 'Subscription not found.' });
      }
      targetRow = r.rows[0];
    } else if (productId || productCode) {
      let pid = productId;
      if (productCode && !pid) {
        const pr = await pool.query(`SELECT id FROM paid_products WHERE code=$1`, [String(productCode).trim().toUpperCase()]);
        if (pr.rowCount === 0) return res.status(404).json({ status: 'error', message: 'Product not found.' });
        pid = pr.rows[0].id;
      }
      const r = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('active','authenticated','created') ORDER BY updated_at DESC LIMIT 1`,
        [req.user.id, pid]
      );
      if (r.rowCount === 0) {
        return res.status(400).json({ status: 'error', message: 'No active subscription found to cancel for this product.' });
      }
      targetRow = r.rows[0];
    } else {
      // Fallback: find any active generic subscription for this user
      const r = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end FROM paid_subscriptions WHERE user_id=$1 AND status IN ('active','authenticated','created') ORDER BY updated_at DESC LIMIT 1`,
        [req.user.id]
      );
      if (r.rowCount === 0) {
        return res.status(400).json({ status: 'error', message: 'No active subscription found to cancel.' });
      }
      targetRow = r.rows[0];
    }

    // Ownership check
    if (String(targetRow.user_id) !== String(req.user.id)) {
      return res.status(403).json({ status: 'error', message: 'You do not own this subscription.' });
    }

    // Idempotent: already marked cancel_at_period_end
    if (targetRow.cancel_at_period_end) {
      return res.json({ status: 'success', message: 'Subscription cancellation already requested. It will expire at the end of the current billing period.', subscriptionId: targetRow.provider_subscription_id });
    }

    const providerSubId = targetRow.provider_subscription_id;

    // Cancel in Razorpay at period end; handle already cancelled gracefully
    try {
      await cancelRazorpaySubscription(providerSubId, true);
    } catch (rzpErr) {
      const msg = String(rzpErr.message || '').toLowerCase();
      if (msg.includes('already cancelled') || msg.includes('already canceled') || msg.includes('cancelled')) {
        // Treat as success – ensure DB reflects intent
      } else {
        throw rzpErr;
      }
    }

    // Update local state to reflect cancellation intent (webhook will finalize status)
    await pool.query(
      `UPDATE paid_subscriptions SET cancel_at_period_end=TRUE, updated_at=NOW() WHERE provider_subscription_id=$1`,
      [providerSubId]
    );
    // Sync to legacy premium_subscriptions if this sub also exists there (PREMIUM dual-write)
    try {
      await pool.query(
        `UPDATE premium_subscriptions SET cancel_at_period_end=TRUE, updated_at=NOW() WHERE provider_subscription_id=$1`,
        [providerSubId]
      );
    } catch {}

    // Audit log
    try {
      await logPaidProductEvent({
        productId: targetRow.product_id,
        userId: req.user.id,
        eventType: 'cancel_requested',
        providerEventId: providerSubId,
        previousStatus: targetRow.status,
        newStatus: targetRow.status,
        message: 'User requested subscription cancellation (generic endpoint).',
        payload: { provider_subscription_id: providerSubId, cancel_at_period_end: true }
      }, pool);
    } catch {}
    // Also legacy premium event if applicable
    try {
      const legacySub = await pool.query(`SELECT id, status FROM premium_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`, [providerSubId]);
      if (legacySub.rowCount > 0) {
        await pool.query(
          `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) VALUES ($1,$2,'cancel_requested',NULL,$3,$3,'User requested subscription cancellation (generic).')`,
          [req.user.id, legacySub.rows[0].id, legacySub.rows[0].status]
        );
      }
    } catch {}

    return res.json({ status: 'success', message: 'Subscription will be cancelled at the end of the current billing period.', subscriptionId: providerSubId });
  } catch (err) {
    console.error('Generic subscription cancellation failed:', err.message);
    // Return JSON for API consumers (frontend handles both 409/400)
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// === Generic Paid Product Resume (Cancel -> Resume) ===
app.post('/api/payments/resume', requireAuth, async (req, res, next) => {
  let pgClient = null;
  let lockAcquired = false;
  try {
    const { subscriptionId, productId, productCode } = req.body;
    const { pool } = await import('./db/pool.js');
    const { revertRazorpayCancellation } = await import('./library/razorpay.js');
    const { logPaidProductEvent } = await import('./auth/paidProducts.js');

    let pid = productId;
    let lockProductId = null;
    let targetRow = null;

    if (subscriptionId) {
      const r = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`,
        [String(subscriptionId).trim()]
      );
      if (r.rowCount === 0) return res.status(404).json({ status: 'error', message: 'Subscription not found.' });
      targetRow = r.rows[0];
      pid = targetRow.product_id;
      lockProductId = Number(pid);
    } else if (productId || productCode) {
      if (productCode && !pid) {
        const pr = await pool.query(`SELECT id FROM paid_products WHERE code=$1`, [String(productCode).trim().toUpperCase()]);
        if (pr.rowCount === 0) return res.status(404).json({ status: 'error', message: 'Product not found.' });
        pid = pr.rows[0].id;
      }
      pid = Number(pid);
      lockProductId = pid;
      // Look for pending cancellation first — includes created with NULL period
      const rPending = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('active','authenticated','created') AND cancel_at_period_end=TRUE AND (current_period_end IS NULL OR current_period_end > NOW()) ORDER BY updated_at DESC LIMIT 1`,
        [req.user.id, pid]
      );
      if (rPending.rowCount > 0) {
        targetRow = rPending.rows[0];
      } else {
        // Idempotent: already resumed? check active without cancellation
        const rActive = await pool.query(
          `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('active','authenticated','created') ORDER BY updated_at DESC LIMIT 1`,
          [req.user.id, pid]
        );
        if (rActive.rowCount > 0 && rActive.rows[0].cancel_at_period_end === false) {
          return res.json({ status: 'success', message: 'Subscription is already active.', subscriptionId: rActive.rows[0].provider_subscription_id, alreadyResumed: true });
        }
        return res.status(400).json({ status: 'error', message: 'No cancelled subscription found to resume for this product.' });
      }
    } else {
      // Fallback: find any pending cancellation for this user — includes created with NULL period
      const r = await pool.query(
        `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND status IN ('active','authenticated','created') AND cancel_at_period_end=TRUE AND (current_period_end IS NULL OR current_period_end > NOW()) ORDER BY updated_at DESC LIMIT 1`,
        [req.user.id]
      );
      if (r.rowCount === 0) {
        const rActive = await pool.query(
          `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end FROM paid_subscriptions WHERE user_id=$1 AND status IN ('active','authenticated','created') ORDER BY updated_at DESC LIMIT 1`,
          [req.user.id]
        );
        if (rActive.rowCount > 0 && rActive.rows[0].cancel_at_period_end === false) {
          return res.json({ status: 'success', message: 'Subscription is already active.', subscriptionId: rActive.rows[0].provider_subscription_id, alreadyResumed: true });
        }
        return res.status(400).json({ status: 'error', message: 'No cancelled subscription found to resume.' });
      }
      targetRow = r.rows[0];
      pid = targetRow.product_id;
      lockProductId = Number(pid);
    }

    if (String(targetRow.user_id) !== String(req.user.id)) {
      return res.status(403).json({ status: 'error', message: 'You do not own this subscription.' });
    }

    // Idempotent: already resumed (no longer pending)
    if (!targetRow.cancel_at_period_end) {
      return res.json({ status: 'success', message: 'Subscription is already active.', subscriptionId: targetRow.provider_subscription_id, alreadyResumed: true });
    }
    if (targetRow.current_period_end && new Date(targetRow.current_period_end) <= new Date()) {
      return res.status(400).json({ status: 'error', message: 'Subscription period has already expired. Please create a new subscription.' });
    }

    pgClient = await pool.connect();
    const lockKey = (Number(req.user.id) * 10000 + Number(lockProductId)) % 2147483647;
    await pgClient.query('BEGIN');
    await pgClient.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    lockAcquired = true;

    // Re-check under lock
    const lockedRowRes = await pgClient.query(
      `SELECT id, user_id, product_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`,
      [targetRow.provider_subscription_id]
    );
    const lockedRow = lockedRowRes.rows[0];
    if (!lockedRow || String(lockedRow.user_id) !== String(req.user.id)) {
      await pgClient.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: 'Subscription not found.' });
    }
    if (!lockedRow.cancel_at_period_end) {
      await pgClient.query('ROLLBACK');
      return res.json({ status: 'success', message: 'Subscription is already active.', subscriptionId: lockedRow.provider_subscription_id, alreadyResumed: true });
    }
    if (lockedRow.current_period_end && new Date(lockedRow.current_period_end) <= new Date()) {
      await pgClient.query('ROLLBACK');
      return res.status(400).json({ status: 'error', message: 'Subscription period has already expired. Please create a new subscription.' });
    }

    const providerSubId = lockedRow.provider_subscription_id;

    // Reverse cancellation at Razorpay first — only on success update local DB
    try {
      await revertRazorpayCancellation(providerSubId);
    } catch (rzpErr) {
      const msg = String(rzpErr?.error?.description || rzpErr?.message || '').toLowerCase();
      // Idempotent provider responses: already not scheduled / no scheduled changes -> treat as success
      const isIdempotent = msg.includes('no scheduled changes') || msg.includes('no pending') || msg.includes('nothing to cancel') || msg.includes('not found') === false;
      // If Razorpay says no scheduled changes, we still consider local resume valid (provider already clean)
      if (msg.includes('no scheduled changes') || msg.includes('no pending') || msg.includes('nothing to cancel')) {
        // proceed to local update
      } else if (rzpErr.statusCode === 404 || msg.includes('not found')) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ status: 'error', message: 'Subscription not found at payment provider.' });
      } else {
        // For other errors, we try to be lenient if provider indicates already active
        const desc = String(rzpErr?.error?.description || '');
        if (desc.toLowerCase().includes('already') && desc.toLowerCase().includes('active')) {
          // treat as success
        } else {
          await pgClient.query('ROLLBACK');
          throw rzpErr;
        }
      }
    }

    await pgClient.query(
      `UPDATE paid_subscriptions SET cancel_at_period_end=FALSE, updated_at=NOW() WHERE provider_subscription_id=$1`,
      [providerSubId]
    );
    try {
      await pgClient.query(
        `UPDATE premium_subscriptions SET cancel_at_period_end=FALSE, updated_at=NOW() WHERE provider_subscription_id=$1`,
        [providerSubId]
      );
    } catch {}

    try {
      await logPaidProductEvent({
        productId: lockedRow.product_id,
        userId: req.user.id,
        eventType: 'subscription_resumed',
        providerEventId: providerSubId,
        previousStatus: lockedRow.status,
        newStatus: lockedRow.status,
        message: 'User resumed subscription before period end (cancel_at_period_end cleared).',
        payload: { provider_subscription_id: providerSubId, cancel_at_period_end: false }
      }, pgClient);
    } catch {}
    try {
      const legacySub = await pgClient.query(`SELECT id, status FROM premium_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`, [providerSubId]);
      if (legacySub.rowCount > 0) {
        await pgClient.query(
          `INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) VALUES ($1,$2,'resumed',NULL,$3,$3,'User resumed subscription before period end.')`,
          [req.user.id, legacySub.rows[0].id, legacySub.rows[0].status]
        );
      }
    } catch {}

    await pgClient.query('COMMIT');
    return res.json({ status: 'success', message: 'Subscription resumed successfully. Your access will continue without interruption.', subscriptionId: providerSubId });
  } catch (err) {
    try { if (lockAcquired && pgClient) await pgClient.query('ROLLBACK'); } catch {}
    console.error('Subscription resume failed:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (pgClient) pgClient.release();
  }
});

// Legacy premium resume (thin wrapper for /premium page compatibility)
app.post('/api/premium/resume', requireAuth, async (req, res, next) => {
  try {
    const { pool } = await import('./db/pool.js');
    const pr = await pool.query(`SELECT id FROM paid_products WHERE code='PREMIUM' LIMIT 1`);
    const premiumProductId = pr.rows[0]?.id;
    // Delegate to generic resume by forwarding productCode
    req.body = { ...req.body, productCode: 'PREMIUM', productId: premiumProductId };
    // Re-invoke generic handler logic via direct query to avoid double lock complexity — reuse same resume endpoint internally
    // For minimal duplication, perform premium-specific pending lookup
    const subRes = await pool.query(
      `SELECT provider_subscription_id FROM premium_subscriptions WHERE user_id=$1 AND provider='razorpay' AND status IN ('active','authenticated','created') AND cancel_at_period_end=TRUE AND (current_period_end IS NULL OR current_period_end > NOW()) LIMIT 1`,
      [req.user.id]
    );
    if (subRes.rowCount > 0) {
      req.body.subscriptionId = subRes.rows[0].provider_subscription_id;
    }
    // Forward to generic handler by issuing internal fetch to same logic — instead directly call resume logic via pool
    // To keep minimal, just proxy to /api/payments/resume handler by reusing its implementation
    // We call the generic resume endpoint handler inline
    const { revertRazorpayCancellation } = await import('./library/razorpay.js');
    const { logPaidProductEvent } = await import('./auth/paidProducts.js');
    let pgClient = null;
    let lockAcquired = false;
    try {
      const targetId = req.body.subscriptionId;
      if (!targetId) return res.status(400).json({ status: 'error', message: 'No cancelled premium subscription found to resume.' });
      pgClient = await pool.connect();
      const lockKey = Number(req.user.id) % 2147483647;
      await pgClient.query('BEGIN');
      await pgClient.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
      lockAcquired = true;
      const lockedRowRes = await pgClient.query(`SELECT id, user_id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM premium_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`, [targetId]);
      const lockedRow = lockedRowRes.rows[0];
      if (!lockedRow || String(lockedRow.user_id) !== String(req.user.id)) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ status: 'error', message: 'Subscription not found.' });
      }
      if (!lockedRow.cancel_at_period_end) {
        await pgClient.query('ROLLBACK');
        return res.json({ status: 'success', message: 'Subscription is already active.', subscriptionId: lockedRow.provider_subscription_id });
      }
      if (lockedRow.current_period_end && new Date(lockedRow.current_period_end) <= new Date()) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ status: 'error', message: 'Subscription period has already expired. Please create a new subscription.' });
      }
      try {
        await revertRazorpayCancellation(targetId);
      } catch (rzpErr) {
        const msg = String(rzpErr?.error?.description || rzpErr?.message || '').toLowerCase();
        if (msg.includes('no scheduled changes') || msg.includes('no pending')) {
          // proceed
        } else if (rzpErr.statusCode === 404) {
          await pgClient.query('ROLLBACK');
          return res.status(404).json({ status: 'error', message: 'Subscription not found at payment provider.' });
        } else {
          const desc = String(rzpErr?.error?.description || '');
          if (!(desc.toLowerCase().includes('already') && desc.toLowerCase().includes('active'))) {
            await pgClient.query('ROLLBACK');
            throw rzpErr;
          }
        }
      }
      await pgClient.query(`UPDATE premium_subscriptions SET cancel_at_period_end=FALSE, updated_at=NOW() WHERE provider_subscription_id=$1`, [targetId]);
      try { await pgClient.query(`UPDATE paid_subscriptions SET cancel_at_period_end=FALSE, updated_at=NOW() WHERE provider_subscription_id=$1`, [targetId]); } catch {}
      const details = await pgClient.query(`SELECT id, status FROM premium_subscriptions WHERE provider_subscription_id=$1 LIMIT 1`, [targetId]);
      if (details.rowCount > 0) {
        await pgClient.query(`INSERT INTO premium_subscription_events (user_id, subscription_id, event_type, provider_event_id, previous_status, new_status, message) VALUES ($1,$2,'resumed',NULL,$3,$3,'User resumed subscription before period end.')`, [req.user.id, details.rows[0].id, details.rows[0].status]);
      }
      await pgClient.query('COMMIT');
      if (req.headers.accept && req.headers.accept.includes('text/html')) return res.redirect('/premium');
      return res.json({ status: 'success', message: 'Subscription resumed successfully.', subscriptionId: targetId });
    } catch (e) {
      try { if (lockAcquired && pgClient) await pgClient.query('ROLLBACK'); } catch {}
      throw e;
    } finally { if (pgClient) pgClient.release(); }
  } catch (err) {
    console.error('Premium resume failed:', err.message);
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      const { getSubscriptionDetailsForUser } = await import('./auth/premium.js');
      const { isPremiumMembershipEnabled } = await import('./library/razorpay.js');
      return res.render('premium', { user: req.user, enabled: isPremiumMembershipEnabled(), subscription: await getSubscriptionDetailsForUser(req.user.id), razorpayKeyId: process.env.RAZORPAY_KEY_ID || '', successMessage: null, errorMessage: err.message });
    }
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// === Generic Paid Products Promo Validation ===
app.post('/api/payments/validate-promo', requireAuth, async (req, res, next) => {
  try {
    const { promoCode, planId } = req.body;
    if (!promoCode) {
      return res.json({ status: 'success', valid: false, message: 'Please enter a promo code.' });
    }
    if (!planId) {
      return res.json({ status: 'success', valid: false, message: 'planId is required.' });
    }
    const planIdNum = parseInt(planId, 10);
    if (isNaN(planIdNum)) {
      return res.json({ status: 'success', valid: false, message: 'Invalid plan ID format.' });
    }

    const { pool } = await import('./db/pool.js');
    const { validateProductPromotion } = await import('./auth/paidProducts.js');

    // Get plan details
    const planRes = await pool.query(
      `SELECT p.*, prod.is_enabled AS product_enabled 
       FROM paid_product_plans p 
       JOIN paid_products prod ON p.product_id = prod.id 
       WHERE p.id = $1`,
      [planIdNum]
    );
    const plan = planRes.rows[0];
    if (!plan) {
      return res.json({ status: 'success', valid: false, message: 'Target payment plan not found.' });
    }
    if (!plan.is_active) {
      return res.json({ status: 'success', valid: false, message: 'The selected plan is inactive.' });
    }
    if (!plan.product_enabled) {
      return res.json({ status: 'success', valid: false, message: 'The associated product is disabled.' });
    }

    const result = await validateProductPromotion(req.user.id, promoCode, plan.product_id, plan.billing_type, pool);
    if (!result.valid) {
      return res.json({ status: 'success', valid: false, message: result.error });
    }

    const baseAmount = parseInt(plan.price_amount_paise, 10);
    let discountAmount = 0;
    if (result.promo.discount_type === 'percentage') {
      discountAmount = Math.floor(baseAmount * (result.promo.discount_value / 100));
    } else if (result.promo.discount_type === 'flat') {
      discountAmount = result.promo.discount_value;
    }

    // Cap final price to be at least 1 INR (100 paise)
    const finalAmount = Math.max(100, baseAmount - discountAmount);
    discountAmount = baseAmount - finalAmount;

    res.json({
      status: 'success',
      valid: true,
      baseAmount: baseAmount / 100,
      discountAmount: discountAmount / 100,
      finalAmount: finalAmount / 100
    });
  } catch (err) {
    console.error('Paid Product promo validation error:', err);
    res.status(500).json({ status: 'error', message: 'An internal error occurred.' });
  }
});


// === Generic Recurring Payment Flow (Thought #4 Phase 2G-2) ===

app.post('/api/payments/subscribe', requireAuth, async (req, res, next) => {
  const { pool } = await import('./db/pool.js');
  let pgClient = null;
  let lockAcquired = false;
  try {
    const { planId, promoCode } = req.body;
    if (!planId) {
      return res.status(400).json({ status: 'error', message: 'planId is required.' });
    }

    const planIdNum = parseInt(planId, 10);
    if (isNaN(planIdNum)) {
      return res.status(400).json({ status: 'error', message: 'Invalid planId format.' });
    }

    const { validateProductPromotion, upsertPaidSubscription } = await import('./auth/paidProducts.js');
    const { getRazorpayClient } = await import('./library/razorpay.js');

    // Resolve plan and product details
    const planRes = await pool.query(
      `SELECT p.*, prod.id AS product_id, prod.code AS product_code, prod.is_enabled AS product_enabled 
       FROM paid_product_plans p 
       JOIN paid_products prod ON p.product_id = prod.id 
       WHERE p.id = $1`,
      [planIdNum]
    );

    const plan = planRes.rows[0];
    if (!plan) {
      return res.status(400).json({ status: 'error', message: 'Paid plan not found.' });
    }

    if (plan.billing_type !== 'recurring') {
      return res.status(400).json({ status: 'error', message: 'Selected plan is not a recurring subscription plan.' });
    }

    if (!plan.is_active) {
      return res.status(400).json({ status: 'error', message: 'Selected plan is currently inactive.' });
    }

    if (!plan.product_enabled) {
      return res.status(400).json({ status: 'error', message: 'The associated product is currently disabled.' });
    }

    if (!plan.razorpay_plan_id) {
      return res.status(400).json({ status: 'error', message: 'Razorpay Plan ID is not configured for this plan.' });
    }

    let offerId = null;
    let cleanPromoCode = '';

    if (promoCode) {
      const promoResult = await validateProductPromotion(req.user.id, promoCode, plan.product_id, 'recurring', pool);
      if (!promoResult.valid) {
        return res.status(400).json({ status: 'error', message: promoResult.error });
      }
      offerId = promoResult.promo.recurring_offer_id || null;
      cleanPromoCode = promoResult.promo.code;
    }

    // F1+F5: Server-side duplicate subscription protection (generic) with advisory lock
    // to prevent concurrent double-click race. Lock is per (user,product).
    pgClient = await pool.connect();
    const lockKey = (Number(req.user.id) * 10000 + Number(plan.product_id)) % 2147483647;
    await pgClient.query('BEGIN');
    await pgClient.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    lockAcquired = true;
    {
      const { validateUserEntitlement } = await import('./auth/paidProducts.js');
      const dupSub = await pgClient.query(
        `SELECT id, provider_subscription_id, status, cancel_at_period_end, current_period_end FROM paid_subscriptions WHERE user_id=$1 AND product_id=$2 AND status IN ('created','authenticated','active') LIMIT 1`,
        [req.user.id, plan.product_id]
      );
      if (dupSub.rowCount > 0) {
        const row = dupSub.rows[0];
        let rzpSub;
        try {
          const { getRazorpayClient } = await import('./library/razorpay.js');
          rzpSub = await Promise.race([
            getRazorpayClient().subscriptions.fetch(row.provider_subscription_id),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Provider fetch timeout')), 6000))
          ]);
        } catch (fetchErr) {
          await pgClient.query('ROLLBACK');
          if (fetchErr && fetchErr.message === 'Provider fetch timeout') return res.status(504).json({ status: 'error', message: 'Provider request timed out. Please try again.', code: 'PROVIDER_TIMEOUT' });
          return res.status(502).json({ status: 'error', message: 'Unable to verify previous checkout. Please try again.', code: 'PROVIDER_FETCH_FAILED' });
        }

        const providerStatus = (rzpSub && rzpSub.status) ? String(rzpSub.status).toLowerCase() : 'unknown';

        const isPendingCancellation = row.cancel_at_period_end === true &&
          ['active', 'authenticated', 'pending'].includes(providerStatus) &&
          (!row.current_period_end || new Date(row.current_period_end) > new Date());

        if (isPendingCancellation) {
          await pgClient.query('ROLLBACK');
          return res.status(409).json({ status: 'error', message: 'You have cancelled this subscription. It remains active until the end of the current billing period. Please resume your existing subscription instead of creating a new one.', code: 'PENDING_CANCELLATION', resumeRequired: true, currentPeriodEnd: row.current_period_end });
        }

        if (providerStatus === 'created') {
          if (row.status === 'created' && row.cancel_at_period_end === false && !row.current_period_end) {
            await pgClient.query('ROLLBACK');
            return res.json({ status: 'success', subscriptionId: row.provider_subscription_id, reused: true });
          }
        }

        if (['active', 'authenticated', 'pending'].includes(providerStatus)) {
          await pgClient.query('ROLLBACK');
          return res.status(409).json({ status: 'error', message: 'You already have a pending or active subscription for this product. Please complete or cancel the existing subscription before creating a new one.' });
        }

        if (['cancelled', 'completed', 'expired', 'halted'].includes(providerStatus)) {
          const markStatus = providerStatus === 'cancelled' ? 'cancelled' : 'expired';
          await pgClient.query(`UPDATE paid_subscriptions SET status=$1, updated_at=NOW() WHERE id=$2`, [markStatus, row.id]);
          try {
            await pgClient.query(`UPDATE premium_subscriptions SET status=$1, updated_at=NOW() WHERE provider_subscription_id=$2`, [markStatus, row.provider_subscription_id]);
          } catch {}
        } else {
          await pgClient.query('ROLLBACK');
          return res.status(409).json({ status: 'error', message: 'You already have a pending or active subscription for this product. Please complete or cancel the existing subscription before creating a new one.' });
        }
      }

      const entitlement = await validateUserEntitlement(req.user.id, plan.product_id, pgClient);
      if (entitlement.hasEntitlement) {
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ status: 'error', message: 'You already have active access to this product. A new subscription is not needed.' });
      }

      // Verify offering capacity under transaction/lock
      const { verifyAndEnforceCapacity } = await import('./auth/paidProducts.js');
      try {
        await verifyAndEnforceCapacity(req.user.id, plan.product_id, pgClient);
      } catch (capErr) {
        await pgClient.query('ROLLBACK');
        return res.status(403).json({ status: 'error', message: capErr.message });
      }
    }

    // Create subscription in Razorpay (while holding advisory lock)
    const razorpay = getRazorpayClient();
    const options = {
      plan_id: plan.razorpay_plan_id,
      total_count: 12, // 12 cycles by default
      quantity: 1,
      customer_notify: 1,
      notes: {
        userId: String(req.user.id),
        planId: String(plan.id),
        promoCode: cleanPromoCode || ''
      }
    };

    if (offerId) {
      options.offer_id = offerId;
    }

    const subscription = await razorpay.subscriptions.create(options);

    const currentStart = subscription.current_start ? new Date(subscription.current_start * 1000) : null;
    const currentEnd = subscription.current_end ? new Date(subscription.current_end * 1000) : null;

    // Record the subscription in the generic paid product framework
    await upsertPaidSubscription({
      userId: req.user.id,
      productId: plan.product_id,
      planId: plan.id,
      provider: 'razorpay',
      providerCustomerId: subscription.customer_id || null,
      providerSubscriptionId: subscription.id,
      status: subscription.status || 'created',
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      cancelAtPeriodEnd: false,
      metadata: { offerId, promoCode: cleanPromoCode }
    }, pgClient);
    await pgClient.query('COMMIT');

    res.json({
      status: 'success',
      subscriptionId: subscription.id
    });
  } catch (err) {
    try { if (lockAcquired && pgClient) await pgClient.query('ROLLBACK'); } catch {}
    console.error('Generic subscription checkout failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    if (pgClient) pgClient.release();
  }
});

// Local/dev-only endpoint to simulate provider cancellation of a subscription for testing repurchase
app.post('/api/dev/simulate-provider-cancellation', requireAuth, async (req, res) => {
  const { isSimulationAllowed, simulateProviderCancellation } = await import('./library/razorpay.js');

  if (!isSimulationAllowed()) {
    return res.status(403).json({ status: 'error', message: 'Simulation controls are strictly disabled in this environment.' });
  }

  try {
    const { productId, subscriptionId } = req.body;
    const { pool } = await import('./db/pool.js');

    let targetSubId = subscriptionId;

    if (!targetSubId && productId) {
      const subRes = await pool.query(
        `SELECT provider_subscription_id 
         FROM paid_subscriptions 
         WHERE user_id = $1 AND product_id = $2 
           AND status IN ('active', 'authenticated', 'created') 
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, productId]
      );
      if (subRes.rowCount > 0) {
        targetSubId = subRes.rows[0].provider_subscription_id;
      } else {
        const legacyRes = await pool.query(
          `SELECT provider_subscription_id 
           FROM premium_subscriptions 
           WHERE user_id = $1 
             AND status IN ('active', 'authenticated', 'created') 
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.id]
        );
        if (legacyRes.rowCount > 0) {
          targetSubId = legacyRes.rows[0].provider_subscription_id;
        }
      }
    }

    if (!targetSubId) {
      return res.status(404).json({ status: 'error', message: 'No active or pending provider subscription found for this product.' });
    }

    simulateProviderCancellation(targetSubId);

    return res.json({
      status: 'success',
      message: `Simulated provider cancellation for subscription ${targetSubId}.`,
      subscriptionId: targetSubId
    });
  } catch (err) {
    console.error('Simulate provider cancellation failed:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


// === Generic One-Time Payment Flow (Thought #4 Phase 2G-1) ===

app.post('/api/payments/create-order', requireAuth, async (req, res, next) => {
  try {
    const { planId, promoCode } = req.body;
    if (!planId) {
      return res.status(400).json({ status: 'error', message: 'planId is required.' });
    }

    const { pool } = await import('./db/pool.js');
    const { validateProductPromotion, createPaidOrder } = await import('./auth/paidProducts.js');
    const { createRazorpayOrder } = await import('./library/razorpay.js');

    // Resolve plan and product details
    const planRes = await pool.query(
      `SELECT p.*, prod.id AS product_id, prod.code AS product_code, prod.is_enabled AS product_enabled 
       FROM paid_product_plans p 
       JOIN paid_products prod ON p.product_id = prod.id 
       WHERE p.id = $1`,
      [String(planId)]
    );

    const plan = planRes.rows[0];
    if (!plan) {
      return res.status(400).json({ status: 'error', message: 'Paid plan not found.' });
    }
    if (!plan.is_active) {
      return res.status(400).json({ status: 'error', message: 'The selected plan is currently inactive.' });
    }
    if (!plan.product_enabled) {
      return res.status(400).json({ status: 'error', message: 'The associated product is disabled.' });
    }
    if (plan.billing_type !== 'one_time') {
      return res.status(400).json({ status: 'error', message: 'This endpoint only handles one-time payments.' });
    }

    const baseAmountPaise = parseInt(plan.price_amount_paise, 10);
    let finalAmountPaise = baseAmountPaise;
    let discountPaise = 0;
    let cleanPromoCode = null;

    if (promoCode && String(promoCode).trim()) {
      const promoResult = await validateProductPromotion(req.user.id, promoCode, plan.product_id, 'one_time', pool);
      if (!promoResult.valid) {
        return res.status(400).json({ status: 'error', message: promoResult.error });
      }

      if (promoResult.promo.discount_type === 'percentage') {
        discountPaise = Math.floor(baseAmountPaise * (promoResult.promo.discount_value / 100));
      } else if (promoResult.promo.discount_type === 'flat') {
        discountPaise = promoResult.promo.discount_value; // Already in paise
      }

      // Enforce: final price must be at least 1 INR (100 paise)
      finalAmountPaise = Math.max(100, baseAmountPaise - discountPaise);
      discountPaise = baseAmountPaise - finalAmountPaise;
      cleanPromoCode = promoResult.promo.code;
    }

    const currency = plan.currency || 'INR';
    const receipt = `receipt_ot_${req.user.id}_plan_${plan.id}_${Date.now()}`;

    // Verify offering capacity
    const { verifyAndEnforceCapacity } = await import('./auth/paidProducts.js');
    await verifyAndEnforceCapacity(req.user.id, plan.product_id, pool);

    // Create the Razorpay Order
    const order = await createRazorpayOrder(finalAmountPaise, currency, receipt, {
      userId: String(req.user.id),
      planId: String(plan.id),
      promoCode: cleanPromoCode || ''
    });

    // Record the pending paid order in generic framework
    await createPaidOrder({
      userId: req.user.id,
      productId: plan.product_id,
      planId: plan.id,
      amountPaise: finalAmountPaise,
      currency,
      provider: 'razorpay',
      providerOrderId: order.id,
      promoCode: cleanPromoCode,
      discountPaise,
      metadata: { receipt }
    }, pool);

    res.json({
      status: 'success',
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || ''
    });
  } catch (err) {
    console.error('Generic Order creation failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/payments/verify-subscription', requireAuth, async (req, res, next) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, promoCode } = req.body;
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Missing payment details for verification.' });
    }

    // 1. Verify Razorpay signature locally
    const cryptoModule = await import('node:crypto');
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ status: 'error', message: 'Razorpay key secret is not configured.' });
    }
    const hmac = cryptoModule.default.createHmac('sha256', keySecret);
    hmac.update(razorpay_payment_id + '|' + razorpay_subscription_id);
    const expected_signature = hmac.digest('hex');

    if (expected_signature !== razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Invalid payment signature. Verification failed.' });
    }

    // 2. Fetch subscription details from Razorpay safely (bounded)
    const { getRazorpayClient } = await import('./library/razorpay.js');
    const razorpay = getRazorpayClient();
    const sub = await Promise.race([
      razorpay.subscriptions.fetch(razorpay_subscription_id),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Provider fetch timeout'), {code:'PROVIDER_TIMEOUT'})), 6000))
    ]).catch(e => { if(e && e.message==='Provider fetch timeout') throw Object.assign(new Error('Provider request timed out. Please try again.'), {status:504}); throw e; });

    const userIdRaw = sub.notes?.userId || sub.notes?.user_id;
    const userId = userIdRaw ? String(userIdRaw) : null;

    if (!userId || String(userId) !== String(req.user.id)) {
      return res.status(400).json({ status: 'error', message: 'Payment user mismatch or invalid user ID.' });
    }

    // 3. Process via existing webhook handler for synchronous fulfillment
    const { handleSubscriptionWebhook } = await import('./auth/premium.js');
    
    // Construct a mock payload for the webhook handler
    const payload = {
      subscription: { entity: sub },
      payment: { entity: { id: razorpay_payment_id, status: 'captured' } }
    };

    // Use a unique event ID for the synchronous verification to avoid idempotency conflicts with the actual webhook, but ensure the payment is processed.
    const result = await handleSubscriptionWebhook(payload, `sync_${razorpay_payment_id}`, 'subscription.charged');

    res.json({ status: 'success', result });
  } catch (err) {
    console.error('Subscription verification failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/payments/verify-order', requireAuth, async (req, res, next) => {
  const { pool } = await import('./db/pool.js');
  const client = pool;
  const pgClient = await client.connect();
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Missing payment details for verification.' });
    }

    // 1. Verify Razorpay signature locally
    const cryptoModule = await import('node:crypto');
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ status: 'error', message: 'Razorpay key secret is not configured.' });
    }
    const hmac = cryptoModule.default.createHmac('sha256', keySecret);
    hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
    const expected_signature = hmac.digest('hex');

    if (expected_signature !== razorpay_signature) {
      return res.status(400).json({ status: 'error', message: 'Invalid payment signature. Verification failed.' });
    }

    // 2. Fetch order details from Razorpay safely to verify status and notes (bounded)
    const { getRazorpayClient } = await import('./library/razorpay.js');
    const razorpay = getRazorpayClient();
    const order = await Promise.race([
      razorpay.orders.fetch(razorpay_order_id),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Provider fetch timeout'), {code:'PROVIDER_TIMEOUT'})), 6000))
    ]).catch(e => { if(e && e.message==='Provider fetch timeout') throw Object.assign(new Error('Provider request timed out. Please try again.'), {status:504}); throw e; });
    const userIdRaw = order.notes?.userId || order.notes?.user_id;
    const userId = userIdRaw ? String(userIdRaw) : null;
    const planIdRaw = order.notes?.planId;
    const planId = planIdRaw ? String(planIdRaw) : null;

    if (!userId || String(userId) !== String(req.user.id)) {
      return res.status(400).json({ status: 'error', message: 'Payment user mismatch or invalid user ID.' });
    }
    if (!planId) {
      return res.status(400).json({ status: 'error', message: 'Payment plan mapping details are missing.' });
    }

    await pgClient.query('BEGIN');

    // 3. Idempotency Check: prevent duplicate processing of the same payment id
    const paymentCheck = await pgClient.query(
      `SELECT id FROM paid_orders WHERE provider = 'razorpay' AND provider_payment_id = $1 AND status = 'paid'`,
      [razorpay_payment_id]
    );
    if (paymentCheck.rowCount > 0) {
      await pgClient.query('COMMIT');
      return res.json({ status: 'success', message: 'Payment already processed.' });
    }

    // Fetch Plan Details
    const planRes = await pgClient.query(
      `SELECT p.*, prod.id AS product_id 
       FROM paid_product_plans p 
       JOIN paid_products prod ON p.product_id = prod.id 
       WHERE p.id = $1`,
      [planId]
    );
    const plan = planRes.rows[0];
    if (!plan) {
      throw new Error('Target payment plan was not found.');
    }

    // 4. Record promo redemption if promoCode note is present
    const orderPromoCode = order.notes?.promoCode || null;
    let discountPaise = 0;
    if (orderPromoCode) {
      const { validateProductPromotion, recordPromotionRedemption } = await import('./auth/paidProducts.js');
      const promoResult = await validateProductPromotion(userId, orderPromoCode, plan.product_id, 'one_time', pgClient);
      if (promoResult.valid) {
        const baseAmount = parseInt(plan.price_amount_paise, 10);
        if (promoResult.promo.discount_type === 'percentage') {
          discountPaise = Math.floor(baseAmount * (promoResult.promo.discount_value / 100));
        } else if (promoResult.promo.discount_type === 'flat') {
          discountPaise = promoResult.promo.discount_value;
        }
        // Caps final price to be at least 1 INR
        const finalPriceCalculated = Math.max(100, baseAmount - discountPaise);
        discountPaise = baseAmount - finalPriceCalculated;

        await recordPromotionRedemption({
          userId,
          promotionIdOrCode: promoResult.promo.id || promoResult.promo.code,
          providerReference: razorpay_order_id,
          originalAmount: baseAmount,
          discountAmount: discountPaise,
          finalAmount: finalPriceCalculated
        }, pgClient);
      }
    }

    // Calculate Entitlement Expiration date based on Plan's duration_days DB value
    let validUntil = null;
    if (plan.duration_days) {
      const existingGrantRes = await pgClient.query(
        `SELECT MAX(valid_until) as max_until
         FROM user_product_grants
         WHERE user_id = $1 AND product_id = $2 AND status = 'active'
           AND (valid_until IS NULL OR valid_until > NOW())`,
        [userId, plan.product_id]
      );
      const maxUntil = existingGrantRes.rows[0]?.max_until;
      if (maxUntil) {
        validUntil = new Date(new Date(maxUntil).getTime() + plan.duration_days * 24 * 3600 * 1000);
      } else {
        validUntil = new Date(Date.now() + plan.duration_days * 24 * 3600 * 1000);
      }
    }

    // 5. Grant generic entitlement + Sync Product RBAC role (this handles the whole paid product framework update)
    const { recordGenericOneTimePayment } = await import('./auth/paidProducts.js');
    await recordGenericOneTimePayment({
      userId,
      productId: plan.product_id,
      planId: plan.id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: order.amount,
      currency: order.currency || 'INR',
      promoCode: orderPromoCode,
      discountPaise,
      validUntil,
      metadata: { notes: order.notes }
    }, pgClient);

    await pgClient.query('COMMIT');
    res.json({ status: 'success', message: 'Payment successfully verified and entitlement granted.' });
  } catch (err) {
    try { await pgClient.query('ROLLBACK'); } catch {}
    // F3: Handle concurrent duplicate race gracefully: unique_violation on provider ids
    if (err && (err.code === '23505' || String(err.message).includes('duplicate key'))) {
      try {
        const dupCheck = await pool.query(
          `SELECT id FROM paid_orders WHERE provider = 'razorpay' AND provider_payment_id = $1 AND status = 'paid' LIMIT 1`,
          [req.body.razorpay_payment_id]
        );
        if (dupCheck.rowCount > 0) {
          return res.json({ status: 'success', message: 'Payment already processed.' });
        }
        const orderDup = await pool.query(
          `SELECT id FROM paid_orders WHERE provider_order_id = $1 LIMIT 1`,
          [req.body.razorpay_order_id]
        );
        if (orderDup.rowCount > 0) {
          // Order already marked paid via race, verify grant exists
          const payCheck2 = await pool.query(
            `SELECT id FROM paid_orders WHERE provider_payment_id = $1 LIMIT 1`,
            [req.body.razorpay_payment_id]
          );
          if (payCheck2.rowCount > 0) return res.json({ status: 'success', message: 'Payment already processed.' });
        }
      } catch {}
    }
    console.error('Generic one-time payment verification failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    pgClient.release();
  }
});


app.post('/api/premium/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      return res.status(400).json({ status: 'error', message: 'Missing Razorpay signature' });
    }
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    // Validate signature
    const isValid = verifyRazorpayWebhookSignature(rawBody, signature, secret);
    if (!isValid) {
      return res.status(400).json({ status: 'error', message: 'Invalid Razorpay signature' });
    }
    
    const { event, id } = req.body;
    await handleSubscriptionWebhook(req.body.payload, id || `evt_${Date.now()}`, event);
    
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook processing failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated?.()) return res.redirect('/');
  res.render('login');
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));

app.post('/logout', requireSameOrigin, (req, res, next) => req.logout(error => {
  if (error) return next(error);
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
}));

app.get('/access-expired', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (isAdminUser(req.user)) return res.redirect('/');
  try {
    const r = await pool.query('SELECT status, access_expires_at FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    if (u) {
      if (u.status === 'pending') return res.redirect('/access-pending');
      if (u.status === 'revoked') return res.redirect('/access-revoked');
      const isExp = !u.access_expires_at || new Date(u.access_expires_at) <= new Date();
      if (u.status === 'active' && !isExp) return res.redirect('/');
      if (u.status !== 'expired' && !isExp) return res.redirect('/');
    }
  } catch {}
  res.render('access-expired', { user: req.user });
});

app.get('/access-pending', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (isAdminUser(req.user)) return res.redirect('/');
  try {
    const r = await pool.query('SELECT status, access_expires_at FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    if (u) {
      // Re-validate against current DB state — do not rely on stale session
      if (u.status !== 'pending') {
        if (u.status === 'revoked') return res.redirect('/access-revoked');
        const isExp = !u.access_expires_at || new Date(u.access_expires_at) <= new Date();
        if (u.status === 'expired' || isExp) return res.redirect('/access-expired');
        if (u.status === 'active') return res.redirect('/');
      }
    } else {
      // Fallback to in-memory user if DB row missing (should not happen)
      if (req.user.status !== 'pending') {
        if (req.user.status === 'revoked') return res.redirect('/access-revoked');
        if (req.user.status === 'expired') return res.redirect('/access-expired');
        return res.redirect('/');
      }
    }
  } catch {
    // On DB error, fallback to session state — preserve original behavior
    if (req.user.status !== 'pending') {
      if (req.user.status === 'revoked') return res.redirect('/access-revoked');
      if (req.user.status === 'expired') return res.redirect('/access-expired');
      return res.redirect('/');
    }
  }
  res.render('access-pending', { user: req.user });
});

app.get('/access-revoked', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (isAdminUser(req.user)) return res.redirect('/');
  try {
    const r = await pool.query('SELECT status FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    if (u) {
      if (u.status === 'pending') return res.redirect('/access-pending');
      if (u.status === 'active' || u.status === 'expired') {
        // Check expiry for active/expired distinction
        const expRes = await pool.query('SELECT status, access_expires_at FROM users WHERE id = $1', [req.user.id]);
        const eu = expRes.rows[0];
        const isExp = !eu.access_expires_at || new Date(eu.access_expires_at) <= new Date();
        if (eu.status === 'active' && !isExp) return res.redirect('/');
        if (eu.status === 'expired' || isExp) return res.redirect('/access-expired');
        return res.redirect('/');
      }
      if (u.status !== 'revoked') return res.redirect('/');
    }
  } catch {}
  res.render('access-revoked', { user: req.user });
});

app.get('/', async (req, res, next) => {
  if (req.isAuthenticated?.() && req.user) {
    return requireAuth(req, res, async () => {
      try {
        let tree, filteredTree;
        let adCtx;
        if (perfDiagnosticsEnabled) {
          req._perfTimings = req._perfTimings || {};
          let t0 = Date.now();
          tree = await getLibrary();
          req._perfTimings.getLibrary = Date.now() - t0;
          t0 = Date.now();
          filteredTree = filterTreeForUser(tree, req.user, canAccessLibraryPath);
          req._perfTimings.filterTreeForUser = Date.now() - t0;
          adCtx = adSlotViewContext(req.user, 'home', 'home-top');
          const hasNotesPromiseRaw = getHasNotesCached(req).catch(() => false);
          let tRV = Date.now(), tNC = Date.now(), tFP = Date.now(), tHN = Date.now();
          const rvP = getEnrichedRecentlyViewed(req.user, tree).catch(() => []).then(v => { req._perfTimings.getEnrichedRecentlyViewed = Date.now() - tRV; return v; });
          const ncP = getEnrichedNewContent(req.user, tree).catch(() => []).then(v => { req._perfTimings.getEnrichedNewContent = Date.now() - tNC; return v; });
          const fpP = getFolderProgressForUser(req.user, filteredTree, pool, hasNotesPromiseRaw).catch(() => ({ enabled: false, progressMap: {} })).then(v => { req._perfTimings.getFolderProgressForUser = Date.now() - tFP; return v; });
          const hnP = hasNotesPromiseRaw.then(v => { req._perfTimings.hasNotesPermission = Date.now() - tHN; return v; }).catch(() => false);
          const [recentlyViewed_, newContent_, progResult_, hasNotes_] = await Promise.all([rvP, ncP, fpP, hnP]);
          // assign to outer names via closure trick — use let
          // we need to make them accessible below, so store in req._perf stash and retrieve
          req._perfTemp = { recentlyViewed: recentlyViewed_, newContent: newContent_, progResult: progResult_, hasNotes: hasNotes_ };
        } else {
          tree = await getLibrary();
          filteredTree = filterTreeForUser(tree, req.user, canAccessLibraryPath);
          adCtx = adSlotViewContext(req.user, 'home', 'home-top');
          const hasNotesPromise = getHasNotesCached(req).catch(() => false);
          const [recentlyViewed, newContent, progResult, hasNotes] = await Promise.all([
            getEnrichedRecentlyViewed(req.user, tree).catch(() => []),
            getEnrichedNewContent(req.user, tree).catch(() => []),
            getFolderProgressForUser(req.user, filteredTree, pool, hasNotesPromise).catch(() => ({ enabled: false, progressMap: {} })),
            hasNotesPromise
          ]);
          req._perfTemp = { recentlyViewed, newContent, progResult, hasNotes };
        }
        const { recentlyViewed, newContent, progResult, hasNotes } = req._perfTemp;
        delete req._perfTemp;
        let showFolderProgress = false;
        let folderProgress = {};
        try {
          showFolderProgress = progResult.enabled;
          folderProgress = progResult.progressMap;
        } catch {}

        const pathsForLikes = [];
        if (filteredTree && filteredTree.children) {
          for (const child of filteredTree.children.values()) {
            pathsForLikes.push(child.path);
          }
        }
        if (recentlyViewed) {
          for (const rv of recentlyViewed) {
            if (rv.path) pathsForLikes.push(rv.path);
          }
        }
        if (newContent) {
          for (const nc of newContent) {
            if (nc.path) pathsForLikes.push(nc.path);
          }
        }
        let likesMap;
        if (perfDiagnosticsEnabled) {
          const tLikes = Date.now();
          likesMap = await getLikesMapForPaths(req.user.id, pathsForLikes);
          req._perfTimings.getLikesMapForPaths = Date.now() - tLikes;
        } else {
          likesMap = await getLikesMapForPaths(req.user.id, pathsForLikes);
        }

        const libraryMetadataHome = loadLibraryMetadata();
        if (filteredTree && filteredTree.children) {
          let missingHome = 0;
          for (const child of filteredTree.children.values()) { if (child.type !== 'folder' && !libraryMetadataHome[child.path]) missingHome++; }
          if (missingHome) console.warn(`[library-metadata] ${missingHome} items in "/" missing addedAt/updatedAt`);
        }

        if (perfDiagnosticsEnabled) {
          const tRender = Date.now();
          res.render('library', { 
            user: req.user, 
            tree: filteredTree, 
            folder: null, 
            path: '', 
            displayName, 
            categoryForPath, 
            recentlyViewed, 
            newContent, 
            newContentCount: newContent.length, 
            contentRouteForPath, 
            premiumEnabled: isPremiumMembershipEnabled(),
            isAdFree: hasAdFreeCapability(req.user),
            showFolderProgress,
            folderProgress,
            likesMap,
            hasNotes,
            libraryMetadata: libraryMetadataHome,
            ...adCtx 
          });
          req._perfTimings.render = Date.now() - tRender;
          perfLog(req, '/', {});
        } else {
          res.render('library', { 
            user: req.user, 
            tree: filteredTree, 
            folder: null, 
            path: '', 
            displayName, 
            categoryForPath, 
            recentlyViewed, 
            newContent, 
            newContentCount: newContent.length, 
            contentRouteForPath, 
            premiumEnabled: isPremiumMembershipEnabled(),
            isAdFree: hasAdFreeCapability(req.user),
            showFolderProgress,
            folderProgress,
            likesMap,
            hasNotes,
            libraryMetadata: libraryMetadataHome,
            ...adCtx 
          });
        }
      } catch (error) {
        console.error(error);
        res.status(500).render('error', { message: 'Unable to load the library right now.' });
      }
    });
  } else {
    res.render('landing', { 
      user: null,
      showFooter: true,
      showConnectWithUs: true
    });
  }
});

// Bare /browse (no trailing path) — unauthenticated returns 404 before; redirect to home for consistency.
// Authenticated users see library at /; this does not expose private content.
app.get('/browse', (req, res) => res.redirect(302, '/'));
app.get('/browse/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid path.' });
    let tree, filteredTree, folder;
    if (perfDiagnosticsEnabled) {
      req._perfTimings = req._perfTimings || {};
      let t0 = Date.now();
      tree = await getLibrary();
      req._perfTimings.getLibrary = Date.now() - t0;
      t0 = Date.now();
      filteredTree = filterTreeForUser(tree, req.user, canAccessLibraryPath);
      req._perfTimings.filterTreeForUser = Date.now() - t0;
      folder = folderAt(filteredTree, pathValue);
    } else {
      tree = await getLibrary();
      filteredTree = filterTreeForUser(tree, req.user, canAccessLibraryPath);
      folder = folderAt(filteredTree, pathValue);
    }
    if (folder) {
      const adCtx = adSlotViewContext(req.user, pathValue, 'browse-top');
      const pathsForLikes = [];
      if (folder && folder.children) {
        for (const child of folder.children.values()) {
          pathsForLikes.push(child.path);
        }
      }
      let progResultBrowse, likesMap, hasNotesBrowse;
      if (perfDiagnosticsEnabled) {
        const hasNotesPromiseBrowse = getHasNotesCached(req).catch(() => false);
        let tFP = Date.now(), tLikes = Date.now(), tHN = Date.now();
        const fpP = getFolderProgressForUser(req.user, filteredTree, pool, hasNotesPromiseBrowse).catch(() => ({ enabled: false, progressMap: {} })).then(v => { req._perfTimings.getFolderProgressForUser = Date.now() - tFP; return v; });
        const likesP = getLikesMapForPaths(req.user.id, pathsForLikes).then(v => { req._perfTimings.getLikesMapForPaths = Date.now() - tLikes; return v; });
        const hnP = hasNotesPromiseBrowse.then(v => { req._perfTimings.hasNotesPermission = Date.now() - tHN; return v; }).catch(() => false);
        [progResultBrowse, likesMap, hasNotesBrowse] = await Promise.all([fpP, likesP, hnP]);
      } else {
        // Parallelize independent operations after folder is known (Fix 2, Fix 4)
        const hasNotesPromiseBrowse = getHasNotesCached(req).catch(() => false);
        [progResultBrowse, likesMap, hasNotesBrowse] = await Promise.all([
          getFolderProgressForUser(req.user, filteredTree, pool, hasNotesPromiseBrowse).catch(() => ({ enabled: false, progressMap: {} })),
          getLikesMapForPaths(req.user.id, pathsForLikes),
          hasNotesPromiseBrowse
        ]);
      }
      let showFolderProgress = false;
      let folderProgress = {};
      try {
        showFolderProgress = progResultBrowse.enabled;
        folderProgress = progResultBrowse.progressMap;
      } catch {}

      const libraryMetadataBrowse = loadLibraryMetadata();
      if (folder && folder.children) {
        let missingBrowse = 0;
        for (const child of folder.children.values()) { if (child.type !== 'folder' && !libraryMetadataBrowse[child.path]) missingBrowse++; }
        if (missingBrowse) console.warn(`[library-metadata] ${missingBrowse} items in "${pathValue}" missing addedAt/updatedAt`);
      }

      if (perfDiagnosticsEnabled) {
        const tRender = Date.now();
        res.render('library', { 
          user: req.user, 
          tree: filteredTree, 
          folder, 
          path: pathValue, 
          displayName, 
          categoryForPath, 
          contentRouteForPath, 
          showFolderProgress,
          folderProgress,
          likesMap,
          hasNotes: hasNotesBrowse,
          libraryMetadata: libraryMetadataBrowse,
          ...adCtx 
        });
        req._perfTimings.render = Date.now() - tRender;
        perfLog(req, '/browse/*path', {});
        return;
      }
      return res.render('library', { 
        user: req.user, 
        tree: filteredTree, 
        folder, 
        path: pathValue, 
        displayName, 
        categoryForPath, 
        contentRouteForPath, 
        showFolderProgress,
        folderProgress,
        likesMap,
        hasNotes: hasNotesBrowse,
        libraryMetadata: libraryMetadataBrowse,
        ...adCtx 
      });
    }
    const legacy = legacyQueryPath(tree, pathValue);
    if (legacy) return res.redirect(301, '/browse/' + legacy.split('/').map(encodeURIComponent).join('/'));
    return res.status(404).render('error', { message: 'Folder not found.' });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load the library right now.' });
  }
});

app.get('/query/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid path.' });
    if (isExternalFileName(path.basename(pathValue))) return res.redirect(302, '/external/' + encodeLibraryPath(pathValue));
    if (await isBlockedCompanionRequest(pathValue)) return res.status(404).render('error', { message: 'Query not found.' });
    // Centralized content authorization — HIDDEN_FOLDERS + future access levels
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).render('error', { message: 'Query not found.' });
    const tree = await getLibrary();
    const node = findFile(tree, pathValue);
    if (node) {
      const likeState = await getLikeState(req.user.id, pathValue);
      const discussions = await listDiscussions(pathValue, 'newest', req.user.id);
      let relatedItems = [];
      try {
        relatedItems = await getRelatedContent(tree, pathValue, req.user, {
          existsAsync: relatedExistsOnDisk,
          categoryFor: categoryForPath
        });
      } catch {
        relatedItems = [];
      }
      let canCopy = false;
      try { canCopy = await hasContentPermission(req.user, PERMISSIONS.COPY_QUERY); } catch {}
      let hasNotes = false;
      let userNote = null;
      try {
        hasNotes = await hasNotesPermission(req.user);
        if (hasNotes) {
          userNote = await getNote(req.user.id, pathValue);
        }
      } catch {
        hasNotes = false;
        userNote = null;
      }
      const adCtx = adSlotViewContext(req.user, pathValue, 'query-top');
      const { cleanContent, pinned } = parsePinnedReferences(node.file.content || '');
      const fileForRender = { ...node.file, content: cleanContent };
      // Pin generator (Admin/Owner only, runtime UI state): canonical reference
      // path comes from the CURRENT item's exact library path. Null for normal
      // users so the generator UI is never rendered (server-side gate).
      const canGeneratePin = isAdminUser(req.user) || isOwnerUser(req.user);
      res.render('query', {
        user: { ...req.user, isAdmin: isAdminUser(req.user) },
        file: fileForRender,
        path: pathValue,
        displayName,
        prettyTitle: displayName,
        categoryForPath,
        likeCount: likeState.likeCount,
        liked: likeState.liked,
        discussions,
        relatedItems,
        canCopy,
        hasNotes,
        userNote,
        pinnedRefs: pinned,
        pinGen: canGeneratePin
          ? { path: pinReferencePath(pathValue), name: displayName(path.basename(pathValue)) }
          : null,
        ...adCtx
      });
      await pool.query(
        'INSERT INTO query_usage (user_id, query_path, action) VALUES ($1, $2, $3)',
        [req.user.id, pathValue, 'view']
      );
      await recordContentAccess(req.user.id, pathValue);
      try { recordMetricsContentAccess(); } catch {}
      return;
    }
    const legacy = legacyQueryPath(tree, pathValue);
    if (legacy) return res.redirect(301, '/query/' + legacy.split('/').map(encodeURIComponent).join('/'));
    return res.status(404).render('error', { message: 'Query not found.' });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load the query right now.' });
  }
});

// Video player page (authenticated).
app.get('/watch/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid path.' });
    if (isExternalFileName(path.basename(pathValue))) return res.redirect(302, '/external/' + encodeLibraryPath(pathValue));
    // Centralized content authorization — HIDDEN_FOLDERS + future access levels
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).render('error', { message: 'Video not found.' });
    const tree = await getLibrary();
    const node = findVideo(tree, pathValue);
    if (!node) return res.status(404).render('error', { message: 'Video not found.' });
    
    // Record view (deduplicated by user+video within deduplication window)
    await recordView(req.user.id, pathValue);
    
    // Get view count (deduplicated across all users, 24h window)
    const viewsResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM video_views WHERE video_path = $1`,
      [pathValue]
    );
    const viewsCount = viewsResult.rows[0].cnt;
    
    // Check if current user has liked this item
    const alreadyLiked = await pool.query(
      `SELECT id FROM item_likes WHERE item_path = $1 AND user_id = $2`,
      [pathValue, req.user.id]
    );
    const userLiked = alreadyLiked.rows.length > 0;
    
    // Get total like count for this item
    const likeCountResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM item_likes WHERE item_path = $1`,
      [pathValue]
    );
    const likeCount = likeCountResult.rows[0].cnt;

    // Discussions for this video — reuse same listing logic as query/item pages
    // so any future supported file type automatically gets Q&A when it has a detail page.
    const discussions = await listDiscussions(pathValue, 'newest', req.user.id);

    let relatedItems = [];
    try {
      relatedItems = await getRelatedContent(tree, pathValue, req.user, {
        existsAsync: relatedExistsOnDisk,
        categoryFor: categoryForPath
      });
    } catch {
      relatedItems = [];
    }

    let hasNotes = false;
    let userNote = null;
    try {
      hasNotes = await hasNotesPermission(req.user);
      if (hasNotes) {
        userNote = await getNote(req.user.id, pathValue);
      }
    } catch {
      hasNotes = false;
      userNote = null;
    }

    const adCtxVideo = adSlotViewContext(req.user, pathValue, 'watch-top');
    res.render('video', {
      user: { ...req.user, isAdmin: isAdminUser(req.user) },
      file: node.file,
      path: pathValue,
      displayName,
      prettyTitle,
      categoryForPath,
      videoMimeType,
      viewsCount,
      likeCount,
      userLiked,
      discussions,
      relatedItems,
      hasNotes,
      userNote,
      ...adCtxVideo,
      videoProtection: buildVideoProtectionContext(req, pathValue, 'video'),
      videoBranding: getVideoBranding(pathValue),
      canConfigureBranding: isAdminUser(req.user) || isOwnerUser(req.user)
    });
    await touchVideoProtectionSession(req);
    await recordContentAccess(req.user.id, pathValue);
    try { recordMetricsContentAccess(); } catch {}
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load the video right now.' });
  }
});

// Get a map of { item_path: { liked: boolean, likeCount: number } } for a list of paths.
async function getLikesMapForPaths(userId, paths) {
  const likesMap = {};
  if (!paths || paths.length === 0) return likesMap;

  // De-duplicate paths and initialize default values
  const uniquePaths = [...new Set(paths)].filter(Boolean);
  for (const p of uniquePaths) {
    likesMap[p] = { liked: false, likeCount: 0 };
  }

  if (uniquePaths.length === 0) return likesMap;

  try {
    const [countsResult, userLikedResult] = await Promise.all([
      pool.query(
        `SELECT item_path, COUNT(*)::int AS cnt FROM item_likes WHERE item_path = ANY($1) GROUP BY item_path`,
        [uniquePaths]
      ),
      userId ? pool.query(
        `SELECT item_path FROM item_likes WHERE user_id = $1 AND item_path = ANY($2)`,
        [userId, uniquePaths]
      ) : { rows: [] }
    ]);

    for (const r of countsResult.rows) {
      if (likesMap[r.item_path]) {
        likesMap[r.item_path].likeCount = r.cnt;
      }
    }
    for (const r of userLikedResult.rows) {
      if (likesMap[r.item_path]) {
        likesMap[r.item_path].liked = true;
      }
    }
  } catch (err) {
    console.error('[likesMap] Error fetching likes map:', err);
  }
  return likesMap;
}

// Video streaming (authenticated, Range-capable, chunked). The queries
// directory is never mounted as a static route: only these handlers serve it.
// Like/unlike ANY library item (video, pdf, doc, xls, txt, ...).
// Part 3 — COMMON LIKE API. Gated by Notes permission (reuse hasNotesPermission).
async function handleLikeToggle(req, res) {
  let pathValue = req.params.path;
  if (Array.isArray(pathValue)) pathValue = pathValue.join('/');
  // Gate by Notes permission — reuse existing effective-role resolver.
  try {
    const canLike = await hasNotesPermission(req.user);
    if (!canLike) return res.status(403).json({ error: 'Notes permission required.' });
  } catch {
    return res.status(403).json({ error: 'Notes permission required.' });
  }
  // Same safety net used by every library route.
  if (!isSafeLibraryPath(pathValue)) return res.status(400).json({ error: 'Invalid item path.' });
  if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).json({ error: 'Item not found.' });
  if (!(await itemExistsInLibrary(pathValue))) return res.status(404).json({ error: 'Item not found.' });
  try {
    res.json(await toggleLike(req.user.id, pathValue));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to process like.' });
  }
}

app.post('/api/like/*path', requireAuth, handleLikeToggle);
// Backward-compatible alias used by the original video page.
app.post('/video/*path/like', requireAuth, handleLikeToggle);

// Video streaming (authenticated, Range-capable, chunked). The queries
// directory is never mounted as a static route: only these handlers serve it.
app.get('/video/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).json({ error: 'Invalid video path.' });
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).json({ error: 'Video not found.' });
    const tree = await getLibrary();
    if (!findVideo(tree, pathValue)) return res.status(404).json({ error: 'Video not found.' });
    const absPath = resolveLibraryPath(pathValue);
    if (!absPath) return res.status(400).json({ error: 'Invalid video path.' });
    await streamVideoFile(res, absPath, req.headers.range);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (!res.headersSent) return res.status(404).json({ error: 'Video not found.' });
      return res.destroy?.();
    }
    console.error(error);
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to stream video.' });
    res.destroy?.();
  }
});

app.get('/api/search', requireApiAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    const tree = await getLibrary();
    const results = searchFilesFiltered(tree, q, req.user, canAccessLibraryPath).slice(0, 50).map(file => ({
      path: file.path,
      title: file.type === 'external' ? (file.friendlyName || displayName(path.basename(file.path).replace(/^external - /i,'').trim())) : displayName(path.basename(file.path)),
      category: categoryForPath(file.path),
      snippet: file.type === 'external' ? (file.friendlyName || '').replace(/\s+/g, ' ').slice(0, 240) : (file.content || '').replace(/\s+/g, ' ').slice(0, 240)
    }));
    res.json({ results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.post('/api/query-copy', requireApiAuth, requireSameOrigin, async (req, res) => {
  const queryPath = String(req.body.path || '').trim();
  if (!queryPath.toLowerCase().endsWith('.txt') || !isSafeLibraryPath(queryPath)) {
    return res.status(400).json({ error: 'Invalid query path.' });
  }

  try {
    if (!canAccessLibraryPath(req.user, queryPath)) return res.status(404).json({ error: 'Query not found.' });
    const tree = await getLibrary();
    if (!findFile(tree, queryPath)) {
      return res.status(404).json({ error: 'Query not found.' });
    }
    let allowed = false;
    try { allowed = await hasContentPermission(req.user, PERMISSIONS.COPY_QUERY); } catch { allowed = false; }
    if (!allowed) return res.status(403).json({ error: 'Copy permission required.' });
    await pool.query(
      'INSERT INTO query_usage (user_id, query_path, action) VALUES ($1, $2, $3)',
      [req.user.id, queryPath, 'copy']
    );
    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to record query copy.' });
  }
});

// Short Share Links — any authenticated user with access to the exact item
// path gets (or reuses) its stable opaque code. Companion/hidden _1.txt
// metadata files are rejected and never receive share links. The code itself
// grants nothing; opening /s/<code> redirects to the canonical route, which
// re-applies the full authentication + authorization checks.
app.post('/api/share', requireApiAuth, express.json(), async (req, res) => {
  try {
    const itemPath = String(req.body?.itemPath || '').trim();
    if (!itemPath || !isSafeLibraryPath(itemPath)) {
      return res.status(400).json({ error: 'Invalid item path.' });
    }
    if (await isBlockedCompanionRequest(itemPath)) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    if (!canAccessLibraryPath(req.user, itemPath)) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    if (!(await shareTargetExists(itemPath))) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    let code;
    try {
      code = await getOrCreateShareCode(itemPath, req.user?.id ?? null);
    } catch (error) {
      if (error?.code === '42P01') {
        return res.status(500).json({ error: 'Share links are not available yet.' });
      }
      throw error;
    }
    return res.json({ ok: true, code, urlPath: `/s/${code}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to create share link.' });
  }
});

// Resolve a short share link. Authenticated users only; unknown codes 404.
// Known codes redirect (302) to the canonical content route, which enforces
// the existing authorization/entitlement checks — the link grants no access.
app.get('/s/:code', requireAuth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!isValidShareCode(code)) {
      return res.status(404).render('error', { message: 'Share link not found.' });
    }
    let filePath = null;
    try {
      filePath = await findShareTarget(code);
    } catch (error) {
      if (error?.code === '42P01') {
        return res.status(500).render('error', { message: 'Share links are not available yet.' });
      }
      throw error;
    }
    if (!filePath) {
      return res.status(404).render('error', { message: 'Share link not found.' });
    }
    return res.redirect(302, contentRouteForPath(filePath) + encodeLibraryPath(filePath));
  } catch (error) {
    console.error(error);
    return res.status(500).render('error', { message: 'Unable to open share link.' });
  }
});

// A share target is a real library FILE: a tree leaf (query, video or
// external) or an on-disk file. Directories, unknown types and missing
// paths are rejected.
async function shareTargetExists(pathValue) {
  try {
    const tree = await getLibrary();
    if (findVideo(tree, pathValue) || findFile(tree, pathValue) || findExternal(tree, pathValue)) return true;
    const absPath = resolveLibraryPath(pathValue);
    if (!absPath) return false;
    try {
      const stats = await stat(absPath);
      if (!stats.isFile()) return false;
    } catch {
      return false;
    }
    const typeInfo = getFileTypeFromFilename(path.basename(absPath));
    return typeInfo.type !== 'unknown' && !!typeInfo.info.downloadable;
  } catch {
    return false;
  }
}

// Generic item page for non-text, non-video library files
// (pdf, docs, spreadsheets, presentations, images, archives, ...).
app.get('/item/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid item path.' });
    if (await isBlockedCompanionRequest(pathValue)) return res.status(404).render('error', { message: 'Item not found.' });
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).render('error', { message: 'Item not found.' });
    const absPath = resolveLibraryPath(pathValue);
    if (!absPath) return res.status(400).render('error', { message: 'Invalid item path.' });
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return res.status(404).render('error', { message: 'Item not found.' });
    }
    if (!stats.isFile()) return res.status(404).render('error', { message: 'Item not found.' });
    const typeInfo = getFileTypeFromFilename(path.basename(absPath));
    if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) {
      return res.status(404).render('error', { message: 'This file type is not supported.' });
    }
    const likeState = await getLikeState(req.user.id, pathValue);
    const discussions = await listDiscussions(pathValue, 'newest', req.user.id);
    let relatedItems = [];
    try {
      const tree = await getLibrary();
      relatedItems = await getRelatedContent(tree, pathValue, req.user, {
        existsAsync: relatedExistsOnDisk,
        categoryFor: categoryForPath
      });
    } catch {
      relatedItems = [];
    }
    let canDownload = false;
    try {
      if (typeInfo.type === 'pdf') {
        canDownload = await hasContentPermission(req.user, PERMISSIONS.DOWNLOAD_PDF);
      } else {
        // Non-PDF files: download not gated by DOWNLOAD_PDF (only PDFs have this permission)
        canDownload = true;
      }
    } catch { canDownload = false; }
    let hasNotes = false;
    let userNote = null;
    try {
      hasNotes = await hasNotesPermission(req.user);
      if (hasNotes) {
        userNote = await getNote(req.user.id, pathValue);
      }
    } catch {
      hasNotes = false;
      userNote = null;
    }

    const isAuthorizedToDownload = isAdminUser(req.user) || isOwnerUser(req.user);
    const showDownloadButton = isAuthorizedToDownload;
    // canDownload could also be restricted, though if it's purely UI requirement, showDownloadButton handles the view.
    canDownload = true;
    // v1 Pins: embedded (txt/md/docx read-only) + sidecar (pdf/xlsx/docx
    // fallback). Never throws: failures resolve to [] and the existing
    // pinned-references partial renders nothing.
    let pinnedRefs = [];
    try {
      pinnedRefs = await getPinnedForItem(pathValue);
    } catch {
      pinnedRefs = [];
    }
    const adCtxItem = adSlotViewContext(req.user, pathValue, 'item-top');
    // Pin generator (Admin/Owner only, runtime UI state) — see GET /query/*.
    const canGeneratePinItem = isAdminUser(req.user) || isOwnerUser(req.user);
    res.render('item', {
      user: { ...req.user, isAdmin: isAdminUser(req.user) },
      itemPath: pathValue,
      fileName: path.basename(absPath),
      pinGen: canGeneratePinItem
        ? { path: pinReferencePath(pathValue), name: prettyTitle(path.basename(absPath)) }
        : null,
      sizeText: formatBytes(stats.size),
      typeLabel: getTypeDisplayName(typeInfo.type),
      viewable: typeInfo.info.viewable,
      canRenderInBrowser: typeInfo.type === 'document' && path.extname(absPath).toLowerCase() === '.doc' ? false : typeInfo.info.canRenderInBrowser,
      likeCount: likeState.likeCount,
      liked: likeState.liked,
      displayName,
      prettyTitle,
      categoryForPath,
      fileHref: '/file/' + encodeLibraryPath(pathValue),
      downloadHref: '/download/' + encodeLibraryPath(pathValue),
      discussions,
      relatedItems,
      canDownload,
      showDownloadButton,
      hasNotes,
      userNote,
      pinnedRefs,
      ...adCtxItem
    });
    await recordContentAccess(req.user.id, pathValue);
    try { recordMetricsContentAccess(); } catch {}
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load the item.' });
  }
});

// External resources – repository convention "External - Name.txt" (Windows-safe) with URL inside
// No DB, RBAC via folder permissions, path safety via isSafeLibraryPath
app.get('/external/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid item path.' });
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).render('error', { message: 'Item not found.' });
    const tree = await getLibrary();
    const node = findExternal(tree, pathValue);
    if (!node || !node.file) return res.status(404).render('error', { message: 'External resource not found.' });
    const file = node.file;
    const externalUrl = String(file.externalUrl || '').trim();
    if (!isValidExternalUrl(externalUrl)) {
      return res.status(400).render('error', { message: 'External URL is invalid or not http/https.' });
    }
    const youtubeId = extractYouTubeId(externalUrl);
    const isYouTube = !!youtubeId;
    const isBlogger = !isYouTube && isBloggerUrl(externalUrl);
    const driveFileId = !isYouTube && !isBlogger ? extractDriveFileId(externalUrl) : null;
    const isDrive = !!driveFileId;
    const drivePreviewUrl = driveFileId ? `https://drive.google.com/file/d/${driveFileId}/preview` : null;
    const friendlyName = file.friendlyName || getExternalFriendlyName(file.name || path.basename(pathValue));
    const pinnedRefs = Array.isArray(file.pinned) ? file.pinned : [];
    // For YouTube, generate opaque token – HTML must NOT contain real videoId or externalUrl
    let externalVideoToken = null;
    let renderExternalUrl = externalUrl;
    let renderYoutubeId = youtubeId;
    if (isYouTube) {
      externalVideoToken = createExternalVideoToken({ youtubeId, itemPath: pathValue, externalUrl });
      // Do not expose real ID/URL in initial HTML
      renderExternalUrl = null;
      renderYoutubeId = null;
    }
    // Reuse existing engagement features (likes, discussions, notes) for external
    const likeState = await getLikeState(req.user.id, pathValue).catch(() => ({ liked: false, likeCount: 0 }));
    const discussions = await listDiscussions(pathValue, 'newest', req.user.id).catch(() => []);
    let relatedItems = [];
    try {
      const t = tree;
      relatedItems = await getRelatedContent(t, pathValue, req.user, { existsAsync: relatedExistsOnDisk, categoryFor: categoryForPath });
    } catch { relatedItems = []; }
    let hasNotes = false;
    let userNote = null;
    try {
      hasNotes = await hasNotesPermission(req.user);
      if (hasNotes) userNote = await getNote(req.user.id, pathValue);
    } catch { hasNotes = false; }
    const adCtx = adSlotViewContext(req.user, pathValue, 'item-top');
    // Pin generator (Admin/Owner only, runtime UI state) — see GET /query/*.
    // External references use the /external/ route and the friendly name.
    const canGeneratePinExternal = isAdminUser(req.user) || isOwnerUser(req.user);
    // Protection stays role-based unless explicitly forced on; the pill has
    // its own visibility so Watermark:false hides ONLY the watermark overlay
    // while shields, toolbars, scripts and branding keep working.
    const extProtection = buildVideoProtectionContext(req, pathValue, isYouTube ? 'youtube' : 'external', { forceWatermark: file.watermark === true ? true : null });
    // Render-time visibility: Watermark:false hides the pill AND the brand
    // overlay (the stored branding entry is untouched). Shields, toolbars,
    // scripts and playback keep following protection/branding behavior.
    const extBranding = getVideoBranding(pathValue);
    res.render('external', {
      user: { ...req.user, isAdmin: isAdminUser(req.user) },
      itemPath: pathValue,
      fileName: file.name,
      friendlyName,
      pinGen: canGeneratePinExternal
        ? { path: pinReferencePath(pathValue), name: friendlyName }
        : null,
      externalUrl: renderExternalUrl,
      youtubeId: renderYoutubeId,
      externalVideoToken,
      isYouTube,
      isBlogger,
      isDrive,
      drivePreviewUrl,
      pinnedRefs,
      isValidUrl: true,
      likeCount: likeState.likeCount,
      liked: likeState.liked,
      discussions,
      relatedItems,
      hasNotes,
      userNote,
      displayName,
      prettyTitle,
      categoryForPath,
      getExternalFriendlyName,
      ...adCtx,
      videoProtection: extProtection,
      showWatermark: resolveWatermarkVisible({ fileWatermark: file.watermark ?? null, protectionEnabled: extProtection.enabled }),
      showBranding: resolveBrandOverlayVisible({ fileWatermark: file.watermark ?? null, brandingEnabled: extBranding.enabled !== false }),
      videoBranding: extBranding,
      canConfigureBranding: isAdminUser(req.user) || isOwnerUser(req.user)
    });
    await touchVideoProtectionSession(req);
    await recordContentAccess(req.user.id, pathValue);
    try { recordMetricsContentAccess(); } catch {}
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load external resource.' });
  }
});

// Resolve opaque token to YouTube embed URL – obfuscation, not security (still RBAC protected)
app.get('/api/external-video/:token', requireApiAuth, async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const entry = resolveExternalVideoToken(token);
    if (!entry) return res.status(404).json({ error: 'Invalid or expired token.' });
    if (!isSafeLibraryPath(entry.itemPath)) return res.status(404).json({ error: 'Not found.' });
    if (!canAccessLibraryPath(req.user, entry.itemPath)) return res.status(404).json({ error: 'Not found.' });
    // Re-validate that the underlying file is still an external YouTube resource
    const tree = await getLibrary();
    const node = findExternal(tree, entry.itemPath);
    if (!node || !node.file) return res.status(404).json({ error: 'Not found.' });
    if (!isValidExternalUrl(entry.externalUrl)) return res.status(404).json({ error: 'Not found.' });
    const currentId = extractYouTubeId(entry.externalUrl);
    if (!currentId || currentId !== entry.youtubeId) return res.status(404).json({ error: 'Not found.' });
    const embedUrl = `https://www.youtube-nocookie.com/embed/${entry.youtubeId}?rel=0&fs=0&enablejsapi=1`;
    return res.json({ embedUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to resolve video.' });
  }
});

// Serve the original library file bytes (PDF, docs, spreadsheets, images, ...).
// Preview endpoint — inline viewing only. Requires authentication + folder access but
// NOT DOWNLOAD_PDF. The dedicated /download route enforces DOWNLOAD_PDF for PDFs.
// Limitation: when a PDF is streamed inline via /file, the browser's native PDF
// viewer offers its own download/print button. This cannot be blocked without
// browser-level DRM, which is intentionally not attempted.
app.get('/file/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).json({ error: 'Invalid file path.' });
    if (isExternalFileName(path.basename(pathValue))) return res.status(404).json({ error: 'External resources not available via file endpoint.' });
    if (await isBlockedCompanionRequest(pathValue)) return res.status(404).json({ error: 'File not found.' });
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).json({ error: 'File not found.' });
    const absPath = resolveLibraryPath(pathValue);
    if (!absPath) return res.status(400).json({ error: 'Invalid file path.' });
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return res.status(404).json({ error: 'File not found.' });
    }
    if (!stats.isFile()) return res.status(404).json({ error: 'File not found.' });
    const typeInfo = getFileTypeFromFilename(path.basename(absPath));
    if (typeInfo.type === 'unknown') return res.status(404).json({ error: 'Unsupported file type.' });

    if (typeInfo.type === 'document' && path.extname(absPath).toLowerCase() === '.docx') {
      try {
        const result = await mammoth.convertToHtml({ path: absPath });
        // v1 Pins: hide embedded Pin paragraphs from the HTML preview. The
        // .docx bytes are never modified; pins render via the Pinned section
        // on the /item page instead.
        try {
          result.value = stripPinnedParagraphsFromHtml(result.value);
        } catch {}
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${encodeURIComponent(path.basename(absPath))}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem; color: #334155; line-height: 1.6; max-width: 800px; margin: 0 auto; background: #fff; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
    th, td { border: 1px solid #cbd5e1; padding: 0.5rem; }
    img { max-width: 100%; height: auto; display: block; margin: 1rem 0; }
    h1, h2, h3, h4 { color: #0f172a; }
  </style>
</head>
<body>
  ${result.value}
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (err) {
        console.error('DOCX conversion failed:', err);
        // Fall back to standard download stream if conversion fails
      }
    }

    const mimeType = typeInfo.type === 'text' ? 'text/plain' : getMimeType(typeInfo.type);
    const inline = typeInfo.info.viewable === true;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(path.basename(absPath))}"`);
    if (typeInfo.type === 'pdf') { try { recordPdfPreview(); } catch {} }
    try { recordMetricsContentAccess(); } catch {}
    createReadStream(absPath).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to serve file.' });
    res.destroy?.();
  }
});

// Dedicated download endpoint — enforces DOWNLOAD_PDF for PDFs server-side.
// Preview via /file remains available without DOWNLOAD_PDF; download via
// /download requires DOWNLOAD_PDF (OWNER/ADMIN always allowed). Folder
// permissions still authoritative (AND condition). Non-PDF files not gated
// by DOWNLOAD_PDF. Limitation: PDF inline preview via /file still exposes
// the browser viewer's native download button — no DRM.
app.get('/download/*path', requireAuth, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!isSafeLibraryPath(pathValue)) return res.status(400).json({ error: 'Invalid file path.' });
    if (isExternalFileName(path.basename(pathValue))) return res.status(404).json({ error: 'External resources not available via download endpoint.' });
    if (await isBlockedCompanionRequest(pathValue)) return res.status(404).json({ error: 'File not found.' });
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).json({ error: 'File not found.' });
    const absPath = resolveLibraryPath(pathValue);
    if (!absPath) return res.status(400).json({ error: 'Invalid file path.' });
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return res.status(404).json({ error: 'File not found.' });
    }
    if (!stats.isFile()) return res.status(404).json({ error: 'File not found.' });
    const typeInfo = getFileTypeFromFilename(path.basename(absPath));
    if (typeInfo.type === 'unknown') return res.status(404).json({ error: 'Unsupported file type.' });

    let isAuthorized = isAdminUser(req.user) || isOwnerUser(req.user);
    if (!isAuthorized) {
      try { isAuthorized = await hasContentPermission(req.user, PERMISSIONS.DOWNLOAD_PDF); } catch { isAuthorized = false; }
    }
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Download permission required. Only Admins and Owners can download files.' });
    }

    const mimeType = typeInfo.type === 'text' ? 'text/plain' : getMimeType(typeInfo.type);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(absPath))}"`);
    if (typeInfo.type === 'pdf') { try { recordPdfDownload(); } catch {} }
    try { recordMetricsContentAccess(); } catch {}
    createReadStream(absPath).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to serve file.' });
    res.destroy?.();
  }
});

// My Liked Items — every library item the current user liked, with a link to
// the appropriate existing page for that file type.
// Gated by Notes permission — reuse hasNotesPermission (effective roles).
app.get('/my/likes', requireAuth, async (req, res) => {
  try {
    const canLike = await hasNotesPermission(req.user);
    if (!canLike) return res.status(403).render('error', { message: 'You do not have permission to view liked items.' });
  } catch {
    return res.status(403).render('error', { message: 'You do not have permission to view liked items.' });
  }
  try {
    const likedResult = await pool.query(
      `SELECT item_path, created_at FROM item_likes WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    const tree = await getLibrary();
    const items = [];
    for (const row of likedResult.rows) {
      const itemPath = row.item_path;
      if (!isSafeLibraryPath(itemPath)) continue;
      if (!canAccessLibraryPath(req.user, itemPath)) continue;
      if (!(await itemExistsInLibrary(itemPath))) continue;
      // External resources use friendlyName and external route (mirrors getEnrichedRecentlyViewed)
      const extNode = findExternal(tree, itemPath);
      if (extNode) {
        items.push({
          path: itemPath,
          name: extNode.file.friendlyName || itemPath.split('/').at(-1).replace(/^external - /i, '').trim(),
          typeLabel: 'External',
          kind: 'external',
          href: '/external/' + encodeLibraryPath(itemPath),
          likedAt: row.created_at
        });
        continue;
      }
      const typeInfo = getFileTypeFromFilename(itemPath.split('/').at(-1));
      if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) continue;
      const name = itemPath.split('/').at(-1);
      let kind = typeInfo.type;
      let href;
      if (findVideo(tree, itemPath)) {
        kind = 'video';
        href = '/watch/' + encodeLibraryPath(itemPath);
      } else if (findFile(tree, itemPath)) {
        kind = 'text';
        href = '/query/' + encodeLibraryPath(itemPath);
      } else {
        href = '/item/' + encodeLibraryPath(itemPath);
      }
      items.push({
        path: itemPath,
        name,
        typeLabel: kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : getTypeDisplayName(typeInfo.type),
        kind,
        href,
        likedAt: row.created_at
      });
    }
    const pathsForLikes = items.map(item => item.path);
    const likesMap = await getLikesMapForPaths(req.user.id, pathsForLikes);
    let hasNotes = false;
    try { hasNotes = await hasNotesPermission(req.user); } catch { hasNotes = false; }
    res.render('liked', { user: req.user, items, displayName, categoryForPath, prettyTitle, likesMap, hasNotes });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load your liked items.' });
  }
});

// My Notes — every library item note saved by the current user, requiring BOTH
// active paid-product/entitlement access and library folder/file permission.
app.get('/my/notes', requireAuth, async (req, res) => {
  if (!hasUserActiveAccess(req.user)) {
    if (req.user?.status === 'pending') return res.redirect('/access-pending');
    if (req.user?.status === 'revoked') return res.redirect('/access-revoked');
    return res.redirect('/access-expired');
  }
  try {
    const notesResult = await pool.query(
      `SELECT id, question_key, question_text, note_text, updated_at, created_at 
       FROM interview_question_notes 
       WHERE user_id = $1 
       ORDER BY updated_at DESC`,
      [req.user.id]
    );
    const tree = await getLibrary();
    const items = [];
    for (const row of notesResult.rows) {
      const itemPath = row.question_key;
      if (!isSafeLibraryPath(itemPath)) continue;
      if (!hasUserActiveAccess(req.user) || !canAccessLibraryPath(req.user, itemPath)) continue;
      if (!(await itemExistsInLibrary(itemPath))) continue;
      const typeInfo = getFileTypeFromFilename(itemPath.split('/').at(-1));
      if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) continue;
      const name = itemPath.split('/').at(-1);
      let kind = typeInfo.type;
      let href;
      if (findVideo(tree, itemPath)) {
        kind = 'video';
        href = '/watch/' + encodeLibraryPath(itemPath);
      } else if (findFile(tree, itemPath)) {
        kind = 'text';
        href = '/query/' + encodeLibraryPath(itemPath);
      } else {
        href = '/item/' + encodeLibraryPath(itemPath);
      }
      items.push({
        id: row.id,
        path: itemPath,
        name,
        questionText: row.question_text || name,
        noteText: row.note_text,
        typeLabel: kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : getTypeDisplayName(typeInfo.type),
        kind,
        href,
        updatedAt: row.updated_at,
        createdAt: row.created_at
      });
    }
    let hasNotesForHeader = false;
    try { hasNotesForHeader = await hasNotesPermission(req.user); } catch { hasNotesForHeader = false; }
    res.render('notes', { user: req.user, items, displayName, categoryForPath, prettyTitle, hasNotes: hasNotesForHeader });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load your notes.' });
  }
});

// New / Missed Content — individual items added after the user's first login
// that the user has never opened. Uses req.user.id only (never a client user
// ID). Viewing this list does NOT mark anything seen; only opening the actual
// content (/query, /watch, /item) marks it seen via recordContentAccess.
app.get('/my/new-content', requireAuth, async (req, res) => {
  try {
    const tree = await getLibrary();
    const items = await getEnrichedNewContent(req.user, tree);
    const pathsForLikes = items.map(item => item.path);
    const likesMap = await getLikesMapForPaths(req.user.id, pathsForLikes);
    let hasNotesNC = false;
    try { hasNotesNC = await hasNotesPermission(req.user); } catch { hasNotesNC = false; }
    res.render('new-content', { user: req.user, items, displayName, prettyTitle, categoryForPath, likesMap, hasNotes: hasNotesNC });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load new content.' });
  }
});

// Ignore ALL — batch dismiss all currently eligible new/missed items for the
// current user only. Must be registered BEFORE the wildcard ignore/:path route
// so POST /my/new-content/ignore-all is not captured by the wildcard.
// Uses req.user.id only. Validates any client-supplied paths against the
// server-computed eligible set (access-controlled, existence, type, mtime) so
// arbitrary paths cannot be injected. Single DB round-trip via
// markContentsIgnored (no N+1), idempotent, never touches recently_viewed.
// After success, redirects to Home (/) where the banner lives.
app.post('/my/new-content/ignore-all', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const tree = await getLibrary();
    // Server-computed eligible set is the source of truth (fetch all eligible without count limit).
    const eligible = await getEnrichedNewContent(req.user, tree, { limit: null });
    const eligibleSet = new Set(eligible.map(i => i.path));
    if (eligibleSet.size === 0) return res.redirect('/');

    // Client may submit paths (one hidden input per item, or a single
    // comma-separated field). We intersect with eligibleSet — never trust
    // arbitrary client paths.
    let submitted = null;
    const raw = req.body?.paths;
    if (raw !== undefined && raw !== null) {
      const collected = [];
      if (Array.isArray(raw)) {
        for (const v of raw) {
          if (typeof v !== 'string') continue;
          // Each array entry may itself be comma-separated (single-field case)
          for (const part of v.split(',')) {
            const t = part.trim();
            if (t) collected.push(t);
          }
        }
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed) {
          for (const part of trimmed.split(',')) {
            const t = part.trim();
            if (t) collected.push(t);
          }
        }
      }
      if (collected.length > 0) submitted = collected;
    } else if (typeof req.query?.paths === 'string' && req.query.paths.trim()) {
      // Back-compat: earlier iteration accepted ?paths=... — still intersect.
      submitted = req.query.paths.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Ignore All means dismiss everything currently eligible, not just what
    // the client submitted. Submitted paths are validated for security but
    // do not limit the operation — this makes the banner's hidden inputs
    // optional and fixes the case where they are not submitted or are
    // filtered incorrectly. The server-computed eligibleSet is the source
    // of truth.
    let pathsToIgnore = [...eligibleSet];
    if (submitted) {
      // Validate submitted paths are a subset of eligible for security;
      // log or ignore invalid entries but still dismiss all eligible.
      // This prevents an attacker from injecting arbitrary paths — we only
      // ever ignore paths that are in eligibleSet and pass safety checks.
      const seen = new Set();
      for (const p of submitted) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (!eligibleSet.has(p)) continue;
        if (!isSafeLibraryPath(p)) continue;
        if (!canAccessLibraryPath(req.user, p)) continue;
      }
      // Even if submitted contains invalid paths, we still ignore all
      // eligible — the banner's intent is to dismiss all.
    }

    try {
      await markContentsIgnored(req.user.id, pathsToIgnore);
    } catch (error) {
      console.error(error);
      return res.status(500).render('error', { message: 'Unable to ignore items.' });
    }
    return res.redirect('/');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return res.status(500).render('error', { message: 'Unable to ignore items.' });
  }
});

// Ignore / dismiss a New-Content item for the current user only.
// Uses req.user.id (never a client-supplied user ID), so users can only
// ignore their own items. Records 'ignored' state: the item leaves New /
// Missed Content without being added to recently_viewed and without being
// treated as viewed. Viewing the list never ignores; only this action does.
app.post('/my/new-content/ignore/*path', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    let pathValue = req.params.path;
    if (Array.isArray(pathValue)) pathValue = pathValue.join('/');
    // Same safety net used by every library route.
    if (!isSafeLibraryPath(pathValue)) return res.status(400).render('error', { message: 'Invalid item path.'});
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).render('error', { message: 'Item not found.'});
    if (!(await itemExistsInLibrary(pathValue))) return res.status(404).render('error', { message: 'Item not found.'});
    const base = pathValue.split('/').at(-1) || pathValue;
    const typeInfo = getFileTypeFromFilename(base);
    if (typeInfo.type === 'unknown' || !typeInfo.info.downloadable) {
      return res.status(404).render('error', { message: 'Item not found.'});
    }
    try {
      await markContentIgnored(req.user.id, pathValue);
    } catch (error) {
      console.error(error);
      return res.status(500).render('error', { message: 'Unable to ignore item.'});
    }
    return res.redirect('/my/new-content');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return res.status(500).render('error', { message: 'Unable to ignore item.'});
  }
});

// Clear Recently Viewed — delete only the current user's history.
// Reuses existing recently_viewed table, no migration. Protected by
// requireAuth + requireSameOrigin, uses only req.user.id (never client
// user_id). Redirects to Home where the section disappears when empty.
app.post('/my/recently-viewed/clear', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    await pool.query('DELETE FROM recently_viewed WHERE user_id = $1', [req.user.id]);
  } catch (error) {
    console.error(error);
  }
  return res.redirect('/');
});

app.get('/admin/likes/*path', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pathValue = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    if (!canAccessLibraryPath(req.user, pathValue)) return res.status(404).json({ error: 'Item not found.' });
    
    const likers = await pool.query(`
      SELECT u.email, u.name, i.created_at
      FROM item_likes i
      JOIN users u ON i.user_id = u.id
      WHERE i.item_path = $1
      ORDER BY i.created_at DESC
    `, [pathValue]);
    
    res.json({ likers: likers.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to retrieve liker information.' });
  }
});

// === ADMIN: RBAC folder permissions ===

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getPremiumRoleId() {
  try {
    await pool.query(`INSERT INTO roles (name, description) VALUES ('PREMIUM', 'Built-in Premium role') ON CONFLICT (name) DO NOTHING`);
  } catch {}
  try {
    const res = await pool.query(`SELECT id FROM roles WHERE name = 'PREMIUM'`);
    if (res.rowCount > 0) return Number(res.rows[0].id);
  } catch {}
  return -1;
}

app.get('/admin/folders', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Ensure built-in PREMIUM role exists (idempotent, no duplicate)
    try {
      await pool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('PREMIUM', 'Built-in Premium role', false, false, true) ON CONFLICT (name) DO NOTHING`);
    } catch {}
    try {
      await pool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Active', 'System-managed active user role', false, false, false) ON CONFLICT (name) DO NOTHING`);
    } catch {}
    try {
      await pool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('Expired', 'System-managed expired user role', true, false, false) ON CONFLICT (name) DO NOTHING`);
    } catch {}
    const [rolesResult, usersResult, userRolesResult, folderPermsResult, folderRolesResult] = await Promise.all([
      pool.query('SELECT id, name, description, created_at, COALESCE(ads_available, FALSE) as ads_available, COALESCE(default_role, FALSE) as default_role, COALESCE(notes_available, FALSE) as notes_available FROM roles ORDER BY name'),
      pool.query('SELECT id, email, name FROM users ORDER BY email'),
      pool.query('SELECT user_id, role_id FROM user_roles'),
      pool.query('SELECT id, folder_path, access_level, created_at FROM folder_permissions ORDER BY folder_path'),
      pool.query('SELECT folder_path, role_id FROM folder_roles')
    ]);
    // Enrich users with app_role for Premium tag and protection (preserve existing query for mock compatibility)
    let appRoleMap = new Map();
    try {
      const appRoleRes = await pool.query('SELECT id, app_role FROM users');
      for (const row of appRoleRes.rows) appRoleMap.set(Number(row.id), row.app_role);
    } catch {}
    // Merge app_role into users
    const usersEnriched = usersResult.rows.map(u => ({ ...u, app_role: appRoleMap.get(Number(u.id)) || null }));

    let roles = rolesResult.rows.map(role => ({ ...role, id: Number(role.id), ads_available: Boolean(role.ads_available), default_role: Boolean(role.default_role), notes_available: Boolean(role.notes_available) }));
    // Inject built-in PREMIUM if not present (handles mocked DB / legacy without row)
    if (!roles.some(r => r.name === 'PREMIUM')) {
      roles.push({ id: -1, name: 'PREMIUM', description: 'Built-in Premium role', ads_available: false, default_role: false, notes_available: true, created_at: new Date().toISOString(), isBuiltIn: true });
      // Keep alphabetical order for display consistency
      roles.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // Mark existing PREMIUM as built-in for UI protection
      roles = roles.map(r => r.name === 'PREMIUM' ? { ...r, isBuiltIn: true, ads_available: false, default_role: false, notes_available: true } : r);
    }
    const users = usersEnriched;

    // Build user → roles map
    const userRolesMap = new Map();
    for (const row of userRolesResult.rows) {
      const list = userRolesMap.get(Number(row.user_id)) || [];
      list.push(Number(row.role_id));
      userRolesMap.set(Number(row.user_id), list);
    }
    const usersWithRoles = users.map(u => ({ ...u, roleIds: userRolesMap.get(Number(u.id)) || [] }));

    // Build folder → roles map
    const folderRolesMap = new Map();
    for (const row of folderRolesResult.rows) {
      const list = folderRolesMap.get(row.folder_path) || [];
      list.push(Number(row.role_id));
      folderRolesMap.set(row.folder_path, list);
    }
    const folderPerms = folderPermsResult.rows.map(p => ({
      ...p,
      roleIds: folderRolesMap.get(p.folder_path) || []
    }));

    const flashMessages = { saved: 'Changes saved.', deleted: 'Deleted.', roleSaved: 'Role saved.', roleDeleted: 'Role deleted.', assignmentSaved: 'Assignment saved.' };
    const msg = flashMessages[req.query.msg] || null;
    const error = typeof req.query.error === 'string' && req.query.error ? req.query.error : null;

    res.render('admin-folders', { user: req.user, roles, users: usersWithRoles, folderPerms, msg, error });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load folder permissions.' });
  }
});

// Create or update a role
app.post('/admin/folders/roles', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const adsAvailable = String(req.body.ads_available || '').toLowerCase() === 'true' || req.body.ads_available === true || req.body.ads_available === '1' || req.body.ads_available === 'on';
    const defaultRole = String(req.body.default_role || '').toLowerCase() === 'true' || req.body.default_role === true || req.body.default_role === '1' || req.body.default_role === 'on';
    const notesAvailable = String(req.body.notes_available || '').toLowerCase() === 'true' || req.body.notes_available === true || req.body.notes_available === '1' || req.body.notes_available === 'on';
    if (!name || name.length > 100) throw new Error('Invalid role name.');
    if (name === 'admin') throw new Error('"admin" is a reserved system role name.');
    
    const upperName = name.toUpperCase();
    const isProtectedName = upperName === 'PREMIUM' || upperName === 'ACTIVE' || upperName === 'EXPIRED';

    const editId = Number.parseInt(req.body.role_id, 10);
    if (Number.isFinite(editId) && editId > 0) {
      const existingRes = await pool.query('SELECT name FROM roles WHERE id = $1', [editId]);
      if (existingRes.rowCount > 0) {
        const existingName = existingRes.rows[0].name;
        const existingUpper = existingName.toUpperCase();
        
        // If they are trying to rename a protected role:
        if (existingUpper === 'PREMIUM' || existingUpper === 'ACTIVE' || existingUpper === 'EXPIRED') {
          if (upperName !== existingUpper) {
            throw new Error(`The built-in role "${existingName}" cannot be renamed.`);
          }
        } else {
          // They are renaming a normal role to a protected name
          if (isProtectedName) {
            throw new Error(`The role name "${name}" is reserved for system-managed roles.`);
          }
        }
      }
    } else {
      // Creating a new role
      if (isProtectedName) {
        throw new Error(`The role name "${name}" is reserved for system-managed roles.`);
      }
    }

    if (name.toUpperCase() === 'PREMIUM') {
      // Ensure built-in PREMIUM exists without duplication
      try {
        await pool.query(`INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ('PREMIUM', 'Built-in Premium role', false, false, true) ON CONFLICT (name) DO NOTHING`);
      } catch {}
      // If editing, ensure we don't duplicate - just update description if needed
      if (Number.isFinite(editId) && editId > 0) {
        const existing = await pool.query('SELECT id FROM roles WHERE name = $1', ['PREMIUM']);
        if (existing.rowCount > 0) {
          await pool.query('UPDATE roles SET description = $1, ads_available = false, default_role = false, notes_available = true WHERE name = $2', [description || 'Built-in Premium role', 'PREMIUM']);
        }
      }
      invalidatePermissionCache();
      return res.redirect('/admin/folders?msg=roleSaved');
    }

    // Active and Expired properties can be modified, but name is protected from rename (handled above)
    if (name.toUpperCase() === 'ACTIVE' || name.toUpperCase() === 'EXPIRED') {
      if (Number.isFinite(editId) && editId > 0) {
        await pool.query('UPDATE roles SET description = $1, ads_available = $2, default_role = $3, notes_available = $4 WHERE id = $5', [description, adsAvailable, defaultRole, notesAvailable, editId]);
      } else {
        await pool.query('INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ($1, $2, $3, $4, $5)', [name, description, adsAvailable, defaultRole, notesAvailable]);
      }
      invalidatePermissionCache();
      return res.redirect('/admin/folders?msg=roleSaved');
    }

    if (Number.isFinite(editId) && editId > 0) {
      await pool.query('UPDATE roles SET name = $1, description = $2, ads_available = $3, default_role = $4, notes_available = $5 WHERE id = $6', [name, description, adsAvailable, defaultRole, notesAvailable, editId]);
    } else {
      await pool.query('INSERT INTO roles (name, description, ads_available, default_role, notes_available) VALUES ($1, $2, $3, $4, $5)', [name, description, adsAvailable, defaultRole, notesAvailable]);
    }
    invalidatePermissionCache();
    res.redirect('/admin/folders?msg=roleSaved');
  } catch (error) {
    console.error(error);
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to save role.'));
  }
});

// Delete a role (cascades to user_roles and folder_roles)
app.post('/admin/folders/roles/:id/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    // Protect built-in PREMIUM synthetic id
    if (id === -1) throw new Error('PREMIUM is a protected built-in role and cannot be deleted.');
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid role ID.');
    try {
      const check = await pool.query('SELECT name FROM roles WHERE id = $1', [id]);
      if (check.rowCount > 0) {
        const uName = String(check.rows[0].name).toUpperCase();
        if (uName === 'PREMIUM' || uName === 'ACTIVE' || uName === 'EXPIRED') {
          throw new Error(`${check.rows[0].name} is a protected built-in role and cannot be deleted.`);
        }
      }
    } catch (e) {
      if (e.message && e.message.includes('protected')) throw e;
      // ignore lookup errors, proceed to delete
    }
    await pool.query('DELETE FROM roles WHERE id = $1', [id]);
    invalidatePermissionCache();
    res.redirect('/admin/folders?msg=roleDeleted');
  } catch (error) {
    console.error(error);
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to delete role.'));
  }
});

// Bulk update Ads Available, Default Role, and Notes settings for multiple roles (safe transaction)
app.post('/admin/folders/roles/update-ads', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    let updates = []; // Array of { id: number, adsAvailable?: boolean, defaultRole?: boolean, notesAvailable?: boolean }

    if (Array.isArray(req.body.roles)) {
      // JSON payload or parsed array
      for (const item of req.body.roles) {
        const id = Number.parseInt(item.id ?? item.role_id ?? item.roleId, 10);
        const adsAvailable = item.ads_available !== undefined ? Boolean(item.ads_available) : (item.adsAvailable !== undefined ? Boolean(item.adsAvailable) : undefined);
        const defaultRole = item.default_role !== undefined ? Boolean(item.default_role) : (item.defaultRole !== undefined ? Boolean(item.defaultRole) : undefined);
        const notesAvailable = item.notes_available !== undefined ? Boolean(item.notes_available) : (item.notesAvailable !== undefined ? Boolean(item.notesAvailable) : undefined);
        if (Number.isFinite(id) && id > 0) {
          updates.push({ id, adsAvailable, defaultRole, notesAvailable });
        }
      }
    } else if (req.body && typeof req.body === 'object') {
      // Form POST data
      const allRoles = await pool.query('SELECT id, name FROM roles');
      for (const r of allRoles.rows) {
        const id = Number(r.id);
        const name = String(r.name || '').toUpperCase();
        if (name === 'PREMIUM') continue; // Always protect PREMIUM
        const fieldVal = req.body[`role_ads_${id}`] ?? req.body[`ads_available_${id}`];
        const defVal = req.body[`role_default_${id}`] ?? req.body[`default_role_${id}`];
        const notesVal = req.body[`role_notes_${id}`] ?? req.body[`notes_available_${id}`];
        const isChecked = fieldVal === 'true' || fieldVal === 'on' || fieldVal === '1' || fieldVal === true;
        const isDefChecked = defVal === 'true' || defVal === 'on' || defVal === '1' || defVal === true;
        const isNotesChecked = notesVal === 'true' || notesVal === 'on' || notesVal === '1' || notesVal === true;
        updates.push({ id, adsAvailable: isChecked, defaultRole: isDefChecked, notesAvailable: isNotesChecked });
      }
    }

    if (updates.length > 0) {
      await withTransaction(async client => {
        for (const { id, adsAvailable, defaultRole, notesAvailable } of updates) {
          // Double check protection for PREMIUM
          const check = await client.query('SELECT name FROM roles WHERE id = $1', [id]);
          if (check.rowCount > 0) {
            const name = String(check.rows[0].name || '').toUpperCase();
            if (name === 'PREMIUM') {
              // Ignore/protect PREMIUM from any changes
              continue;
            }
          }
          const setClauses = [];
          const values = [];
          let idx = 1;
          if (adsAvailable !== undefined) {
            setClauses.push(`ads_available = $${idx++}`);
            values.push(adsAvailable);
          }
          if (defaultRole !== undefined) {
            setClauses.push(`default_role = $${idx++}`);
            values.push(defaultRole);
          }
          if (notesAvailable !== undefined) {
            setClauses.push(`notes_available = $${idx++}`);
            values.push(notesAvailable);
          }
          if (setClauses.length > 0) {
            values.push(id);
            await client.query(`UPDATE roles SET ${setClauses.join(', ')} WHERE id = $${idx}`, values);
          }
        }
      });
      invalidatePermissionCache();
    }

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, message: 'Role settings updated.' });
    }
    res.redirect('/admin/folders?msg=roleSaved');
  } catch (error) {
    console.error('Error updating role settings:', error);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: error.message || 'Failed to update role settings.' });
    }
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to update role settings.'));
  }
});

// Assign roles to a user
app.post('/admin/folders/assign', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = Number.parseInt(req.body.user_id, 10);
    if (!Number.isFinite(userId) || userId <= 0) throw new Error('Invalid user.');
    let roleIds = Array.isArray(req.body.role_ids)
      ? req.body.role_ids.map(Number).filter(Number.isFinite)
      : req.body.role_ids ? [Number(req.body.role_ids)].filter(Number.isFinite) : [];
    // Handle built-in PREMIUM synthetic id (-1) -> map to real DB id
    if (roleIds.includes(-1)) {
      const premiumId = await getPremiumRoleId();
      if (premiumId !== -1) {
        roleIds = roleIds.map(id => id === -1 ? premiumId : id);
      } else {
        roleIds = roleIds.filter(id => id !== -1);
      }
      roleIds = [...new Set(roleIds)];
    }
    await withTransaction(async client => {
      // Replace all role assignments for this user
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const roleId of roleIds) {
        await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, roleId]);
      }
    });
    invalidatePermissionCache();
    res.redirect('/admin/folders?msg=assignmentSaved');
  } catch (error) {
    console.error(error);
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to save assignment.'));
  }
});

// Bulk assign roles to multiple users (safe transaction)
app.post('/admin/folders/assign-bulk', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    let assignments = req.body.assignments || req.body.users || req.body.data;
    if (typeof assignments === 'string') {
      try { assignments = JSON.parse(assignments); } catch { assignments = null; }
    }
    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw new Error('No assignments provided.');
    }
    const normalized = [];
    for (const a of assignments) {
      const userId = Number.parseInt(a.user_id ?? a.userId ?? a.id, 10);
      if (!Number.isFinite(userId) || userId <= 0) throw new Error('Invalid user_id');
      let roleIds = [];
      if (Array.isArray(a.role_ids)) roleIds = a.role_ids;
      else if (Array.isArray(a.roleIds)) roleIds = a.roleIds;
      else if (Array.isArray(a.roles)) roleIds = a.roles;
      else if (typeof a.role_ids === 'string') roleIds = a.role_ids.split(',').filter(Boolean);
      else roleIds = [];
      roleIds = roleIds.map(v => Number(v)).filter(n => Number.isFinite(n));
      if (roleIds.includes(-1)) {
        const premiumId = await getPremiumRoleId();
        if (premiumId !== -1) {
          roleIds = roleIds.map(id => id === -1 ? premiumId : id);
        } else {
          roleIds = roleIds.filter(id => id !== -1);
        }
        roleIds = [...new Set(roleIds)];
      }
      normalized.push({ userId, roleIds });
    }

    await withTransaction(async client => {
      for (const { userId, roleIds } of normalized) {
        const userRes = await client.query('SELECT id, app_role FROM users WHERE id = $1', [userId]);
        if (userRes.rowCount === 0) throw new Error(`User ${userId} not found`);
        const user = userRes.rows[0];
        if (user.app_role === 'OWNER' || user.app_role === 'ADMIN') {
          continue;
        }
        if (roleIds.length > 0) {
          const roleCheck = await client.query('SELECT id FROM roles WHERE id = ANY($1)', [roleIds]);
          const validIds = new Set(roleCheck.rows.map(r => Number(r.id)));
          const invalid = roleIds.filter(id => !validIds.has(id));
          if (invalid.length > 0) throw new Error(`Invalid role IDs: ${invalid.join(',')}`);
        }
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        for (const roleId of roleIds) {
          await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, roleId]);
        }
      }
    });
    invalidatePermissionCache();
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, updated: normalized.length });
    res.redirect('/admin/folders?msg=assignmentSaved');
  } catch (error) {
    console.error(error);
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to save assignments.'));
  }
});

// Configure folder access level + role grants
app.post('/admin/folders/folder', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const folderPath = String(req.body.folder_path || '').trim();
    const accessLevel = String(req.body.access_level || 'all').trim();
    if (!folderPath || folderPath.includes('\0') || folderPath.includes('\\') || folderPath.startsWith('/')) {
      throw new Error('Invalid folder path.');
    }
    if (!['all', 'admin', 'role'].includes(accessLevel)) {
      throw new Error('Invalid access level.');
    }
    if (accessLevel === 'all') {
      // Remove any restriction — default to unrestricted
      await withTransaction(async client => {
        await client.query('DELETE FROM folder_roles WHERE folder_path = $1', [folderPath]);
        await client.query('DELETE FROM folder_permissions WHERE folder_path = $1', [folderPath]);
      });
    } else {
      await withTransaction(async client => {
        // Ensure folder_permissions row exists with correct access_level
        await client.query(
          `INSERT INTO folder_permissions (folder_path, access_level)
           VALUES ($1, $2)
           ON CONFLICT (folder_path) DO UPDATE SET access_level = $2`,
          [folderPath, accessLevel]
        );
        if (accessLevel === 'admin') {
          // Admin-only: remove any role grants
          await client.query('DELETE FROM folder_roles WHERE folder_path = $1', [folderPath]);
        } else if (accessLevel === 'role') {
          // Replace role grants
          let roleIds = Array.isArray(req.body.role_ids)
            ? req.body.role_ids.map(Number).filter(Number.isFinite)
            : req.body.role_ids ? [Number(req.body.role_ids)].filter(Number.isFinite) : [];
          if (roleIds.includes(-1)) {
            const premiumId = await getPremiumRoleId();
            if (premiumId !== -1) {
              roleIds = roleIds.map(id => id === -1 ? premiumId : id);
            } else {
              roleIds = roleIds.filter(id => id !== -1);
            }
            roleIds = [...new Set(roleIds)];
          }
          await client.query('DELETE FROM folder_roles WHERE folder_path = $1', [folderPath]);
          for (const roleId of roleIds) {
            await client.query('INSERT INTO folder_roles (folder_path, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [folderPath, roleId]);
          }
        }
      });
    }
    invalidatePermissionCache();
    res.redirect('/admin/folders?msg=saved');
  } catch (error) {
    console.error(error);
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to save folder access.'));
  }
});

// Delete a folder permission entirely
app.post('/admin/folders/folder/:path/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const folderPath = decodeURIComponent(req.params.path);
    if (!folderPath) throw new Error('Invalid folder path.');
    await pool.query('DELETE FROM folder_roles WHERE folder_path = $1', [folderPath]);
    await pool.query('DELETE FROM folder_permissions WHERE folder_path = $1', [folderPath]);
    invalidatePermissionCache();
    res.redirect('/admin/folders?msg=deleted');
  } catch (error) {
    console.error(error);
    res.redirect('/admin/folders?error=' + encodeURIComponent(error.message || 'Failed to delete folder permission.'));
  }
});


/* Local-only personal finance workspace. Production is denied before passcode
   checks; no financial values are sent to the app database or logged. */

const expenseTrackerGate = (req, res, next) => {
  if (!isLocalExpenseTrackerRequest(req)) return res.status(404).send('Expense Tracker is available only from localhost on this machine.');
  if (process.env.NODE_ENV !== 'development') return res.status(404).send('Expense Tracker requires NODE_ENV=development in your local .env. Restart the server after changing it.');
  if (typeof process.env.EXPENSE_TRACKER_PASSCODE !== 'string' || process.env.EXPENSE_TRACKER_PASSCODE.length < 8) return res.status(503).send('Setup required: set EXPENSE_TRACKER_PASSCODE to a private passphrase of at least 8 characters in your local .env, then restart the server.');
  if (!req.session?.expenseTrackerUnlockedUntil || req.session.expenseTrackerUnlockedUntil < Date.now()) {
    if (req.session) delete req.session.expenseTrackerUnlockedUntil;
    return res.status(423).json({ error: 'Expense Tracker is locked. Unlock it again.' });
  }
  next();
};
app.get('/admin/expense-tracker', requireAuth, requireAdmin, (req, res) => {
  if (!isLocalExpenseTrackerRequest(req)) return res.status(404).send('Expense Tracker is available only from localhost on this machine.');
  if (process.env.NODE_ENV !== 'development') return res.status(404).send('Expense Tracker requires NODE_ENV=development in your local .env. Restart the server after changing it.');
  if (typeof process.env.EXPENSE_TRACKER_PASSCODE !== 'string' || process.env.EXPENSE_TRACKER_PASSCODE.length < 8) return res.status(503).send('Setup required: set EXPENSE_TRACKER_PASSCODE to a private passphrase of at least 8 characters in your local .env, then restart the server.');
  if (!req.session?.expenseTrackerUnlockedUntil || req.session.expenseTrackerUnlockedUntil < Date.now()) {
    if (req.session) delete req.session.expenseTrackerUnlockedUntil;
    return res.render('admin-expense-tracker-unlock', { user: req.user, error: null });
  }
  return res.render('admin-expense-tracker', { user: req.user });
});
app.post('/admin/expense-tracker/unlock', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  if (!isExpenseTrackerAvailable() || !isLocalExpenseTrackerRequest(req)) return res.status(404).send('Expense Tracker is disabled.');
  if (!safePasscodeEqual(String(req.body?.passcode || ''), process.env.EXPENSE_TRACKER_PASSCODE)) {
    return res.status(401).render('admin-expense-tracker-unlock', { user: req.user, error: 'Incorrect passcode.' });
  }
  const authenticatedUser = req.user;
  return req.session.regenerate(err => {
    if (err) return res.status(500).send('Unable to unlock Expense Tracker.');
    return req.login(authenticatedUser, loginErr => {
      if (loginErr) return res.status(500).send('Unable to unlock Expense Tracker.');
      req.session.expenseTrackerUnlockedUntil = Date.now() + 30 * 60 * 1000;
      return req.session.save(saveErr => {
        if (saveErr) return res.status(500).send('Unable to unlock Expense Tracker.');
        return res.redirect('/admin/expense-tracker');
      });
    });
  });
});
app.post('/admin/expense-tracker/lock', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  if (!isExpenseTrackerAvailable() || !isLocalExpenseTrackerRequest(req)) return res.status(404).send('Expense Tracker is disabled.');
  if (req.session) delete req.session.expenseTrackerUnlockedUntil;
  return req.session.save(err => err ? res.status(500).send('Unable to lock Expense Tracker.') : res.redirect('/admin'));
});
app.get('/api/admin/expense-tracker/data', requireApiAuth, requireAdmin, expenseTrackerGate, async (_req, res) => {
  try { return res.json({ data: await readExpenseData() }); }
  catch (err) { return res.status(500).json({ error: err?.message || 'Unable to read the local Expense Tracker database.' }); }
});
app.post('/api/admin/expense-tracker/data', requireApiAuth, requireAdmin, requireSameOrigin, expenseTrackerGate, async (req, res) => {
  try {
    const existing = await readExpenseData().catch(() => null);
    if (existing && existing.months && req.body?.data?.months) {
      for (const monthKey of Object.keys(existing.months)) {
        if (isHistoricalMonthLocked(monthKey)) {
          const oldMonthStr = JSON.stringify(existing.months[monthKey] || {});
          const newMonthStr = JSON.stringify(req.body.data.months[monthKey] || {});
          if (oldMonthStr !== newMonthStr) {
            return res.status(400).json({ error: `Historical month ${monthKey} is locked and read-only.` });
          }
        }
      }
      for (const monthKey of Object.keys(req.body.data.months)) {
        if (isHistoricalMonthLocked(monthKey) && !existing.months[monthKey]) {
          return res.status(400).json({ error: `Historical month ${monthKey} is locked and read-only.` });
        }
      }
    }
    const saved = await writeExpenseData(req.body?.data);
    return res.json({ success: true, data: saved });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid Expense Tracker data.' });
  }
});
app.post('/api/admin/expense-tracker/import-preview', requireApiAuth, requireAdmin, requireSameOrigin, expenseTrackerGate, (req, res) => {
  try {
    const source = req.body?.source === 'INDmoney' ? 'INDmoney' : 'Zerodha';
    const requestedType = ['mutualFund', 'auto'].includes(req.body?.assetType) ? req.body.assetType : 'stock';
     return res.json({ rows: parseBrokerCsv(req.body?.csv, source, requestedType, req.body?.account) });
  } catch (err) { return res.status(400).json({ error: err?.message || 'Unable to preview broker CSV.' }); }
});

app.post('/api/admin/expense-tracker/reset-month', requireApiAuth, requireAdmin, requireSameOrigin, expenseTrackerGate, async (req, res) => {
  try {
    const month = String(req.body?.month || '').trim();
    const person = String(req.body?.person || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format.' });
    }
    if (!isFutureMonth(month)) {
      return res.status(400).json({ error: `Reset is allowed only for future months (${month} is not in the future).` });
    }
    const currentData = await readExpenseData();
    const updatedData = resetFutureMonth(currentData, month, person);
    const saved = await writeExpenseData(updatedData);
    return res.json({ success: true, data: saved });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to reset upcoming month.' });
  }
});

app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  let allUsers, expiringCount, stats, contentPermissionsMap, disc, learnerNotesStats;
  if (perfDiagnosticsEnabled) {
    req._perfTimings = req._perfTimings || {};
    let tUsers = Date.now(), tExp = Date.now(), tStats = Date.now(), tPerm = Date.now(), tNeeds = Date.now(), tNotes = Date.now();
    const pUsers = getUsersForAdmin().then(v => { req._perfTimings.getUsersForAdmin = Date.now() - tUsers; return v; }).catch(e => { req._perfTimings.getUsersForAdmin = Date.now() - tUsers; throw e; });
    const pExp = getExpiringUsers().then(exp => exp.length).then(v => { req._perfTimings.getExpiringUsers = Date.now() - tExp; return v; }).catch(() => { req._perfTimings.getExpiringUsers = Date.now() - tExp; return null; });
    const pStats = pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE)::int AS active_today,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE - INTERVAL '30 days')::int AS active_month,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_users,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'view' AND created_at >= CURRENT_DATE) AS views_today,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'copy' AND created_at >= CURRENT_DATE) AS copies_today,
      (SELECT COUNT(*)::int FROM discussions) AS total_discussions,
      (SELECT COUNT(*)::int FROM discussion_replies) AS total_replies
    FROM users
  `).then(v => { req._perfTimings.statisticsQuery = Date.now() - tStats; return v; }).catch(e => { req._perfTimings.statisticsQuery = Date.now() - tStats; throw e; });
    const pPerm = getAllContentPermissions().then(v => { req._perfTimings.getAllContentPermissions = Date.now() - tPerm; return v; }).catch(() => { req._perfTimings.getAllContentPermissions = Date.now() - tPerm; return new Map(); });
    const pNeeds = getNeedsAttention().then(v => { req._perfTimings.getNeedsAttention = Date.now() - tNeeds; return v; }).catch(() => { req._perfTimings.getNeedsAttention = Date.now() - tNeeds; return null; });
    const pNotes = getAdminNotesStats().then(v => { req._perfTimings.getAdminNotesStats = Date.now() - tNotes; return v; }).catch(() => { req._perfTimings.getAdminNotesStats = Date.now() - tNotes; return { total_notes: 0, unique_learners: 0, unique_questions: 0 }; });
    [allUsers, expiringCount, stats, contentPermissionsMap, disc, learnerNotesStats] = await Promise.all([pUsers, pExp, pStats, pPerm, pNeeds, pNotes]);
  } else {
    // Parallelize independent dashboard queries (Fix 5) — preserves SQL, data, error handling
    const allUsersPromise = getUsersForAdmin();
    const expiringCountPromise = getExpiringUsers().then(exp => exp.length).catch(() => null);
    const statsPromise = pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE)::int AS active_today,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE - INTERVAL '30 days')::int AS active_month,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_users,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'view' AND created_at >= CURRENT_DATE) AS views_today,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'copy' AND created_at >= CURRENT_DATE) AS copies_today,
      (SELECT COUNT(*)::int FROM discussions) AS total_discussions,
      (SELECT COUNT(*)::int FROM discussion_replies) AS total_replies
    FROM users
  `);
    const contentPermissionsPromise = getAllContentPermissions().catch(() => new Map());
    const discPromise = getNeedsAttention().catch(() => null);
    const learnerNotesStatsPromise = getAdminNotesStats().catch(() => ({ total_notes: 0, unique_learners: 0, unique_questions: 0 }));

    [allUsers, expiringCount, stats, contentPermissionsMap, disc, learnerNotesStats] = await Promise.all([
      allUsersPromise,
      expiringCountPromise,
      statsPromise,
      contentPermissionsPromise,
      discPromise,
      learnerNotesStatsPromise
    ]);
  }
  const flashMessages = {
    approved: 'User approved.',
    extended: 'Access extended.',
    revoked: 'Access revoked.',
    reactivated: 'User reactivated.',
    adminGranted: 'Admin role granted.',
    adminRevoked: 'Admin role removed.',
    premiumGranted: 'Premium role granted.',
    premiumRevoked: 'Premium role removed.',
    contentGranted: 'Permission granted.',
    contentRevoked: 'Permission revoked.'
  };
  const rawMsg = typeof req.query.msg === 'string' ? req.query.msg : null;
  const msg = rawMsg ? (flashMessages[rawMsg] || rawMsg) : null;
  const error = typeof req.query.error === 'string' && req.query.error ? req.query.error : null;

  const isOwner = isOwnerUser(req.user);
  // Needs Attention — reuse existing Admin data only, no new tables, no duplicate DB logic
  let needsAttention = { pending: 0, expiring: 0, revoked: 0, hidden: 0, unanswered: 0, hasAttention: false };
  try {
    needsAttention.pending = Number(stats.rows[0].pending_users) || 0;
  } catch {}
  try {
    needsAttention.expiring = Number(expiringCount) || 0;
  } catch {}
  try {
    // Derived from already-fetched users (same data Admin already sees)
    needsAttention.revoked = allUsers.filter(u => u.status === 'revoked').length;
  } catch {}
  try {
    if (disc && disc.counts) {
      const hq = Number(disc.counts.hidden_questions_count) || 0;
      const hr = Number(disc.counts.hidden_replies_count) || 0;
      needsAttention.hidden = hq + hr;
      needsAttention.unanswered = Number(disc.counts.unanswered_count) || 0;
    }
  } catch {}
  needsAttention.hasAttention = needsAttention.pending > 0 || needsAttention.expiring > 0 || needsAttention.revoked > 0 || needsAttention.hidden > 0 || needsAttention.unanswered > 0;

  // Status filter for Admin Users table: All / Pending / Active / Expired / Revoked / Premium / Without Premium
  const validStatusFilters = ['all', 'pending', 'active', 'expired', 'revoked', 'premium', 'without_premium', 'without-premium', 'non_premium'];
  let currentStatusFilter = String(req.query.status || req.query.filter || 'all').trim().toLowerCase().replace(/-/g, '_');
  if (currentStatusFilter === 'non_premium') currentStatusFilter = 'without_premium';
  if (!validStatusFilters.includes(currentStatusFilter)) currentStatusFilter = 'all';
  let users = allUsers;
  if (currentStatusFilter !== 'all') {
    if (currentStatusFilter === 'premium') {
      users = allUsers.filter(u => getUserRole(u) === 'PREMIUM');
    } else if (currentStatusFilter === 'without_premium') {
      users = allUsers.filter(u => getUserRole(u) !== 'PREMIUM');
    } else {
      users = allUsers.filter(u => {
        const st = statusDisplay(u);
        return st === currentStatusFilter;
      });
    }
  }

  const learnerNotes = []; // table moved to dedicated /admin/learner-notes page — learnerNotesStats already fetched in parallel above

  if (perfDiagnosticsEnabled) {
    const tRender = Date.now();
    res.render('admin', { localDeleteEnabled: process.env.LOCAL_USER_DELETE_ENABLED === 'true',
      user: req.user,
      users,
      allUsers,
      currentStatusFilter,
      stats: stats.rows[0],
      learnerNotes,
      learnerNotesStats,
      contentPermissionsMap,
      expiringCount,
      needsAttention,
      defaultAccessDays: parseInt(process.env.DEFAULT_ACCESS_DAYS || '30', 10),
      premiumAccessDays: parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10),
      displayName,
      statusDisplay,
      isAdminEmail,
      isAdminUser,
      isOwnerUser,
      getUserRole,
      isOwner,
      PERMISSIONS,
      msg,
      error,
      contentRouteForPath
    });
    req._perfTimings.render = Date.now() - tRender;
    perfLog(req, '/admin', {});
  } else {
    res.render('admin', { localDeleteEnabled: process.env.LOCAL_USER_DELETE_ENABLED === 'true',
      user: req.user,
      users,
      allUsers,
      currentStatusFilter,
      stats: stats.rows[0],
      learnerNotes,
      learnerNotesStats,
      contentPermissionsMap,
      expiringCount,
      needsAttention,
      defaultAccessDays: parseInt(process.env.DEFAULT_ACCESS_DAYS || '30', 10),
      premiumAccessDays: parseInt(process.env.PREMIUM_ACCESS_DAYS || '30', 10),
      displayName,
      statusDisplay,
      isAdminEmail,
      isAdminUser,
      isOwnerUser,
      getUserRole,
      isOwner,
      PERMISSIONS,
      msg,
      error,
      contentRouteForPath
    });
  }
});

app.get('/admin/learner-notes', requireAuth, requireAdmin, async (req, res) => {
  try {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
    let learnerNotes = [];
    let learnerNotesStats = { total_notes: 0, unique_learners: 0, unique_questions: 0 };
    try {
      const { getAllNotesForAdmin, getAdminNotesStats } = await import('./knowledge/notes.js');
      learnerNotes = await getAllNotesForAdmin({ limit: 50 });
      learnerNotesStats = await getAdminNotesStats();
    } catch (e) {
      console.error('Failed to load learner notes for admin:', e);
      learnerNotes = [];
      learnerNotesStats = { total_notes: 0, unique_learners: 0, unique_questions: 0 };
    }
    res.render('admin-learner-notes', {
      user: req.user,
      learnerNotes,
      learnerNotesStats,
      expiringCount,
      contentRouteForPath,
      currentUrl: req.originalUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Unable to load learner notes.' });
  }
});

// === Admin: Premium Membership ===
app.get('/admin/premium', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getPremiumDashboardData } = await import('./auth/premium-admin.js');
    const validFilters = ['all', 'recurring', 'one_time', 'manual', 'active', 'expiring_soon', 'expired', 'promo_used', 'no_promo'];
    const filter = validFilters.includes(req.query.filter) ? req.query.filter : 'all';
    const search = String(req.query.search || req.query.q || '').trim();
    
    let expiringCount = null;
    try {
      const exp = await getExpiringUsers();
      expiringCount = exp.length;
    } catch {
      expiringCount = null;
    }
    
    const dashboardData = await getPremiumDashboardData(filter, search);
    
    res.render('admin-premium', {
      user: req.user,
      expiringCount,
      filter,
      search,
      data: dashboardData,
      msg: req.query.msg || null,
      error: req.query.error || null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// === Admin: Premium Reconciliation (Thought #3A) ===
app.post('/admin/premium/reconcile', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const { reconcileAllPremiumRoles } = await import('./auth/premium.js');
    const dryRun = String(req.query?.dryRun ?? req.body?.dryRun ?? '').toLowerCase() === 'true';
    const result = await reconcileAllPremiumRoles({ dryRun });
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json(result);
    const msg = `Reconciliation: ${result.granted} granted, ${result.revoked} revoked, ${result.corrected} corrected, ${result.usersExpired || 0} user statuses expired, ${result.checked} checked${dryRun ? ' (dry run)' : ''}.`;
    res.redirect('/admin/premium?msg=' + encodeURIComponent(msg));
  } catch (err) {
    if ((req.get('accept') || '').includes('application/json') || req.is('json')) {
      return res.status(500).json({ error: err.message || 'Reconciliation failed' });
    }
    adminError(res, err);
  }
});

// === Admin: Generic Paid Products Reconciliation (Thought #4 Phase 2C) ===
const handleReconcileAllPaidProducts = async (req, res) => {
  const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
  const dryRun = String(req.query?.dryRun ?? req.body?.dryRun ?? '').toLowerCase() === 'true';
  // Dry runs do NOT affect persistent status — observability is for real runs only
  if (dryRun) {
    try {
      const { reconcileAllPaidProducts } = await import('./auth/paidProducts.js');
      const result = await reconcileAllPaidProducts({ dryRun });
      if (wantsJson) return res.json({ ok: true, ...result });
      const msg = `Paid Products reconciliation: ${result.rolesGranted} granted, ${result.rolesRevoked} revoked, ${result.grantsExpired} grants expired, ${result.usersExpired || 0} user statuses expired, ${result.checkedUsers} users checked (dry run).`;
      return res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
    } catch (err) {
      if (wantsJson) return res.status(500).json({ ok: false, error: err.message || 'Paid products reconciliation failed' });
      return adminError(res, err);
    }
  }
  let runRow = null;
  try {
    const { createReconciliationRun, completeReconciliationRun, failReconciliationRun, reconcileAllPaidProducts } = await import('./auth/paidProducts.js');
    try {
      runRow = await createReconciliationRun('manual');
    } catch (lockErr) {
      if (lockErr && lockErr.code === 'RECONCILIATION_RUNNING') {
        if (wantsJson) return res.status(409).json({ ok: false, error: lockErr.message, code: 'RECONCILIATION_RUNNING' });
        return res.redirect('/admin/paid-products?error=' + encodeURIComponent(lockErr.message));
      }
      throw lockErr;
    }
    const result = await reconcileAllPaidProducts({ dryRun: false });
    try { await completeReconciliationRun(runRow.id, result); } catch (e) { console.error('Failed to mark manual run completed:', e.message); }
    if (wantsJson) return res.json({ ok: true, ...result, reconciliationRunId: runRow.id });
    const msg = `Paid Products reconciliation: ${result.rolesGranted} granted, ${result.rolesRevoked} revoked, ${result.grantsExpired} grants expired, ${result.usersExpired || 0} user statuses expired, ${result.checkedUsers} users checked.`;
    return res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
  } catch (err) {
    if (runRow) {
      try { const { failReconciliationRun } = await import('./auth/paidProducts.js'); await failReconciliationRun(runRow.id, err); } catch {}
    }
    if (wantsJson) {
      const status = err.status === 409 ? 409 : 500;
      return res.status(status).json({ ok: false, error: err.message || 'Paid products reconciliation failed', code: err.code || undefined });
    }
    return adminError(res, err);
  }
};

const handleReconcileOnePaidProduct = async (req, res) => {
  try {
    const { reconcilePaidProduct, reconcileAllPaidProducts } = await import('./auth/paidProducts.js');
    const { productCodeOrId } = req.params;
    const dryRun = String(req.query?.dryRun ?? req.body?.dryRun ?? '').toLowerCase() === 'true';
    if (productCodeOrId === 'reconcile' || productCodeOrId === 'all') {
      const result = await reconcileAllPaidProducts({ dryRun });
      const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
      if (wantsJson) return res.json({ ok: true, ...result });
      const msg = `Paid Products reconciliation: ${result.rolesGranted} granted, ${result.rolesRevoked} revoked, ${result.grantsExpired} grants expired, ${result.usersExpired || 0} user statuses expired${dryRun ? ' (dry run)' : ''}.`;
      return res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
    }
    const result = await reconcilePaidProduct(productCodeOrId, { dryRun });
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
    if (!result || result.success === false) {
      const status = result?.error === 'Product not found' ? 404 : 400;
      if (wantsJson) return res.status(status).json({ ok: false, error: result?.error || 'Product reconciliation failed' });
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent(result?.error || 'Product reconciliation failed'));
    }
    if (wantsJson) return res.json({ ok: true, ...result });
    const msg = `Reconciliation for ${result.productCode}: ${result.rolesGranted} granted, ${result.rolesRevoked} revoked, ${result.grantsExpired} grants expired${dryRun ? ' (dry run)' : ''}.`;
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
  } catch (err) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json') || req.path.startsWith('/api/');
    if (wantsJson) {
      return res.status(500).json({ ok: false, error: err.message || 'Product reconciliation failed' });
    }
    adminError(res, err);
  }
};

app.post('/admin/paid-products/reconcile', requireAuth, requireAdmin, requireSameOrigin, handleReconcileAllPaidProducts);
app.post('/api/admin/paid-products/reconcile', requireAuth, requireAdmin, requireSameOrigin, handleReconcileAllPaidProducts);
app.post('/admin/paid-products/:productCodeOrId/reconcile', requireAuth, requireAdmin, requireSameOrigin, handleReconcileOnePaidProduct);
app.post('/api/admin/paid-products/:productCodeOrId/reconcile', requireAuth, requireAdmin, requireSameOrigin, handleReconcileOnePaidProduct);

// Persistent reconciliation status — shared by manual & scheduled (same source of truth)
app.get('/api/admin/paid-products/reconciliation-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getLatestReconciliationRun, getLatestCompletedReconciliationRun } = await import('./auth/paidProducts.js');
    const latest = await getLatestReconciliationRun();
    const latestCompleted = latest && latest.status === 'running' ? await getLatestCompletedReconciliationRun() : null;
    if (!latest) return res.json({ hasRun: false, latest: null, latestCompleted: null });
    res.json({ hasRun: true, latest, latestCompleted });
  } catch (err) {
    res.status(500).json({ hasRun: false, error: err.message });
  }
});

// === Admin: Paid Products & Plans Management (Thought #4 Phase 2E-1) ===
app.get('/admin/paid-products', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    if (perfDiagnosticsEnabled) req._perfTimings = req._perfTimings || {};
    const { pool } = await import('./db/pool.js');
    const { getAllProductsWithRoles, getAllPlans, getAllPromotions } = await import('./auth/paidProducts.js');
    let expiringCount = null;
    if (perfDiagnosticsEnabled) {
      const tExp = Date.now();
      try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
      req._perfTimings.getExpiringUsers = Date.now() - tExp;
    } else {
      try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
    }
    
    let products, plans, promotions;
    if (perfDiagnosticsEnabled) {
      let t0 = Date.now(); products = await getAllProductsWithRoles(); req._perfTimings.getAllProductsWithRoles = Date.now() - t0;
      t0 = Date.now(); plans = await getAllPlans(); req._perfTimings.getAllPlans = Date.now() - t0;
      t0 = Date.now(); promotions = await getAllPromotions(pool); req._perfTimings.getAllPromotions = Date.now() - t0;
    } else {
      products = await getAllProductsWithRoles();
      plans = await getAllPlans();
      promotions = await getAllPromotions(pool);
    }

    const uniqueMembersByProduct = {};
    if (perfDiagnosticsEnabled) {
      const tBatch = Date.now();
      const { countUniqueActiveProductMembersBatch } = await import('./auth/paidProducts.js');
      const batchMap = await countUniqueActiveProductMembersBatch(products, pool);
      req._perfTimings.countUniqueActiveProductMembersBatch = Date.now() - tBatch;
      for (const prod of products) {
        uniqueMembersByProduct[prod.id] = batchMap.get(Number(prod.id)) ?? 0;
      }
    } else {
      const { countUniqueActiveProductMembersBatch } = await import('./auth/paidProducts.js');
      const batchMap = await countUniqueActiveProductMembersBatch(products, pool);
      for (const prod of products) {
        uniqueMembersByProduct[prod.id] = batchMap.get(Number(prod.id)) ?? 0;
      }
    }

    // 1. Revenue / Payment Summary
    let revRes;
    if (perfDiagnosticsEnabled) {
      const tRev = Date.now();
      revRes = await pool.query(`
      SELECT 
        COALESCE(SUM(amount_paise), 0)::bigint AS total_revenue_paise,
        COUNT(*)::int AS total_orders_count
      FROM paid_orders
      WHERE status = 'paid'
    `);
      req._perfTimings.revenueQuery = Date.now() - tRev;
    } else {
      revRes = await pool.query(`
      SELECT 
        COALESCE(SUM(amount_paise), 0)::bigint AS total_revenue_paise,
        COUNT(*)::int AS total_orders_count
      FROM paid_orders
      WHERE status = 'paid'
    `);
    }
    const revenueSummary = {
      totalRevenueInr: (Number(revRes.rows[0].total_revenue_paise) / 100).toFixed(2),
      totalOrdersCount: revRes.rows[0].total_orders_count
    };

    // 2. Active Entitlements / Grants by product
    const grantsRes = await pool.query(`
      SELECT 
        product_id,
        COUNT(*)::int AS active_count
      FROM user_product_grants
      WHERE status = 'active'
        AND (valid_until IS NULL OR valid_until > NOW())
      GROUP BY product_id
    `);
    const activeGrantsByProduct = {};
    grantsRes.rows.forEach(r => {
      activeGrantsByProduct[r.product_id] = r.active_count;
    });

    // 3. One-Time vs Recurring Split by product
    const splitRes = await pool.query(`
      SELECT 
        g.product_id,
        SUM(CASE WHEN pl.billing_type = 'recurring' OR g.subscription_id IS NOT NULL THEN 1 ELSE 0 END)::int AS recurring_count,
        SUM(CASE WHEN pl.billing_type = 'one_time' AND g.subscription_id IS NULL THEN 1 ELSE 0 END)::int AS one_time_count
      FROM user_product_grants g
      LEFT JOIN paid_product_plans pl ON g.plan_id = pl.id
      WHERE g.status = 'active'
        AND (g.valid_until IS NULL OR g.valid_until > NOW())
      GROUP BY g.product_id
    `);
    const oneTimeVsRecurringMembers = {};
    splitRes.rows.forEach(r => {
      oneTimeVsRecurringMembers[r.product_id] = {
        recurring: r.recurring_count || 0,
        oneTime: r.one_time_count || 0
      };
    });

    // 4. Needs Attention Items
    const needsRes = await pool.query(`
      WITH issues AS (
        SELECT u.id AS user_id, u.email, u.name AS user_name, u.app_role, p.id AS product_id, p.name AS product_name, p.code AS product_code, 'Role Missing' AS issue, 'User has active entitlement but is missing the mapped RBAC role.' AS details
        FROM user_product_grants g
        JOIN paid_products p ON g.product_id = p.id
        JOIN users u ON g.user_id = u.id
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = p.role_id
        WHERE g.status = 'active' 
          AND (g.valid_until IS NULL OR g.valid_until > NOW())
          AND ur.role_id IS NULL
          AND u.app_role NOT IN ('OWNER', 'ADMIN')
          AND p.is_enabled = true
        UNION ALL
        SELECT u.id AS user_id, u.email, u.name AS user_name, u.app_role, p.id AS product_id, p.name AS product_name, p.code AS product_code, 'Stale Role' AS issue, 'User holds the payment-system role but has no active payment entitlement.' AS details
        FROM user_roles ur
        JOIN paid_products p ON ur.role_id = p.role_id
        JOIN users u ON ur.user_id = u.id
        WHERE ur.assignment_source = 'payment_system'
          AND u.app_role NOT IN ('OWNER', 'ADMIN')
          AND p.is_enabled = true
          AND NOT EXISTS (
            SELECT 1 FROM user_product_grants g
            WHERE g.user_id = u.id 
              AND g.product_id = p.id 
              AND g.status = 'active' 
              AND (g.valid_until IS NULL OR g.valid_until > NOW())
          )
      )
      SELECT * FROM issues ORDER BY email ASC LIMIT 50
    `);
    const needsAttentionItems = needsRes.rows;

    // 5. Directory Search / Filter Query
    const { search, productFilter, planFilter, billingTypeFilter, statusFilter } = req.query;
    let directorySql = `
      SELECT 
        g.id AS grant_id,
        g.user_id,
        u.email,
        u.name AS user_name,
        g.product_id,
        prod.name AS product_name,
        prod.code AS product_code,
        g.plan_id,
        pl.name AS plan_name,
        pl.billing_type,
        g.status AS grant_status,
        g.valid_until,
        g.created_at,
        g.subscription_id,
        g.order_id,
        o.amount_paise,
        o.currency
      FROM user_product_grants g
      JOIN users u ON g.user_id = u.id
      JOIN paid_products prod ON g.product_id = prod.id
      LEFT JOIN paid_product_plans pl ON g.plan_id = pl.id
      LEFT JOIN paid_orders o ON g.order_id = o.id
      WHERE 1=1
    `;
    const directoryParams = [];
    let paramIndex = 1;

    if (search) {
      directorySql += ` AND (u.email ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex})`;
      directoryParams.push(`%${search.trim()}%`);
      paramIndex++;
    }
    if (productFilter) {
      directorySql += ` AND g.product_id = $${paramIndex}`;
      directoryParams.push(parseInt(productFilter, 10));
      paramIndex++;
    }
    if (planFilter) {
      directorySql += ` AND g.plan_id = $${paramIndex}`;
      directoryParams.push(parseInt(planFilter, 10));
      paramIndex++;
    }
    if (billingTypeFilter) {
      directorySql += ` AND pl.billing_type = $${paramIndex}`;
      directoryParams.push(billingTypeFilter);
      paramIndex++;
    }
    if (statusFilter) {
      if (statusFilter === 'active') {
        directorySql += ` AND g.status = 'active' AND (g.valid_until IS NULL OR g.valid_until > NOW())`;
      } else if (statusFilter === 'expired') {
        directorySql += ` AND (g.status = 'expired' OR (g.valid_until IS NOT NULL AND g.valid_until <= NOW()))`;
      }
    }

    directorySql += ` ORDER BY g.created_at DESC LIMIT 100`;
    const directoryRes = await pool.query(directorySql, directoryParams);

    // Fetch latest reconciliation status (same source for manual & scheduled)
    let reconciliationStatus = { hasRun: false, latest: null, latestCompleted: null };
    try {
      const { getLatestReconciliationRun, getLatestCompletedReconciliationRun } = await import('./auth/paidProducts.js');
      const latest = await getLatestReconciliationRun();
      if (!latest) reconciliationStatus = { hasRun: false, latest: null, latestCompleted: null };
      else if (latest.status === 'running') {
        const latestCompleted = await getLatestCompletedReconciliationRun();
        reconciliationStatus = { hasRun: true, latest, latestCompleted };
      } else {
        reconciliationStatus = { hasRun: true, latest, latestCompleted: null };
      }
    } catch {}

    if (perfDiagnosticsEnabled) {
      const tRender = Date.now();
      res.render('admin-paid-products', {
        user: req.user,
        expiringCount,
        products,
        plans,
        promotions,
        reconciliationStatus,
        revenueSummary,
        activeGrantsByProduct,
        uniqueMembersByProduct,
        oneTimeVsRecurringMembers,
        needsAttentionItems,
        directoryResults: directoryRes.rows,
        filters: {
          search: search || '',
          productFilter: productFilter || '',
          planFilter: planFilter || '',
          billingTypeFilter: billingTypeFilter || '',
          statusFilter: statusFilter || 'all'
        },
        msg: req.query.msg || null,
        error: req.query.error || null,
        csrfToken: req.csrfToken ? req.csrfToken() : ''
      });
      req._perfTimings.render = Date.now() - tRender;
      perfLog(req, '/admin/paid-products', {});
    } else {
      res.render('admin-paid-products', {
        user: req.user,
        expiringCount,
        products,
        plans,
        promotions,
        reconciliationStatus,
        revenueSummary,
        activeGrantsByProduct,
        uniqueMembersByProduct,
        oneTimeVsRecurringMembers,
        needsAttentionItems,
        directoryResults: directoryRes.rows,
        filters: {
          search: search || '',
          productFilter: productFilter || '',
          planFilter: planFilter || '',
          billingTypeFilter: billingTypeFilter || '',
          statusFilter: statusFilter || 'all'
        },
        msg: req.query.msg || null,
        error: req.query.error || null,
        csrfToken: req.csrfToken ? req.csrfToken() : ''
      });
    }
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/paid-products/user/:userId/reconcile
app.post('/admin/paid-products/user/:userId/reconcile', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId || isNaN(Number(userId))) {
      return res.status(400).json({ status: 'error', message: 'Invalid user ID' });
    }

    const { pool } = await import('./db/pool.js');
    const { syncProductRbacRole } = await import('./auth/paidProducts.js');
    const { syncUserPremiumRole } = await import('./auth/premium.js');

    const productsRes = await pool.query('SELECT * FROM paid_products WHERE is_enabled = true');
    
    let grantedCount = 0;
    let revokedCount = 0;

    for (const prod of productsRes.rows) {
      if (prod.code === 'PREMIUM') {
        const result = await syncUserPremiumRole(userId, pool);
        if (result) {
          const act = result.rbac?.rbacAction || result.action;
          if (act === 'granted') grantedCount++;
          if (act === 'revoked') revokedCount++;
        }
      } else {
        const result = await syncProductRbacRole(userId, prod.id, pool);
        if (result.action === 'granted') grantedCount++;
        if (result.action === 'revoked') revokedCount++;
      }
    }

    const msg = `Successfully reconciled user roles: ${grantedCount} role(s) granted, ${revokedCount} role(s) revoked.`;
    
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) {
      return res.json({ status: 'success', message: msg });
    }
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
  } catch (err) {
    console.error('Individual user reconciliation failed:', err.message);
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) {
      return res.status(500).json({ status: 'error', message: err.message });
    }
    res.redirect('/admin/paid-products?error=' + encodeURIComponent(err.message));
  }
});

// GET /admin/paid-products/create
app.get('/admin/paid-products/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getAllRoles } = await import('./auth/paidProducts.js');
    const roles = await getAllRoles();
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    
    res.render('admin-paid-product-create', {
      user: req.user,
      expiringCount,
      roles,
      form: null,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/paid-products/create
app.post('/admin/paid-products/create', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const { code, name, description, role_id, is_enabled, max_active_members } = req.body;
  const isEnabled = is_enabled === 'true' || is_enabled === true || is_enabled === 'on';
  
  try {
    const { getAllRoles, createPaidProduct, logPaidProductEvent } = await import('./auth/paidProducts.js');
    
    // Server-side validations
    if (!code || !code.trim()) {
      throw new Error('Product Code is required.');
    }
    const cleanCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(cleanCode)) {
      throw new Error('Product Code must contain only uppercase alphanumeric characters and underscores.');
    }
    if (!name || !name.trim()) {
      throw new Error('Product Name is required.');
    }
    if (!role_id) {
      throw new Error('RBAC Role Mapping is required.');
    }
    
    const roles = await getAllRoles();
    const roleExists = roles.some(r => Number(r.id) === Number(role_id));
    if (!roleExists) {
      throw new Error('Selected system role is invalid or does not exist.');
    }
    
    const product = await createPaidProduct({
      code: cleanCode,
      name: name.trim(),
      description: description ? description.trim() : '',
      role_id: Number(role_id),
      is_enabled: isEnabled,
      max_active_members: max_active_members && max_active_members.trim() !== '' ? parseInt(max_active_members, 10) : null
    });
    
    await logPaidProductEvent({
      productId: product.id,
      userId: req.user.id,
      eventType: 'product_created',
      newStatus: 'enabled',
      message: `Product "${product.name}" (${product.code}) was created by admin.`,
      payload: { code: product.code, name: product.name, role_id: product.role_id, is_enabled: product.is_enabled }
    });
    
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(`Product "${product.name}" created successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getAllRoles } = await import('./auth/paidProducts.js');
    const roles = await getAllRoles().catch(() => []);
    res.render('admin-paid-product-create', {
      user: req.user,
      expiringCount,
      roles,
      form: req.body,
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

// GET /admin/paid-products/:id/edit
app.get('/admin/paid-products/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getProductById, getAllRoles } = await import('./auth/paidProducts.js');
    const productIdNum = parseInt(req.params.id, 10);
    if (isNaN(productIdNum)) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Invalid product ID format'));
    }
    const product = await getProductById(productIdNum);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product not found'));
    }
    const roles = await getAllRoles();
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    
    res.render('admin-paid-product-edit', {
      user: req.user,
      expiringCount,
      product,
      roles,
      form: {},
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/paid-products/:id/edit
app.post('/admin/paid-products/:id/edit', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const { name, description, role_id, is_enabled, max_active_members } = req.body;
  const isEnabled = is_enabled === 'true' || is_enabled === true || is_enabled === 'on';
  
  try {
    const { getProductById, getAllRoles, updatePaidProduct, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.id);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product not found'));
    }
    
    // Server-side validations
    if (!name || !name.trim()) {
      throw new Error('Product Name is required.');
    }
    if (!role_id) {
      throw new Error('RBAC Role Mapping is required.');
    }
    const roles = await getAllRoles();
    const roleExists = roles.some(r => Number(r.id) === Number(role_id));
    if (!roleExists) {
      throw new Error('Selected system role is invalid or does not exist.');
    }
    
    const previousState = {
      name: product.name,
      description: product.description,
      role_id: product.role_id,
      is_enabled: product.is_enabled
    };
    
    const updated = await updatePaidProduct(product.id, {
      name: name.trim(),
      description: description ? description.trim() : '',
      role_id: Number(role_id),
      is_enabled: isEnabled,
      max_active_members: max_active_members && max_active_members.trim() !== '' ? parseInt(max_active_members, 10) : null
    });
    
    await logPaidProductEvent({
      productId: updated.id,
      userId: req.user.id,
      eventType: 'product_updated',
      previousStatus: previousState.is_enabled ? 'enabled' : 'disabled',
      newStatus: updated.is_enabled ? 'enabled' : 'disabled',
      message: `Product "${updated.name}" was updated by admin.`,
      payload: { previous: previousState, current: updated }
    });
    
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(`Product "${updated.name}" updated successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getProductById, getAllRoles } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.id).catch(() => null);
    const roles = await getAllRoles().catch(() => []);
    res.render('admin-paid-product-edit', {
      user: req.user,
      expiringCount,
      product: product || { id: req.params.id },
      roles,
      form: req.body || {},
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

// POST /admin/paid-products/:id/delete
app.post('/admin/paid-products/:id/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const { getProductById, deletePaidProduct, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.id);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product not found'));
    }

    await deletePaidProduct(req.params.id);

    await logPaidProductEvent({
      productId: null, // Product is already deleted, avoid FK constraint violation
      userId: req.user.id,
      eventType: 'product_deleted',
      previousStatus: product.is_enabled ? 'enabled' : 'disabled',
      newStatus: 'deleted',
      message: `Product "${product.name}" was permanently deleted by admin.`,
      payload: { deletedProduct: product, originalProductId: product.id }
    });

    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(`Product "${product.name}" was successfully deleted.`));
  } catch (err) {
    res.redirect('/admin/paid-products?error=' + encodeURIComponent(err.message));
  }
});

// GET /admin/paid-products/:productId/plan/create
app.get('/admin/paid-products/:productId/plan/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getProductById } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.productId);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product not found'));
    }
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    
    res.render('admin-paid-product-plan-create', {
      user: req.user,
      expiringCount,
      product,
      form: null,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/paid-products/:productId/plan/create
app.post('/admin/paid-products/:productId/plan/create', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const { code, name, billing_type, price, currency, duration_days, razorpay_plan_id, is_active } = req.body;
  const isActive = is_active === 'true' || is_active === true || is_active === 'on';
  
  try {
    const { getProductById, createPaidProductPlan, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.productId);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product not found'));
    }
    
    // Server-side validations
    if (!code || !code.trim()) {
      throw new Error('Plan Code is required.');
    }
    const cleanCode = code.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(cleanCode)) {
      throw new Error('Plan Code must contain only lowercase alphanumeric characters and underscores.');
    }
    if (!name || !name.trim()) {
      throw new Error('Plan Name is required.');
    }
    if (!billing_type || !['recurring', 'one_time'].includes(billing_type)) {
      throw new Error('Billing Type must be either "recurring" or "one_time".');
    }
    if (billing_type === 'recurring' && (!razorpay_plan_id || !razorpay_plan_id.trim())) {
      throw new Error('Recurring plans require a Razorpay Plan ID.');
    }
    if (billing_type === 'one_time' && (!duration_days || !duration_days.trim())) {
      throw new Error('One-time plans require duration in days.');
    }
    if (price === undefined || price === null || price === '') {
      throw new Error('Price is required.');
    }
    const numericPrice = Number(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      throw new Error('Price must be a valid non-negative number.');
    }
    const priceAmountPaise = Math.round(numericPrice * 100);
    
    let duration = null;
    if (duration_days && duration_days.trim()) {
      duration = Number(duration_days);
      if (isNaN(duration) || duration <= 0) {
        throw new Error('Duration must be a positive integer of days.');
      }
    }
    
    const plan = await createPaidProductPlan({
      product_id: product.id,
      code: cleanCode,
      name: name.trim(),
      billing_type,
      price_amount_paise: priceAmountPaise,
      currency: currency ? currency.trim().toUpperCase() : 'INR',
      duration_days: duration,
      razorpay_plan_id: razorpay_plan_id ? razorpay_plan_id.trim() : null,
      is_active: isActive
    });
    
    await logPaidProductEvent({
      productId: product.id,
      userId: req.user.id,
      eventType: 'plan_created',
      newStatus: plan.is_active ? 'active' : 'inactive',
      message: `Plan "${plan.name}" (${plan.code}) was created by admin for product "${product.name}".`,
      payload: { planId: plan.id, code: plan.code, name: plan.name, price_amount_paise: plan.price_amount_paise, duration_days: plan.duration_days }
    });
    
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(`Plan "${plan.name}" created successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getProductById } = await import('./auth/paidProducts.js');
    const product = await getProductById(req.params.productId).catch(() => null);
    res.render('admin-paid-product-plan-create', {
      user: req.user,
      expiringCount,
      product: product || { id: req.params.productId },
      form: req.body,
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

// GET /admin/paid-products/plan/:planId/edit
app.get('/admin/paid-products/plan/:planId/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getPlanById, getProductById } = await import('./auth/paidProducts.js');
    const planIdNum = parseInt(req.params.planId, 10);
    if (isNaN(planIdNum)) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Invalid plan ID format'));
    }
    const plan = await getPlanById(planIdNum);
    if (!plan) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Plan not found'));
    }
    const product = await getProductById(plan.product_id);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product associated with this plan not found'));
    }
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    
    res.render('admin-paid-product-plan-edit', {
      user: req.user,
      expiringCount,
      plan,
      product,
      form: {},
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/paid-products/plan/:planId/edit
app.post('/admin/paid-products/plan/:planId/edit', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const { name, billing_type, price, currency, duration_days, razorpay_plan_id, is_active } = req.body;
  const isActive = is_active === 'true' || is_active === true || is_active === 'on';
  
  try {
    const { getPlanById, getProductById, updatePaidProductPlan, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const plan = await getPlanById(req.params.planId);
    if (!plan) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Plan not found'));
    }
    const product = await getProductById(plan.product_id);
    if (!product) {
      return res.redirect('/admin/paid-products?error=' + encodeURIComponent('Product associated with this plan not found'));
    }
    
    // Server-side validations
    if (!name || !name.trim()) {
      throw new Error('Plan Name is required.');
    }
    if (!billing_type || !['recurring', 'one_time'].includes(billing_type)) {
      throw new Error('Billing Type must be either "recurring" or "one_time".');
    }
    if (billing_type === 'recurring' && (!razorpay_plan_id || !razorpay_plan_id.trim())) {
      throw new Error('Recurring plans require a Razorpay Plan ID.');
    }
    if (billing_type === 'one_time' && (!duration_days || !duration_days.trim())) {
      throw new Error('One-time plans require duration in days.');
    }
    if (price === undefined || price === null || price === '') {
      throw new Error('Price is required.');
    }
    const numericPrice = Number(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      throw new Error('Price must be a valid non-negative number.');
    }
    const priceAmountPaise = Math.round(numericPrice * 100);
    
    let duration = null;
    if (duration_days && duration_days.trim()) {
      duration = Number(duration_days);
      if (isNaN(duration) || duration <= 0) {
        throw new Error('Duration must be a positive integer of days.');
      }
    }
    
    const previousState = {
      name: plan.name,
      billing_type: plan.billing_type,
      price_amount_paise: plan.price_amount_paise,
      currency: plan.currency,
      duration_days: plan.duration_days,
      razorpay_plan_id: plan.razorpay_plan_id,
      is_active: plan.is_active
    };
    
    const updated = await updatePaidProductPlan(plan.id, {
      name: name.trim(),
      billing_type,
      price_amount_paise: priceAmountPaise,
      currency: currency ? currency.trim().toUpperCase() : 'INR',
      duration_days: duration,
      razorpay_plan_id: razorpay_plan_id ? razorpay_plan_id.trim() : null,
      is_active: isActive
    });
    
    await logPaidProductEvent({
      productId: product.id,
      userId: req.user.id,
      eventType: 'plan_updated',
      previousStatus: previousState.is_active ? 'active' : 'inactive',
      newStatus: updated.is_active ? 'active' : 'inactive',
      message: `Plan "${updated.name}" (${updated.code}) was updated by admin.`,
      payload: { previous: previousState, current: updated }
    });
    
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(`Plan "${updated.name}" updated successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getPlanById, getProductById } = await import('./auth/paidProducts.js');
    const plan = await getPlanById(req.params.planId).catch(() => null);
    const product = plan ? await getProductById(plan.product_id).catch(() => null) : null;
    res.render('admin-paid-product-plan-edit', {
      user: req.user,
      expiringCount,
      plan: plan || { id: req.params.planId },
      product: product || {},
      form: req.body || {},
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

app.post('/admin/paid-products/:id/toggle', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const { getProductById, setProductEnabled, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const productId = req.params.id;
    const isEnabled = req.body.enabled === 'true';

    const product = await getProductById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    const previousStatus = product.is_enabled ? 'enabled' : 'disabled';
    const newStatus = isEnabled ? 'enabled' : 'disabled';

    await setProductEnabled(productId, isEnabled);

    // Audit logging
    await logPaidProductEvent({
      productId,
      userId: req.user.id,
      eventType: 'product_enabled_changed',
      previousStatus,
      newStatus,
      message: `Product "${product.name}" (${product.code}) was ${newStatus} by admin.`,
      payload: { productId, isEnabled, previousStatus, newStatus }
    });

    const msg = `Product "${product.name}" has been ${isEnabled ? 'enabled' : 'disabled'}.`;
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
  } catch (err) {
    res.redirect('/admin/paid-products?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/paid-products/plan/:id/toggle', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const { setPlanActive, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const planId = req.params.id;
    const isActive = req.body.active === 'true';

    // Retrieve previous state
    const { pool } = await import('./db/pool.js');
    const planRes = await pool.query('SELECT * FROM paid_product_plans WHERE id = $1', [planId]);
    const plan = planRes.rows[0];
    if (!plan) {
      throw new Error('Plan not found');
    }

    const previousStatus = plan.is_active ? 'active' : 'inactive';
    const newStatus = isActive ? 'active' : 'inactive';

    await setPlanActive(planId, isActive);

    // Audit logging
    await logPaidProductEvent({
      productId: plan.product_id,
      userId: req.user.id,
      eventType: 'plan_active_changed',
      previousStatus,
      newStatus,
      message: `Plan "${plan.name}" (${plan.code}) was set to ${newStatus} by admin.`,
      payload: { planId, isActive, previousStatus, newStatus }
    });

    const msg = `Plan "${plan.name}" has been set to ${isActive ? 'active' : 'inactive'}.`;
    res.redirect('/admin/paid-products?msg=' + encodeURIComponent(msg));
  } catch (err) {
    res.redirect('/admin/paid-products?error=' + encodeURIComponent(err.message));
  }
});


// === Admin: Promotion Codes & Discounts Management (Thought #4 Phase 2F-2) ===

// GET /admin/promotions
app.get('/admin/promotions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getAllPromotions, getAllProductsWithRoles: getAllProducts } = await import('./auth/paidProducts.js');
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }

    const promotions = await getAllPromotions();
    const products = await getAllProducts();

    res.render('admin-promotions', {
      user: req.user,
      expiringCount,
      promotions,
      products,
      msg: req.query.msg || null,
      error: req.query.error || null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// GET /admin/promotions/create
app.get('/admin/promotions/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getAllProductsWithRoles: getAllProducts } = await import('./auth/paidProducts.js');
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
    const products = await getAllProducts();

    res.render('admin-promo-create', {
      user: req.user,
      expiringCount,
      products,
      form: null,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/promotions/create
app.post('/admin/promotions/create', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  let {
    code,
    product_id,
    discount_type,
    discount_value,
    eligibility_days,
    max_redemptions,
    valid_from,
    valid_until,
    is_enabled,
    recurring_offer_id,
    show_on_payment_screen
  } = req.body;

  const isEnabled = is_enabled === 'true' || is_enabled === true || is_enabled === 'on';
  const showOnPaymentScreen = show_on_payment_screen === 'true' || show_on_payment_screen === true || show_on_payment_screen === 'on';

  try {
    const { getAllProductsWithRoles: getAllProducts, isPromoCodeDuplicate, createPaidProductPromotion, logPaidProductEvent } = await import('./auth/paidProducts.js');

    if (!code || !code.trim()) {
      throw new Error('Promotion Code is required.');
    }
    const codeClean = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(codeClean)) {
      throw new Error('Promotion Code must contain only alphanumeric characters, dashes, and underscores.');
    }

    const productId = parseInt(product_id, 10);
    if (isNaN(productId)) {
      throw new Error('Valid applicable product is required.');
    }

    const products = await getAllProducts();
    const productExists = products.some(p => Number(p.id) === productId);
    if (!productExists) {
      throw new Error('Selected applicable product is invalid.');
    }

    if (discount_type !== 'percentage' && discount_type !== 'flat') {
      throw new Error('Discount Type must be either percentage or flat.');
    }

    let discountVal = parseInt(discount_value, 10);
    if (isNaN(discountVal) || discountVal < 0) {
      throw new Error('Discount Value must be a non-negative integer.');
    }

    if (discount_type === 'percentage') {
      if (discountVal > 100) {
        throw new Error('Percentage discount cannot exceed 100%.');
      }
    } else {
      // Input standard INR, store as paise
      discountVal = discountVal * 100;
    }

    const eligibilityDays = eligibility_days ? parseInt(eligibility_days, 10) : null;
    if (eligibilityDays !== null && (isNaN(eligibilityDays) || eligibilityDays < 1)) {
      throw new Error('Eligibility Days must be a positive integer >= 1.');
    }

    const maxRedemptions = max_redemptions ? parseInt(max_redemptions, 10) : null;
    if (maxRedemptions !== null && (isNaN(maxRedemptions) || maxRedemptions < 1)) {
      throw new Error('Max Redemptions must be a positive integer >= 1.');
    }

    const validFrom = valid_from ? new Date(valid_from) : null;
    const validUntil = valid_until ? new Date(valid_until) : null;

    if (validFrom && isNaN(validFrom.getTime())) {
      throw new Error('Invalid Active From date.');
    }
    if (validUntil && isNaN(validUntil.getTime())) {
      throw new Error('Invalid Active Until date.');
    }
    if (validFrom && validUntil && validUntil < validFrom) {
      throw new Error('Active Until (expiry) date cannot be prior to Active From date.');
    }

    // Check code duplicate within product scope
    const isDuplicate = await isPromoCodeDuplicate(codeClean, productId);
    if (isDuplicate) {
      throw new Error(`Promotion code "${codeClean}" already exists for the selected product scope.`);
    }

    const recurringOfferId = recurring_offer_id ? String(recurring_offer_id).trim() : null;

    const promotion = await createPaidProductPromotion({
      code: codeClean,
      productId,
      discountType: discount_type,
      discountValue: discountVal,
      eligibilityDays,
      maxRedemptions,
      validFrom,
      validUntil,
      isEnabled,
      recurringOfferId,
      showOnPaymentScreen
    });

    await logPaidProductEvent({
      productId,
      userId: req.user.id,
      eventType: 'promotion_created',
      newStatus: isEnabled ? 'enabled' : 'disabled',
      message: `Promotion "${promotion.code}" (ID ${promotion.id}) created by admin.`,
      payload: { ...promotion }
    });

    res.redirect('/admin/promotions?msg=' + encodeURIComponent(`Promotion code "${promotion.code}" created successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getAllProductsWithRoles: getAllProducts } = await import('./auth/paidProducts.js');
    const products = await getAllProducts().catch(() => []);
    res.render('admin-promo-create', {
      user: req.user,
      expiringCount,
      products,
      form: req.body,
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

// GET /admin/promotions/:id/edit
app.get('/admin/promotions/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const promoId = parseInt(req.params.id, 10);
    if (isNaN(promoId)) {
      return res.redirect('/admin/promotions?error=' + encodeURIComponent('Invalid promotion ID.'));
    }

    const { getPromotionDetails, getAllProductsWithRoles: getAllProducts } = await import('./auth/paidProducts.js');
    const promotion = await getPromotionDetails(promoId);
    if (!promotion) {
      return res.redirect('/admin/promotions?error=' + encodeURIComponent('Promotion not found.'));
    }

    const products = await getAllProducts();
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}

    res.render('admin-promo-edit', {
      user: req.user,
      expiringCount,
      promotion,
      products,
      form: null,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  } catch (err) {
    adminError(res, err);
  }
});

// POST /admin/promotions/:id/edit
app.post('/admin/promotions/:id/edit', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const promoId = parseInt(req.params.id, 10);
  if (isNaN(promoId)) {
    return res.redirect('/admin/promotions?error=' + encodeURIComponent('Invalid promotion ID.'));
  }

  let {
    code,
    product_id,
    discount_type,
    discount_value,
    eligibility_days,
    max_redemptions,
    valid_from,
    valid_until,
    is_enabled,
    recurring_offer_id,
    show_on_payment_screen
  } = req.body;

  const isEnabled = is_enabled === 'true' || is_enabled === true || is_enabled === 'on';
  const showOnPaymentScreen = show_on_payment_screen === 'true' || show_on_payment_screen === true || show_on_payment_screen === 'on';

  try {
    const { getPromotionDetails, getAllProductsWithRoles: getAllProducts, isPromoCodeDuplicate, updatePaidProductPromotion, logPaidProductEvent } = await import('./auth/paidProducts.js');

    const original = await getPromotionDetails(promoId);
    if (!original) {
      throw new Error('Promotion not found.');
    }

    if (!code || !code.trim()) {
      throw new Error('Promotion Code is required.');
    }
    const codeClean = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(codeClean)) {
      throw new Error('Promotion Code must contain only alphanumeric characters, dashes, and underscores.');
    }

    const productId = parseInt(product_id, 10);
    if (isNaN(productId)) {
      throw new Error('Valid applicable product is required.');
    }

    const products = await getAllProducts();
    const productExists = products.some(p => Number(p.id) === productId);
    if (!productExists) {
      throw new Error('Selected applicable product is invalid.');
    }

    if (discount_type !== 'percentage' && discount_type !== 'flat') {
      throw new Error('Discount Type must be either percentage or flat.');
    }

    let discountVal = parseInt(discount_value, 10);
    if (isNaN(discountVal) || discountVal < 0) {
      throw new Error('Discount Value must be a non-negative integer.');
    }

    if (discount_type === 'percentage') {
      if (discountVal > 100) {
        throw new Error('Percentage discount cannot exceed 100%.');
      }
    } else {
      // Input standard INR, store as paise
      discountVal = discountVal * 100;
    }

    const eligibilityDays = eligibility_days ? parseInt(eligibility_days, 10) : null;
    if (eligibilityDays !== null && (isNaN(eligibilityDays) || eligibilityDays < 1)) {
      throw new Error('Eligibility Days must be a positive integer >= 1.');
    }

    const maxRedemptions = max_redemptions ? parseInt(max_redemptions, 10) : null;
    if (maxRedemptions !== null && (isNaN(maxRedemptions) || maxRedemptions < 1)) {
      throw new Error('Max Redemptions must be a positive integer >= 1.');
    }

    const validFrom = valid_from ? new Date(valid_from) : null;
    const validUntil = valid_until ? new Date(valid_until) : null;

    if (validFrom && isNaN(validFrom.getTime())) {
      throw new Error('Invalid Active From date.');
    }
    if (validUntil && isNaN(validUntil.getTime())) {
      throw new Error('Invalid Active Until date.');
    }
    if (validFrom && validUntil && validUntil < validFrom) {
      throw new Error('Active Until (expiry) date cannot be prior to Active From date.');
    }

    // Check code duplicate in scope (excluding current promo)
    const isDuplicate = await isPromoCodeDuplicate(codeClean, productId, promoId);
    if (isDuplicate) {
      throw new Error(`Promotion code "${codeClean}" already exists for the selected product scope.`);
    }

    const recurringOfferId = recurring_offer_id ? String(recurring_offer_id).trim() : null;

    const updated = await updatePaidProductPromotion(promoId, {
      code: codeClean,
      productId,
      discountType: discount_type,
      discountValue: discountVal,
      eligibilityDays,
      maxRedemptions,
      validFrom,
      validUntil,
      isEnabled,
      recurringOfferId,
      showOnPaymentScreen
    });

    const previousStatus = original.is_enabled ? 'enabled' : 'disabled';
    const newStatus = isEnabled ? 'enabled' : 'disabled';

    await logPaidProductEvent({
      productId,
      userId: req.user.id,
      eventType: 'promotion_updated',
      previousStatus,
      newStatus,
      message: `Promotion "${updated.code}" (ID ${updated.id}) updated by admin.`,
      payload: { original, updated }
    });

    res.redirect('/admin/promotions?msg=' + encodeURIComponent(`Promotion code "${updated.code}" updated successfully.`));
  } catch (err) {
    let expiringCount = null;
    try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch {}
    const { getAllProductsWithRoles: getAllProducts, getPromotionDetails } = await import('./auth/paidProducts.js');
    const products = await getAllProducts().catch(() => []);
    const promotion = await getPromotionDetails(promoId).catch(() => null);
    res.render('admin-promo-edit', {
      user: req.user,
      expiringCount,
      promotion: promotion || { id: promoId, code },
      products,
      form: req.body,
      error: err.message,
      csrfToken: req.csrfToken ? req.csrfToken() : ''
    });
  }
});

// POST /admin/promotions/:id/toggle
app.post('/admin/promotions/:id/toggle', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const promoId = parseInt(req.params.id, 10);
    if (isNaN(promoId)) {
      return res.redirect('/admin/promotions?error=' + encodeURIComponent('Invalid promotion ID.'));
    }

    const isEnabled = req.body.enabled === 'true';

    const { getPromotionDetails, setPromotionEnabled, logPaidProductEvent } = await import('./auth/paidProducts.js');
    const promo = await getPromotionDetails(promoId);
    if (!promo) {
      return res.redirect('/admin/promotions?error=' + encodeURIComponent('Promotion not found.'));
    }

    await setPromotionEnabled(promoId, isEnabled);

    const previousStatus = promo.is_enabled ? 'enabled' : 'disabled';
    const newStatus = isEnabled ? 'enabled' : 'disabled';

    await logPaidProductEvent({
      productId: promo.product_id,
      userId: req.user.id,
      eventType: 'promotion_toggled',
      previousStatus,
      newStatus,
      message: `Promotion code "${promo.code}" was set to ${newStatus} by admin.`,
      payload: { promoId, isEnabled, previousStatus, newStatus }
    });

    res.redirect('/admin/promotions?msg=' + encodeURIComponent(`Promotion "${promo.code}" has been ${isEnabled ? 'enabled' : 'disabled'}.`));
  } catch (err) {
    res.redirect('/admin/promotions?error=' + encodeURIComponent(err.message));
  }
});


// ADMIN-ONLY: AI Admin Center — dedicated screen hosting the read-only AI
// Admin Assistant, capabilities, diagnostic actions, digest, and workflow
// status sections. All sections are client-rendered skeletons over existing
// admin-only APIs; this route serves no data itself.
app.get('/admin/ai', requireAuth, requireAdmin, async (req, res) => {
  let expiringCount = null;
  try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
  res.render('admin-ai', {
    user: req.user,
    currentUrl: '/admin/ai',
    expiringCount
  });
});

// ADMIN-ONLY: Dedicated Security Lab page — full catalog with install status
// and the admin-only Run + Confirm flow (see src/security-lab/). The page
// renders a skeleton only; all tool data loads client-side from the
// admin-only JSON APIs. No execution happens server-side on page load.
app.get('/admin/security-lab', requireAuth, requireAdmin, async (req, res) => {
  let expiringCount = null;
  try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
  res.render('admin-security-lab', {
    user: req.user,
    currentUrl: '/admin/security-lab',
    expiringCount
  });
});

app.get('/admin/audit-logs', requireAuth, requireAdmin, async (req, res) => {
  let expiringCount = null;
  try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }
  const auditLog = await getAuditLog();
  let roleAuditLog = [];
  try { roleAuditLog = await getRoleAuditLog(50); } catch {}
  let contentPermissionAuditLog = [];
  try { contentPermissionAuditLog = await getContentPermissionAuditLog(50); } catch {}
  const validFilters = ['all', 'access', 'role', 'content'];
  let raw = String(req.query.filter ?? req.query.type ?? 'all').trim().toLowerCase();
  // normalize "content_permission" or "content-permission" to "content"
  if (raw === 'content_permission' || raw === 'content-permission' || raw === 'content-permission-audit' || raw === 'permission') raw = 'content';
  const filter = validFilters.includes(raw) ? raw : 'all';
  res.render('admin-audit-logs', {
    user: req.user,
    expiringCount,
    auditLog,
    roleAuditLog,
    contentPermissionAuditLog,
    filter
  });
});

// ADMIN-ONLY: Video Protection Events — identify a viewer's video session from
// the 8-character watermark code visible in a recording. Search-only (no full
// table dump); full session_ids are never selected or rendered. Isolated from
// other admin functionality; authorization via existing requireAdmin.
app.get('/admin/video-protection', requireAuth, requireAdmin, async (req, res) => {
  const sessionCode = String(req.query.session || '').trim();
  let result = null;
  if (sessionCode) {
    try {
      result = await searchVideoProtectionSession(sessionCode);
    } catch {
      result = { ok: false, error: 'Unable to search protection events right now.' };
    }
  }
  res.render('admin-video-protection', {
    user: req.user,
    sessionCode,
    result
  });
});

app.get('/admin/user-activity', requireAuth, requireAdmin, async (req, res) => {
  const users = await getUsersForAdmin();
  let expiringCount = null;
  try { const exp = await getExpiringUsers(); expiringCount = exp.length; } catch { expiringCount = null; }

  const stats = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE)::int AS active_today,
      COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE - INTERVAL '30 days')::int AS active_month,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_users,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'view' AND created_at >= CURRENT_DATE) AS views_today,
      (SELECT COUNT(*)::int FROM query_usage WHERE action = 'copy' AND created_at >= CURRENT_DATE) AS copies_today,
      (SELECT COUNT(*)::int FROM discussions) AS total_discussions,
      (SELECT COUNT(*)::int FROM discussion_replies) AS total_replies
    FROM users
  `);

  const popular = await pool.query(`
    SELECT
      query_path,
      COUNT(*) FILTER (WHERE action = 'view')::int AS views,
      COUNT(*) FILTER (WHERE action = 'copy')::int AS copies
    FROM query_usage
    GROUP BY query_path
    ORDER BY views DESC, copies DESC, query_path
    LIMIT 20
  `);

  const likedItems = await pool.query(`
    SELECT i.item_path, COUNT(*)::int AS like_count,
           array_agg(JSON_BUILD_OBJECT('name', u.name, 'email', u.email, 'liked_at', i.created_at) ORDER BY i.created_at DESC) AS likers
    FROM item_likes i
    JOIN users u ON i.user_id = u.id
    GROUP BY i.item_path
    ORDER BY like_count DESC, i.item_path
    LIMIT 50
  `);

  const flashMessages = {
    approved: 'User approved.',
    extended: 'Access extended.',
    revoked: 'Access revoked.',
    reactivated: 'User reactivated.',
    adminGranted: 'Admin role granted.',
    adminRevoked: 'Admin role removed.',
    premiumGranted: 'Premium role granted.',
    premiumRevoked: 'Premium role removed.',
    contentGranted: 'Permission granted.',
    contentRevoked: 'Permission revoked.'
  };
  const rawMsg = typeof req.query.msg === 'string' ? req.query.msg : null;
  const msg = rawMsg ? (flashMessages[rawMsg] || rawMsg) : null;
  const error = typeof req.query.error === 'string' && req.query.error ? req.query.error : null;

  // --- User Activity & Learning Dashboard data processing ---
  const activitySearch = typeof req.query.activity_search === 'string' ? req.query.activity_search.trim() : '';
  let activityUsersFilter = [];
  if (req.query.activity_users) {
    if (Array.isArray(req.query.activity_users)) {
      activityUsersFilter = req.query.activity_users.map(id => parseInt(id) || 0).filter(id => id > 0);
    } else if (typeof req.query.activity_users === 'string') {
      activityUsersFilter = req.query.activity_users.split(',').map(id => parseInt(id.trim()) || 0).filter(id => id > 0);
    }
  }

  const activityStatus = typeof req.query.activity_status === 'string' ? req.query.activity_status.trim() : '';
  const activityPage = Math.max(1, parseInt(req.query.activity_page) || 1);
  const activityLimit = 10;
  const activityOffset = (activityPage - 1) * activityLimit;

  let activityWhereClauses = [];
  let activityQueryParams = [];
  let actParamIdx = 1;

  if (activityUsersFilter.length > 0) {
    const placeholders = activityUsersFilter.map((_, i) => `$${actParamIdx + i}`).join(', ');
    activityWhereClauses.push(`id IN (${placeholders})`);
    activityQueryParams.push(...activityUsersFilter);
    actParamIdx += activityUsersFilter.length;
  } else if (activitySearch) {
    activityWhereClauses.push(`(name ILIKE $${actParamIdx} OR email ILIKE $${actParamIdx})`);
    activityQueryParams.push(`%${activitySearch}%`);
    actParamIdx++;
  }

  if (activityStatus) {
    if (activityStatus === 'pending') {
      activityWhereClauses.push(`status = 'pending'`);
    } else if (activityStatus === 'revoked') {
      activityWhereClauses.push(`status = 'revoked'`);
    } else if (activityStatus === 'expired') {
      activityWhereClauses.push(`(status = 'active' AND (access_expires_at IS NULL OR access_expires_at <= NOW()))`);
    } else if (activityStatus === 'active') {
      activityWhereClauses.push(`(status = 'active' AND access_expires_at > NOW())`);
    }
  }

  const activityWhereSql = activityWhereClauses.length > 0 ? `WHERE ${activityWhereClauses.join(' AND ')}` : '';

  let totalActivityUsers = 0;
  try {
    const activityCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM users ${activityWhereSql}`, activityQueryParams);
    totalActivityUsers = (activityCountRes && activityCountRes.rows && activityCountRes.rows[0] && ('count' in activityCountRes.rows[0])) 
      ? Number(activityCountRes.rows[0].count) 
      : (users ? users.length : 0);
  } catch {
    totalActivityUsers = users ? users.length : 0;
  }
  const totalActivityPages = Math.ceil(totalActivityUsers / activityLimit);

  let activityUsersRaw = [];
  try {
    const actUsersRes = await pool.query(
      `SELECT id, google_user_id, email, name, status, first_login_at, last_login_at, access_expires_at, created_at, app_role
       FROM users
       ${activityWhereSql}
       ORDER BY created_at DESC
       LIMIT $${actParamIdx} OFFSET $${actParamIdx + 1}`,
      [...activityQueryParams, activityLimit, activityOffset]
    );
    activityUsersRaw = (actUsersRes && actUsersRes.rows) ? actUsersRes.rows : [];
  } catch {
    try {
      const actUsersRes = await pool.query(
        `SELECT id, google_user_id, email, name, status, first_login_at, last_login_at, access_expires_at, created_at
         FROM users
         ${activityWhereSql}
         ORDER BY created_at DESC
         LIMIT $${actParamIdx} OFFSET $${actParamIdx + 1}`,
        [...activityQueryParams, activityLimit, activityOffset]
      );
      activityUsersRaw = (actUsersRes && actUsersRes.rows) ? actUsersRes.rows : [];
    } catch {
      activityUsersRaw = users ? users.slice(activityOffset, activityOffset + activityLimit) : [];
    }
  }

  // Ensure fallback if query returned empty under a mocked test setting but users actually exist
  if (activityUsersRaw.length === 0 && !activitySearch && !activityStatus && users && users.length > 0) {
    activityUsersRaw = users.slice(activityOffset, activityOffset + activityLimit);
  }

  let enrichedActivityUsers = [];
  if (activityUsersRaw.length > 0) {
    const actUserIds = activityUsersRaw.map(u => u.id);

    let actLikesRes = { rows: [] };
    try {
      actLikesRes = await pool.query(
        `SELECT user_id, item_path, created_at FROM item_likes WHERE user_id = ANY($1) ORDER BY created_at DESC`,
        [actUserIds]
      );
    } catch {}

    let actViewsRes = { rows: [] };
    try {
      actViewsRes = await pool.query(
        `SELECT user_id, item_path, last_viewed_at, created_at FROM recently_viewed WHERE user_id = ANY($1) ORDER BY last_viewed_at DESC`,
        [actUserIds]
      );
    } catch {}

    let actSeenRes = { rows: [] };
    try {
      actSeenRes = await pool.query(
        `SELECT user_id, item_path, seen_at, status, created_at FROM content_seen WHERE user_id = ANY($1) ORDER BY seen_at DESC`,
        [actUserIds]
      );
    } catch {}

    const actUsersMap = new Map(activityUsersRaw.map(u => [u.id, {
      ...u,
      likes: [],
      views: [],
      seen: []
    }]));

    if (actLikesRes && actLikesRes.rows) {
      for (const r of actLikesRes.rows) {
        const u = actUsersMap.get(r.user_id);
        if (u) u.likes.push(r);
      }
    }

    if (actViewsRes && actViewsRes.rows) {
      for (const r of actViewsRes.rows) {
        const u = actUsersMap.get(r.user_id);
        if (u) u.views.push(r);
      }
    }

    if (actSeenRes && actSeenRes.rows) {
      for (const r of actSeenRes.rows) {
        const u = actUsersMap.get(r.user_id);
        if (u) u.seen.push(r);
      }
    }

    enrichedActivityUsers = Array.from(actUsersMap.values());

    enrichedActivityUsers.forEach(u => {
      const ts = [];
      if (u.last_login_at) ts.push(new Date(u.last_login_at));
      u.likes.forEach(l => { if (l.created_at) ts.push(new Date(l.created_at)); });
      u.views.forEach(v => { if (v.last_viewed_at) ts.push(new Date(v.last_viewed_at)); });
      u.seen.forEach(s => { if (s.seen_at) ts.push(new Date(s.seen_at)); });

      if (ts.length > 0) {
        u.last_activity_at = new Date(Math.max(...ts.map(t => t.getTime())));
      } else {
        u.last_activity_at = null;
      }

      const st = statusDisplay(u);
      const role = (typeof getUserRole === 'function' ? getUserRole(u) : (u.app_role || (typeof isAdminEmail === 'function' && isAdminEmail(u.email) ? 'OWNER' : 'USER')));
      const isOwnerRow = role === 'OWNER';
      const isAdminRow = role === 'ADMIN';
      const isProtected = isOwnerRow || isAdminRow;
      const expiry = u.access_expires_at ? new Date(u.access_expires_at) : null;
      const daysRemaining = expiry ? Math.ceil((expiry - new Date()) / 86400000) : null;
      const isExpiringSoon = !isProtected && st === 'active' && daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 7;

      u.needsAttention = st === 'pending' || st === 'revoked' || st === 'expired' || isExpiringSoon;
    });
  }

  let allUsersList = [];
  try {
    const allUsersListRes = await pool.query(`SELECT id, name, email FROM users ORDER BY COALESCE(name, ''), email ASC`);
    allUsersList = allUsersListRes.rows || [];
  } catch {
    allUsersList = users || [];
  }

  res.render('admin-user-activity', {
    user: req.user,
    expiringCount,
    activityUsers: enrichedActivityUsers,
    activitySearch,
    activityUsersFilter,
    allUsersList,
    activityStatus,
    activityPage,
    totalActivityPages,
    totalActivityUsers,
    popular: popular.rows,
    likedItems: likedItems.rows,
    displayName,
    statusDisplay,
    getUserRole,
    contentRouteForPath,
    msg,
    error
  });
});

app.get('/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tree = await getLibrary();
    const analytics = await getAnalyticsOverview(tree);
    res.render('admin-analytics', {
      user: req.user,
      users: analytics.users,
      discussions: analytics.discussions,
      library: analytics.library,
      topLiked: analytics.topLiked,
      topViewed: analytics.topViewed,
      recentLogins: analytics.recentLogins,
      recentQuestions: analytics.recentQuestions,
      recentViews: analytics.recentViews,
      contentRouteForPath
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load analytics.' });
  }
});

app.get('/admin/system', requireAuth, requireAdmin, async (req, res) => {
  try {
    const metrics = getSystemMetrics();
    const health = getHealthIndicators(metrics);
    let history = [];
    try { history = await getDailyHistory(30); } catch { history = []; }
    let integrity = null;
    try {
      integrity = await getSystemIntegrityReport(pool);
    } catch (integrityErr) {
      console.error('[integrity] error generating report:', integrityErr);
      integrity = {
        overallStatus: 'healthy',
        recommendation: 'Diagnostics unavailable.',
        summary: { totalChecks: 0, totalIssues: 0, criticalCount: 0, warningCount: 0, healthyCount: 0, overallStatus: 'healthy' },
        checks: [],
        byCategory: {}
      };
    }
    res.render('admin-system', { user: req.user, metrics, health, history, integrity });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load system metrics.' });
  }
});

app.get('/admin/system/integrity', requireAuth, requireAdmin, (req, res) => {
  res.redirect('/admin/system#integrity');
});

app.get('/admin/integrity', requireAuth, requireAdmin, (req, res) => {
  res.redirect('/admin/system#integrity');
});

app.get('/api/admin/system/integrity', requireAuth, requireAdmin, async (req, res) => {
  try {
    const integrity = await getSystemIntegrityReport(pool);
    res.json(integrity);
  } catch (error) {
    console.error('[api/admin/system/integrity] error:', error);
    res.status(500).json({ error: 'Unable to generate integrity report.' });
  }
});

// Phase 5 Step 3 — Admin Assistant API (read-only, admin-only; see src/admin-assistant/).
registerAdminAssistantRoutes(app);

// Security Lab Step 2 — read-only tool catalog API (admin-only, no execution; see src/security-lab/).
registerSecurityLabRoutes(app);

// Phase 2 — nanobot sidecar token issuance (disabled unless NANOBOT_ENABLED=true; see src/nanobot/router.js).
registerNanobotRoutes(app);

// Standalone 3D Avatar Face Replacement route
registerAvatarFaceReplacementRoutes(app);

app.post('/admin/users/:id/approve', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const expiry = resolveExpiry(req.body);
    await approveUser(req.user.id, userId, expiry);
    res.redirect('/admin?msg=approved');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/users/:id/extend', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const raw = String(req.body.duration || '').trim();
    if (raw === 'custom') {
      await extendUserToDate(req.user.id, userId, resolveExpiry(req.body));
    } else {
      const days = Number.parseInt(raw, 10);
      if (!Number.isInteger(days) || days <= 0 || days > 3650) throw new Error('Invalid access duration.');
      await extendUserByDays(req.user.id, userId, days);
    }
    res.redirect('/admin?msg=extended');
  } catch (error) {
    adminError(res, error);
  }
});


app.post('/admin/users/:id/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const isLocalUserDeleteEnabled = process.env.LOCAL_USER_DELETE_ENABLED === 'true';
    if (!isLocalUserDeleteEnabled) {
      return adminError(res, new Error('User deletion is only available in local development.'));
    }

    const targetUserId = parseUserId(req.params.id);
    if (String(req.user.id) === String(targetUserId)) {
      return adminError(res, new Error('Cannot delete your own account.'));
    }

    const { deleteUserPermanently } = await import('./auth/userDeletion.js');
    await deleteUserPermanently(targetUserId, { actorUserId: req.user.id });
    
    res.redirect('/admin?msg=deleted');
  } catch (error) {
    adminError(res, error);
  }
});

// Inactive users admin UI – shows threshold, eligible count, dry-run preview
app.get('/admin/inactive-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getInactiveDeleteDays, getInactiveDeleteTime, isInactiveDeleteAutoEnabled } = await import('./config/inactiveDeletion.js');
    const { findInactiveUsersForDeletion, cutoffForDays } = await import('./cleanup/inactiveUsers.js');
    const { _inactiveInternal } = await import('./cleanup/scheduler.js');
    const thresholdDays = getInactiveDeleteDays();
    const timeCfg = getInactiveDeleteTime();
    const schedulerEnabled = isInactiveDeleteAutoEnabled();
    let nextRun = null;
    try {
      const delay = _inactiveInternal.getMsUntilNextDeleteTime(new Date(), timeCfg);
      const d = new Date(Date.now() + delay);
      nextRun = d.toLocaleString(undefined, { timeZone: 'Asia/Kolkata' }) + ' IST';
    } catch {}
    let cutoff = null;
    try { const c = cutoffForDays(thresholdDays); if (c) cutoff = c.toISOString().slice(0,10); } catch {}
    let eligibleUsers = [];
    let eligibleCount = 0;
    let dryRunResult = null;
    // honour ?dryRun=1 or ?preview=1 to show dry-run inline without POST
    const wantDryRun = String(req.query.dryRun || req.query.preview || '') === 'true' || String(req.query.dryRun) === '1';
    if (thresholdDays) {
      try {
        // count via dry-run service for accurate processed/skipped
        const { runInactiveUserCleanup } = await import('./cleanup/inactiveUsers.js');
        if (wantDryRun) {
          dryRunResult = await runInactiveUserCleanup({ batchSize: 100, dryRun: true });
          eligibleCount = dryRunResult.wouldDelete ?? dryRunResult.processed ?? 0;
        }
        // also fetch up to 100 eligible rows for table
        const list = await findInactiveUsersForDeletion(pool, thresholdDays, 100);
        eligibleUsers = list;
        if (!wantDryRun) eligibleCount = list.length;
        // if list capped at 100 but more exist, eligibleCount may be 100 – indicate via dryRunResult
        if (eligibleUsers.length === 100 && !wantDryRun) {
          // do lightweight count via run with dryRun if not already
          try {
            const cntRes = await runInactiveUserCleanup({ batchSize: 500, dryRun: true });
            eligibleCount = cntRes.wouldDelete ?? eligibleCount;
            dryRunResult = dryRunResult || cntRes;
          } catch {}
        }
      } catch (e) {
        console.warn('[admin-inactive] failed to fetch eligible', e.message);
      }
    }
    // allow flashing dry-run or last result via query
    const msg = typeof req.query.msg === 'string' ? req.query.msg : null;
    const error = typeof req.query.error === 'string' ? req.query.error : null;
    res.render('admin-inactive-users', {
      user: req.user,
      thresholdDays,
      scheduleTime: timeCfg.raw,
      schedulerEnabled,
      nextRun,
      cutoff,
      eligibleUsers,
      eligibleCount,
      dryRunResult,
      lastResult: null,
      msg,
      error
    });
  } catch (err) {
    res.status(500).render('error', { message: 'Unable to load inactive users.' });
  }
});

// Manual trigger for inactive user cleanup (Admin/Owner) – reuses same deletion service via batch
app.post('/admin/inactive-users/cleanup', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const isDryRun = String(req.body.dryRun || req.body.preview || req.query.dryRun || '') === 'true' || String(req.body.dryRun) === '1';
    const { runInactiveUserCleanup } = await import('./cleanup/inactiveUsers.js');
    const result = await runInactiveUserCleanup({ batchSize: 100, dryRun: isDryRun });
    if (result.skipped && result.reason === 'invalid_or_missing_days') {
      return res.redirect('/admin/inactive-users?error=' + encodeURIComponent('USER_INACTIVE_DELETE_DAYS not configured.'));
    }
    if (isDryRun) {
      // render page inline with dry-run result instead of redirecting to generic admin
      const { getInactiveDeleteDays, getInactiveDeleteTime, isInactiveDeleteAutoEnabled } = await import('./config/inactiveDeletion.js');
      const { findInactiveUsersForDeletion, cutoffForDays } = await import('./cleanup/inactiveUsers.js');
      const { _inactiveInternal } = await import('./cleanup/scheduler.js');
      const thresholdDays = getInactiveDeleteDays();
      const timeCfg = getInactiveDeleteTime();
      const schedulerEnabled = isInactiveDeleteAutoEnabled();
      let nextRun = null;
      try { const delay = _inactiveInternal.getMsUntilNextDeleteTime(new Date(), timeCfg); nextRun = new Date(Date.now()+delay).toLocaleString(undefined,{timeZone:'Asia/Kolkata'})+' IST'; } catch {}
      let cutoff = null;
      try { const c = cutoffForDays(thresholdDays); if (c) cutoff = c.toISOString().slice(0,10); } catch {}
      let eligibleUsers = [];
      try { eligibleUsers = await findInactiveUsersForDeletion(pool, thresholdDays, 100); } catch {}
      return res.render('admin-inactive-users', {
        user: req.user,
        thresholdDays,
        scheduleTime: timeCfg.raw,
        schedulerEnabled,
        nextRun,
        cutoff,
        eligibleUsers,
        eligibleCount: result.wouldDelete ?? result.processed ?? eligibleUsers.length,
        dryRunResult: result,
        lastResult: null,
        msg: `Dry-run: would delete ${result.wouldDelete ?? 0} of ${result.processed} processed (skipped ${result.skipped}, failed ${result.failed}).`,
        error: null
      });
    }
    const msg = `Inactive cleanup: ${result.processed} processed, ${result.deleted} deleted, ${result.skipped} skipped, ${result.failed} failed.`;
    // redirect back to dedicated page for visibility
    res.redirect('/admin/inactive-users?msg=' + encodeURIComponent(msg));
  } catch (error) {
    adminError(res, error);
  }
});
app.post('/api/admin/inactive-users/cleanup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const isDryRun = String(req.body?.dryRun || req.query.dryRun || '') === 'true' || String(req.body?.dryRun) === '1' || String(req.query.preview) === 'true';
    const { runInactiveUserCleanup } = await import('./cleanup/inactiveUsers.js');
    const result = await runInactiveUserCleanup({ batchSize: 100, dryRun: isDryRun });
    res.json({ status: 'success', ...result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/users/:id/revoke', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    await revokeUser(req.user.id, parseUserId(req.params.id));
    res.redirect('/admin?msg=revoked');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/users/:id/reactivate', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const expiry = resolveExpiry(req.body);
    await reactivateUser(req.user.id, userId, expiry);
    res.redirect('/admin?msg=reactivated');
  } catch (error) {
    adminError(res, error);
  }
});

// Helpers for bulk admin users
function parseBulkUserIds(body) {
  let raw = body.userIds ?? body.user_ids ?? body['userIds[]'] ?? body['user_ids[]'] ?? body.selected ?? body.ids ?? body.userId ?? body.user_id;
  if (raw === undefined || raw === null || raw === '') return [];
  let ids = [];
  if (Array.isArray(raw)) ids = [...raw];
  else if (typeof raw === 'string' && raw.includes(',')) ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  else ids = [raw];
  // Flatten one level if needed (form may send array of comma strings)
  const flat = [];
  for (const v of ids) {
    if (Array.isArray(v)) flat.push(...v);
    else if (typeof v === 'string' && v.includes(',')) flat.push(...v.split(',').map(s => s.trim()).filter(Boolean));
    else flat.push(v);
  }
  return flat.map(v => String(v).trim()).filter(Boolean);
}
function buildBulkMessage(action, result) {
  const parts = [];
  if (result.applied > 0) parts.push(`${result.applied} applied`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (parts.length === 0) return `${action}: no users changed.`;
  return `${action}: ${parts.join(', ')}.`;
}

app.post('/admin/users/bulk-activate', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userIds = parseBulkUserIds(req.body);
    if (userIds.length === 0) throw new Error('No users selected.');
    const expiryStr = req.body.expiry ?? req.body.bulkExpiry ?? req.body.accessUntil ?? req.body.access_until ?? req.body.date ?? req.body.newExpiry;
    if (!expiryStr) throw new Error('Expiry date is required.');
    const expiry = parseFutureExpiryDate(expiryStr);
    const result = await bulkActivateUsers(req.user.id, userIds, expiry);
    const dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
    const msg = `Activate until ${dateLabel}: ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, ...result, dateLabel });
    res.redirect(buildAdminUsersBulkRedirect(req, msg, null));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect(buildAdminUsersBulkRedirect(req, null, error.message || 'Request failed.'));
  }
});

app.post('/admin/users/bulk-extend', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userIds = parseBulkUserIds(req.body);
    if (userIds.length === 0) throw new Error('No users selected.');
    const expiryStr = req.body.expiry ?? req.body.bulkExpiry ?? req.body.accessUntil ?? req.body.access_until ?? req.body.date ?? req.body.newExpiry;
    if (!expiryStr) throw new Error('Expiry date is required.');
    const expiry = parseFutureExpiryDate(expiryStr);
    const result = await bulkExtendUsersSafe(req.user.id, userIds, expiry);
    const dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
    const msg = `Extend until ${dateLabel}: ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, ...result, dateLabel });
    res.redirect(buildAdminUsersBulkRedirect(req, msg, null));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect(buildAdminUsersBulkRedirect(req, null, error.message || 'Request failed.'));
  }
});

app.post('/admin/users/bulk-revoke', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userIds = parseBulkUserIds(req.body);
    if (userIds.length === 0) throw new Error('No users selected.');
    const result = await bulkRevokeUsers(req.user.id, userIds);
    const msg = `Revoke: ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, ...result });
    res.redirect(buildAdminUsersBulkRedirect(req, msg, null));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect(buildAdminUsersBulkRedirect(req, null, error.message || 'Request failed.'));
  }
});

app.post('/admin/users/bulk-premium', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userIds = parseBulkUserIds(req.body);
    if (userIds.length === 0) throw new Error('No users selected.');
    const result = await bulkGrantPremium(req.user.id, userIds);
    const msg = `Make Premium: ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, ...result });
    res.redirect(buildAdminUsersBulkRedirect(req, msg, null));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect(buildAdminUsersBulkRedirect(req, null, error.message || 'Request failed.'));
  }
});

// Generic bulk endpoint: POST /admin/users/bulk { action, userIds, expiry }
app.post('/admin/users/bulk', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const action = String(req.body.action || '').trim().toLowerCase().replace(/-/g, '_');
    if (!['activate', 'extend', 'revoke', 'premium', 'make_premium', 'grant_premium'].includes(action)) throw new Error('Invalid bulk action.');
    const userIds = parseBulkUserIds(req.body);
    if (userIds.length === 0) throw new Error('No users selected.');
    let result;
    let dateLabel = null;
    if (action === 'activate') {
      const expiryStr = req.body.expiry ?? req.body.bulkExpiry ?? req.body.accessUntil ?? req.body.date;
      if (!expiryStr) throw new Error('Expiry date is required.');
      const expiry = parseFutureExpiryDate(expiryStr);
      dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
      result = await bulkActivateUsers(req.user.id, userIds, expiry);
    } else if (action === 'extend') {
      const expiryStr = req.body.expiry ?? req.body.bulkExpiry ?? req.body.accessUntil ?? req.body.date;
      if (!expiryStr) throw new Error('Expiry date is required.');
      const expiry = parseFutureExpiryDate(expiryStr);
      dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
      result = await bulkExtendUsersSafe(req.user.id, userIds, expiry);
    } else if (action === 'premium' || action === 'make_premium' || action === 'grant_premium') {
      result = await bulkGrantPremium(req.user.id, userIds);
    } else {
      result = await bulkRevokeUsers(req.user.id, userIds);
    }
    const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    const prefix = dateLabel ? `${actionLabel} until ${dateLabel}:` : `${actionLabel}:`;
    const msg = `${prefix} ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed.`;
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.json({ ok: true, action, ...result, dateLabel });
    res.redirect(buildAdminUsersBulkRedirect(req, msg, null));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) return res.status(400).json({ error: error.message });
    res.redirect(buildAdminUsersBulkRedirect(req, null, error.message || 'Request failed.'));
  }
});

app.post('/admin/users/:id/make-admin', requireAuth, requireOwner, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    await grantAdmin(req.user.id, userId);
    res.redirect('/admin?msg=adminGranted');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/users/:id/remove-admin', requireAuth, requireOwner, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    await revokeAdmin(req.user.id, userId);
    res.redirect('/admin?msg=adminRevoked');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/users/:id/make-premium', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    await grantPremium(req.user.id, userId);
    res.redirect('/admin?msg=premiumGranted');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/users/:id/remove-premium', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    await revokePremium(req.user.id, userId);
    res.redirect('/admin?msg=premiumRevoked');
  } catch (error) {
    adminError(res, error);
  }
});

// === Admin: Expiring users (within next 7 days) ===
app.get('/admin/expiring-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const expiringUsers = await getExpiringUsers();
    const enriched = expiringUsers.map(u => {
      const diffMs = new Date(u.access_expires_at).getTime() - Date.now();
      const daysRemaining = diffMs > 0 ? Math.ceil(diffMs / (24*60*60*1000)) : 0;
      return { ...u, daysRemaining };
    });
    const flashMessages = { extended: 'Access extended.', bulkExtended: 'Bulk extension completed.' };
    const msg = req.query.msg ? (flashMessages[req.query.msg] || req.query.msg) : null;
    const error = typeof req.query.error === 'string' && req.query.error ? req.query.error : null;
    const expiringCount = enriched.length;
    res.render('admin-expiring-users', { user: req.user, users: enriched, expiringCount, msg, error });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load expiring users.' });
  }
});

app.post('/admin/expiring-users/bulk-extend', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    let userIds = req.body.userIds || req.body.user_ids || req.body.selected;
    if (!userIds) userIds = [];
    if (!Array.isArray(userIds)) userIds = [userIds];
    if (userIds.length === 1 && typeof userIds[0] === 'string' && userIds[0].includes(',')) {
      userIds = userIds[0].split(',').map(s => s.trim()).filter(Boolean);
    }
    const expiryStr = req.body.expiry || req.body.bulkExpiry || req.body.newExpiry || req.body.date;
    const expiry = parseFutureExpiryDate(expiryStr);
    await bulkExtendUsers(req.user.id, userIds, expiry);
    const count = [...new Set(userIds.map(v => String(v).trim()).filter(Boolean))].length;
    const dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
    res.redirect('/admin/expiring-users?msg=' + encodeURIComponent(`Access extended for ${count} users until ${dateLabel}.`));
  } catch (error) {
    res.redirect('/admin/expiring-users?error=' + encodeURIComponent(error.message || 'Bulk update failed.'));
  }
});

app.post('/admin/expiring-users/:id/extend', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const expiryStr = req.body.expiry || req.body.newExpiry || req.body.date;
    const expiry = parseFutureExpiryDate(expiryStr);
    await extendUserToDate(req.user.id, userId, expiry);
    const dateLabel = new Date(expiry).toLocaleDateString(undefined, { timeZone: 'Asia/Kolkata' });
    res.redirect('/admin/expiring-users?msg=' + encodeURIComponent(`Access extended until ${dateLabel}.`));
  } catch (error) {
    res.redirect('/admin/expiring-users?error=' + encodeURIComponent(error.message || 'Update failed.'));
  }
});

// === Admin: Recent Activity ===
app.get('/admin/recent-activity', requireAuth, requireAdmin, async (req, res) => {
  try {
    let expiringCount = null;
    try {
      const exp = await getExpiringUsers();
      expiringCount = exp.length;
    } catch {
      expiringCount = null;
    }

    const type = typeof req.query.type === 'string' && req.query.type ? req.query.type : 'all';
    const dateRange = typeof req.query.dateRange === 'string' && req.query.dateRange ? req.query.dateRange : 'all';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : null;
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 30;

    const data = await getRecentActivities({
      type,
      dateRange,
      startDate,
      endDate,
      search,
      page,
      limit
    });

    const msg = typeof req.query.msg === 'string' ? req.query.msg : null;
    const error = typeof req.query.error === 'string' ? req.query.error : null;

    res.render('admin-recent-activity', {
      user: req.user,
      expiringCount,
      events: data.events,
      total: data.total,
      page: data.page,
      totalPages: data.totalPages,
      limit: data.limit,
      categoryCounts: data.categoryCounts,
      filters: data.filters,
      msg,
      error
    });
  } catch (error) {
    console.error('Error loading recent activity:', error);
    res.status(500).render('error', { message: 'Unable to load recent activity.' });
  }
});

// === Owner: Content Action Permissions ===
app.post('/admin/content-permissions/grant', requireAuth, requireOwner, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.body.user_id);
    const permission = String(req.body.permission || '').trim();
    await grantContentPermission(userId, permission, req.user.id);
    res.redirect('/admin?msg=contentGranted');
  } catch (error) {
    adminError(res, error);
  }
});

app.post('/admin/content-permissions/revoke', requireAuth, requireOwner, requireSameOrigin, async (req, res) => {
  try {
    const userId = parseUserId(req.body.user_id);
    const permission = String(req.body.permission || '').trim();
    await revokeContentPermission(userId, permission, req.user.id);
    res.redirect('/admin?msg=contentRevoked');
  } catch (error) {
    adminError(res, error);
  }
});

// Bulk update for Content Permissions — OWNER only, transactional, parameterized SQL
app.post('/admin/content-permissions/bulk', requireAuth, requireOwner, requireSameOrigin, async (req, res) => {
  try {
    // Parse bulk updates from various payload shapes (JSON array, form per-user fields, etc.)
    let updates = [];
    const body = req.body || {};

    // Helper to coerce granted values
    const toGranted = (v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (v == null) return null;
      const s = String(v).trim().toLowerCase();
      if (['true','1','on','grant','granted','allowed'].includes(s)) return true;
      if (['false','0','off','revoke','denied','deny'].includes(s)) return false;
      return null;
    };

    if (body.updates !== undefined) {
      let raw = body.updates;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { throw new Error('Invalid updates payload.'); }
      }
      if (!Array.isArray(raw)) throw new Error('Invalid updates payload.');
      updates = raw;
    } else if (body.permissions !== undefined) {
      // permissions as array or JSON string
      let raw = body.permissions;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { throw new Error('Invalid permissions payload.'); }
      }
      if (Array.isArray(raw)) updates = raw;
      else throw new Error('Invalid permissions payload.');
    } else {
      // Form fallback: user_ids + per-user copy/download checkboxes
      let rawIds = body.user_ids ?? body.userIds ?? body.selected ?? body['user_ids[]'];
      if (rawIds === undefined || rawIds === null || rawIds === '') {
        throw new Error('No users selected.');
      }
      let ids = Array.isArray(rawIds) ? [...rawIds] : [rawIds];
      // Handle comma-separated single string
      if (ids.length === 1 && typeof ids[0] === 'string' && ids[0].includes(',')) {
        ids = ids[0].split(',').map(s => s.trim()).filter(Boolean);
      }
      // Flatten one level if needed
      const flat = [];
      for (const v of ids) { if (Array.isArray(v)) flat.push(...v); else flat.push(v); }
      ids = flat.filter(v => String(v).trim() !== '');
      if (ids.length === 0) throw new Error('No users selected.');

      // Check for explicit global or per-user permission states
      // First, look for per-user checkbox fields like copy_5, download_5
      // If those exist, we will use them; otherwise try global selectors
      const hasPerUserFields = ids.some(id => (`copy_${id}` in body) || (`download_${id}` in body) || (`copy_query_${id}` in body) || (`download_pdf_${id}` in body));
      const globalCopy = body.copy_query ?? body.copyQuery ?? body.copy_action ?? body.copy;
      const globalDownload = body.download_pdf ?? body.downloadPdf ?? body.download_action ?? body.download;
      const globalCopyGranted = toGranted(globalCopy);
      const globalDownloadGranted = toGranted(globalDownload);

      for (const rawId of ids) {
        const uid = String(rawId).trim();
        if (!uid) continue;
        let copyVal;
        let dlVal;
        const copyKeys = [`copy_${uid}`, `copy_query_${uid}`, `COPY_QUERY_${uid}`];
        const dlKeys = [`download_${uid}`, `download_pdf_${uid}`, `DOWNLOAD_PDF_${uid}`];
        for (const k of copyKeys) if (k in body) { copyVal = body[k]; break; }
        for (const k of dlKeys) if (k in body) { dlVal = body[k]; break; }

        // If per-user fields present, use their checked state (missing = false for form checkboxes)
        // If no per-user fields but global state provided, apply global to all
        if (copyVal === undefined && dlVal === undefined && (globalCopyGranted !== null || globalDownloadGranted !== null)) {
          if (globalCopyGranted !== null) copyVal = globalCopyGranted;
          if (globalDownloadGranted !== null) dlVal = globalDownloadGranted;
        }

        // Determine which permissions to include:
        // If hasPerUserFields => include both perms for each selected user (unchecked = false)
        // Else if global provided => include only those globals that were specified
        // Else fallback: if we have no hint, treat missing per-user as false and include both
        if (hasPerUserFields || (copyVal === undefined && dlVal === undefined)) {
          // Include both permissions; missing checkbox = DENIED (false)
          const cg = toGranted(copyVal);
          const dg = toGranted(dlVal);
          updates.push({ user_id: uid, permission: 'COPY_QUERY', granted: cg !== null ? cg : false });
          updates.push({ user_id: uid, permission: 'DOWNLOAD_PDF', granted: dg !== null ? dg : false });
        } else {
          if (copyVal !== undefined) {
            const cg = toGranted(copyVal);
            if (cg !== null) updates.push({ user_id: uid, permission: 'COPY_QUERY', granted: cg });
          } else if (globalCopyGranted !== null) {
            updates.push({ user_id: uid, permission: 'COPY_QUERY', granted: globalCopyGranted });
          }
          if (dlVal !== undefined) {
            const dg = toGranted(dlVal);
            if (dg !== null) updates.push({ user_id: uid, permission: 'DOWNLOAD_PDF', granted: dg });
          } else if (globalDownloadGranted !== null) {
            updates.push({ user_id: uid, permission: 'DOWNLOAD_PDF', granted: globalDownloadGranted });
          }
        }
      }
    }

    if (updates.length === 0) throw new Error('No users selected.');
    const result = await bulkUpdateContentPermissions(updates, req.user.id);
    const count = result.updatedUserCount;

    // Support both JSON (fetch) and form redirect callers
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) {
      return res.json({ ok: true, updatedUserCount: count, totalUpdates: result.totalUpdates });
    }
    // Include success message with count — visible after redirect on admin page
    const msgText = `Content permissions updated for ${count} user${count !== 1 ? 's' : ''}.`;
    res.redirect('/admin?msg=' + encodeURIComponent(msgText));
  } catch (error) {
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('json');
    if (wantsJson) {
      return res.status(400).json({ error: error.message || 'Bulk update failed.' });
    }
    adminError(res, error);
  }
});

// JSON API for content permissions (Owner only) — for testing / programmatic access
app.get('/api/content-permissions/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const perms = await getUserContentPermissions(userId);
    res.json({ userId, permissions: [...perms] });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed.' });
  }
});

// === Q&A / DISCUSSIONS ===

// List discussions for a library item
app.get('/discussions', requireAuth, async (req, res) => {
  try {
    const itemPath = String(req.query.path || '').trim();
    if (!itemPath || !isSafeLibraryPath(itemPath)) return res.status(400).render('error', { message: 'Invalid item path.' });
    if (!canAccessLibraryPath(req.user, itemPath)) return res.status(404).render('error', { message: 'Item not found.' });

    const filter = isValidFilter(req.query.filter) ? req.query.filter : 'newest';
    const discussions = await listDiscussions(itemPath, filter, req.user.id);

    res.render('discussions', {
      user: { ...req.user, isAdmin: isAdminUser(req.user) },
      itemPath,
      discussions,
      currentFilter: filter,
      displayName,
      contentRouteForPath,
      msg: req.query.msg || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load discussions.' });
  }
});

// Create a new discussion
app.post('/discussions', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    // Expired users disabled – reuse Notes permission (covers Liked Items/Notes)
    try {
      const canDiscuss = await hasNotesPermission(req.user);
      if (!canDiscuss) {
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) return res.status(403).json({ status: 'error', message: 'Notes permission required.' });
        return res.status(403).render('error', { message: 'You do not have permission to create discussions.' });
      }
    } catch {}
    const itemPath = String(req.body.item_path || '').trim();
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!itemPath || !isSafeLibraryPath(itemPath)) return res.redirect('/login');
    if (!canAccessLibraryPath(req.user, itemPath)) return res.redirect('/login');
    if (!title || title.length > 200) return res.redirect('/discussions?path=' + encodeURIComponent(itemPath) + '&error=' + encodeURIComponent('Invalid title.'));
    if (body.length > 50000) return res.redirect('/discussions?path=' + encodeURIComponent(itemPath) + '&error=' + encodeURIComponent('Question too long.'));

    const isAdmin = isAdminUser(req.user);
    const initialStatus = isAdmin ? 'approved' : 'pending';
    const newDiscussion = await createDiscussion(req.user.id, itemPath, title, body, initialStatus);
    
    const msg = isAdmin ? 'Question posted.' : 'Question posted and is pending approval.';
    
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ 
        success: true, 
        message: msg,
        discussion: {
          id: newDiscussion.id,
          title: newDiscussion.title,
          reply_count: 0
        }
      });
    }

    res.redirect('/discussions?path=' + encodeURIComponent(itemPath) + '&msg=' + encodeURIComponent(msg));
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// View a single discussion thread
app.get('/discussions/:id', requireAuth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).render('error', { message: 'Invalid discussion.' });

    const isAdmin = isAdminUser(req.user);
    const discussion = await getDiscussionWithReplies(id, isAdmin, req.user.id);
    if (!discussion) return res.status(404).render('error', { message: 'Discussion not found.' });
    
    // Allow admin to see hidden/deleted; normal users only see visible or approved, or their own pending question
    if (!isAdmin && discussion.status !== 'visible' && discussion.status !== 'approved') {
      if (discussion.status === 'pending' && discussion.user_id === req.user.id) {
        // Author can see their own pending question
      } else {
        return res.status(404).render('error', { message: 'Discussion not found.' });
      }
    }
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(404).render('error', { message: 'Discussion not found.' });

    res.render('discussion', {
      user: { ...req.user, isAdmin },
      discussion,
      replies: discussion.replies,
      displayName,
      contentRouteForPath,
      linkifyBody,
      msg: req.query.msg || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load discussion.' });
  }
});

// Post a reply
app.post('/discussions/:id/reply', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    try {
      const canReply = await hasNotesPermission(req.user);
      if (!canReply) return res.status(403).render('error', { message: 'You do not have permission to post replies.' });
    } catch {}
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect('/login');

    const discussion = await getDiscussion(id);
    if (!discussion) return res.redirect('/login');
    
    const isAuthor = discussion.user_id === req.user.id;
    const isAdmin = isAdminUser(req.user);
    
    // Allow reply if discussion is approved/visible, or if it's pending and user is author or admin
    if (discussion.status !== 'visible' && discussion.status !== 'approved' && !(discussion.status === 'pending' && (isAuthor || isAdmin))) {
      return res.redirect('/login');
    }
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.redirect('/login');

    const body = String(req.body.body || '').trim();
    if (!body || body.length > 50000) {
      return res.redirect('/discussions/' + id + '?error=' + encodeURIComponent('Reply too long.'));
    }

    const initialReplyStatus = isAdmin ? 'approved' : 'pending';
    const parentIdVal = req.body.parent_id ? Number.parseInt(req.body.parent_id, 10) : null;
    const parentId = Number.isFinite(parentIdVal) && parentIdVal > 0 ? parentIdVal : null;

    await pool.query(
      `INSERT INTO discussion_replies (discussion_id, user_id, body, status, parent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [id, req.user.id, body, initialReplyStatus, parentId]
    );

    const msg = isAdmin ? 'Reply posted.' : 'Reply posted and is pending approval.';
    res.redirect('/discussions/' + id + '?msg=' + encodeURIComponent(msg));
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// Like/unlike a discussion
app.post('/discussions/:id/like', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    try {
      const canLike = await hasNotesPermission(req.user);
      if (!canLike) return res.status(403).render('error', { message: 'You do not have permission to like discussions.' });
    } catch {}
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect('/login');

    const discussion = await getDiscussion(id);
    if (!discussion) return res.redirect('/login');
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });

    await toggleDiscussionLike(req.user.id, id);
    res.redirect('/discussions/' + id);
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// Like/unlike a reply
app.post('/discussions/replies/:id/like', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    try {
      const canLike = await hasNotesPermission(req.user);
      if (!canLike) return res.status(403).render('error', { message: 'You do not have permission to like replies.' });
    } catch {}
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect('/login');

    const result = await pool.query(
      `SELECT r.id, r.discussion_id, d.item_path
       FROM discussion_replies r JOIN discussions d ON r.discussion_id = d.id
       WHERE r.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.redirect('/login');

    const reply = result.rows[0];
    if (!canAccessLibraryPath(req.user, reply.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });

    await toggleReplyLike(req.user.id, id);
    res.redirect('/discussions/' + reply.discussion_id);
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// Delete a discussion (owner only) – read-only for expired (hasNotesPermission required unless admin)
app.post('/discussions/:id/delete', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) {
      try { const can = await hasNotesPermission(req.user); if (!can) return res.status(403).render('error', { message: 'You do not have permission to delete discussions.' }); } catch {}
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect('/login');

    const discussion = await getDiscussion(id);
    if (!discussion) return res.redirect('/login');

    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });

    const itemPath = discussion.item_path;

    if (req.user.id === discussion.user_id) {
      await deleteDiscussionAsUser(id, req.user.id);
    } else if (isAdminUser(req.user)) {
      await adminDeleteDiscussion(id, req.user.id);
    } else {
      return res.status(403).render('error', { message: 'Not authorized.' });
    }

    const itemEnc = itemPath.split('/').map(encodeURIComponent).join('/');
    res.redirect(contentRouteForPath(itemPath) + itemPath.split('/').map(encodeURIComponent).join('/') + '?msg=' + encodeURIComponent('Deleted.'));
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// Delete a reply (owner only) – read-only for expired
app.post('/discussions/replies/:id/delete', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) {
      try { const can = await hasNotesPermission(req.user); if (!can) return res.status(403).render('error', { message: 'You do not have permission to delete replies.' }); } catch {}
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect('/login');

    const result = await pool.query(
      `SELECT r.id, r.user_id, r.discussion_id, d.item_path
       FROM discussion_replies r JOIN discussions d ON r.discussion_id = d.id
       WHERE r.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.redirect('/login');

    const reply = result.rows[0];
    if (!canAccessLibraryPath(req.user, reply.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });

    if (req.user.id === reply.user_id) {
      await deleteReplyAsUser(id, req.user.id);
    } else if (isAdminUser(req.user)) {
      await adminDeleteReply(id, req.user.id);
    } else {
      return res.status(403).render('error', { message: 'Not authorized.' });
    }

    const discIdEnc = reply.discussion_id;
    res.redirect('/discussions/' + discIdEnc + '?msg=' + encodeURIComponent('Reply deleted.'));
  } catch (error) {
    console.error(error);
    res.redirect('/login');
  }
});

// Accepted Answer — admin only
app.post('/discussions/:id/accept/:replyId', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const discussionId = Number.parseInt(req.params.id, 10);
    const replyId = Number.parseInt(req.params.replyId, 10);
    if (!Number.isFinite(discussionId) || !Number.isFinite(replyId)) return res.redirect('/login');
    const discussion = await getDiscussion(discussionId);
    if (!discussion) return res.redirect('/login');
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });
    const isAdmin = isAdminUser(req.user);
    if (!isAdmin) return res.status(403).render('error', { message: 'Not authorized to accept answer.' });
    await acceptReply(discussionId, replyId);
    res.redirect('/discussions/' + discussionId + '?msg=' + encodeURIComponent('Answer accepted.'));
  } catch (error) {
    console.error(error);
    const did = req.params.id;
    res.redirect('/discussions/' + did + '?error=' + encodeURIComponent(error.message || 'Failed to accept.'));
  }
});

app.post('/discussions/:id/unaccept', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const discussionId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(discussionId)) return res.redirect('/login');
    const discussion = await getDiscussion(discussionId);
    if (!discussion) return res.redirect('/login');
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });
    const isAdmin = isAdminUser(req.user);
    if (!isAdmin) return res.status(403).render('error', { message: 'Not authorized to unaccept answer.' });
    await unacceptReply(discussionId);
    res.redirect('/discussions/' + discussionId + '?msg=' + encodeURIComponent('Accepted answer removed.'));
  } catch (error) {
    console.error(error);
    const did = req.params.id;
    res.redirect('/discussions/' + did + '?error=' + encodeURIComponent(error.message || 'Failed.'));
  }
});

app.post('/discussions/:id/unaccept/:replyId', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const discussionId = Number.parseInt(req.params.id, 10);
    const replyId = Number.parseInt(req.params.replyId, 10);
    if (!Number.isFinite(discussionId) || !Number.isFinite(replyId)) return res.redirect('/login');
    const discussion = await getDiscussion(discussionId);
    if (!discussion) return res.redirect('/login');
    if (!canAccessLibraryPath(req.user, discussion.item_path)) return res.status(403).render('error', { message: 'Not authorized.' });
    const isAdmin = isAdminUser(req.user);
    if (!isAdmin) return res.status(403).render('error', { message: 'Not authorized to unaccept answer.' });
    await unacceptReply(discussionId, replyId);
    res.redirect('/discussions/' + discussionId + '?msg=' + encodeURIComponent('Accepted answer removed.'));
  } catch (error) {
    console.error(error);
    const did = req.params.id;
    res.redirect('/discussions/' + did + '?error=' + encodeURIComponent(error.message || 'Failed.'));
  }
});

// === ADMIN: Discussions management ===

app.get('/admin/discussions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const filter = isValidAdminFilter(req.query.filter) ? req.query.filter : 'all';
    const searchTerm = String(req.query.search || req.query.q || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const pageSize = 25;
    const offset = (page - 1) * pageSize;

    let discussions, counts, totalCount, needsAttention;
    if (perfDiagnosticsEnabled) {
      req._perfTimings = req._perfTimings || {};
      let tList = Date.now(), tCounts = Date.now(), tTotal = Date.now(), tNeeds = Date.now();
      const pList = listAllDiscussionsForAdmin(filter, searchTerm, pageSize, offset).then(v => { req._perfTimings.listAllDiscussionsForAdmin = Date.now() - tList; return v; });
      const pCounts = getDiscussionCounts().then(v => { req._perfTimings.getDiscussionCounts = Date.now() - tCounts; return v; });
      const pTotal = listAllDiscussionsForAdminCount(filter, searchTerm).then(v => { req._perfTimings.listAllDiscussionsForAdminCount = Date.now() - tTotal; return v; });
      const pNeeds = getNeedsAttention().catch(() => ({ counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_replies_count: 0, recent_questions_count: 0 }, recentActive: [], unansweredList: [] })).then(v => { req._perfTimings.getNeedsAttention = Date.now() - tNeeds; return v; });
      [discussions, counts, totalCount, needsAttention] = await Promise.all([pList, pCounts, pTotal, pNeeds]);
    } else {
      [discussions, counts, totalCount, needsAttention] = await Promise.all([
        listAllDiscussionsForAdmin(filter, searchTerm, pageSize, offset),
        getDiscussionCounts(),
        listAllDiscussionsForAdminCount(filter, searchTerm),
        getNeedsAttention().catch(() => ({ counts: { unanswered_count: 0, hidden_questions_count: 0, hidden_replies_count: 0, recent_replies_count: 0, recent_questions_count: 0 }, recentActive: [], unansweredList: [] }))
      ]);
    }

    const discussionIds = discussions.map(d => d.id);
    const repliesByDiscussion = {};
    if (discussionIds.length > 0) {
      if (perfDiagnosticsEnabled) {
        const tReplies = Date.now();
        const batchMap = await adminListDiscussionRepliesBatch(discussionIds);
        req._perfTimings.adminListDiscussionRepliesBatch = Date.now() - tReplies;
        for (const id of discussionIds) {
          repliesByDiscussion[id] = batchMap.get(Number(id)) || [];
        }
      } else {
        const batchMap = await adminListDiscussionRepliesBatch(discussionIds);
        for (const id of discussionIds) {
          repliesByDiscussion[id] = batchMap.get(Number(id)) || [];
        }
      }
    }

    // Fetch latest moderation actions for audit display (Deleted by / Hidden by / Restored by)
    let questionModeration = new Map();
    let replyModeration = new Map();
    try {
      if (perfDiagnosticsEnabled) {
        let tQ = Date.now();
        questionModeration = await getLatestModerationForTargets('question', discussionIds);
        req._perfTimings.getLatestModerationForTargetsQuestion = Date.now() - tQ;
        const allReplyIds = Object.values(repliesByDiscussion).flat().map(r => Number(r.id)).filter(Boolean);
        let tR = Date.now();
        replyModeration = await getLatestModerationForTargets('reply', allReplyIds);
        req._perfTimings.getLatestModerationForTargetsReply = Date.now() - tR;
      } else {
        questionModeration = await getLatestModerationForTargets('question', discussionIds);
        const allReplyIds = Object.values(repliesByDiscussion).flat().map(r => Number(r.id)).filter(Boolean);
        replyModeration = await getLatestModerationForTargets('reply', allReplyIds);
      }
    } catch (e) {
      // audit table may not exist yet in some test envs — degrade gracefully
      questionModeration = new Map();
      replyModeration = new Map();
    }

    const totalPages = Math.ceil(totalCount / pageSize);
    const flashMessages = { hidden: 'Discussion hidden.', unhidden: 'Discussion visible.', deleted: 'Discussion deleted.', restored: 'Discussion restored.', replyHidden: 'Reply hidden.', replyUnhidden: 'Reply visible.', replyDeleted: 'Reply deleted.', replyRestored: 'Reply restored.' };
    const msg = flashMessages[req.query.msg] || null;
    const error = typeof req.query.error === 'string' && req.query.error ? req.query.error : null;

    if (perfDiagnosticsEnabled) {
      const tRender = Date.now();
      res.render('admin-discussions', { 
        user: req.user, 
        discussions, 
        counts, 
        repliesByDiscussion, 
        questionModeration,
        replyModeration,
        needsAttention,
        filter,
        searchTerm,
        page,
        pageSize,
        totalCount,
        totalPages,
        msg, 
        error,
        contentRouteForPath
      });
      req._perfTimings.render = Date.now() - tRender;
      perfLog(req, '/admin/discussions', {});
    } else {
      res.render('admin-discussions', { 
        user: req.user, 
        discussions, 
        counts, 
        repliesByDiscussion, 
        questionModeration,
        replyModeration,
        needsAttention,
        filter,
        searchTerm,
        page,
        pageSize,
        totalCount,
        totalPages,
        msg, 
        error,
        contentRouteForPath
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Unable to load discussions management.' });
  }
});

app.post('/admin/discussions/:id/approve', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid discussion ID.');
    await adminApproveDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      return res.redirect(buildThreadRedirect(id, 'approved'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'approved'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      const did = Number.parseInt(req.params.id, 10);
      if (Number.isFinite(did) && did > 0) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/replies/:id/approve', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid reply ID.');
    await adminApproveReply(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [id]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, 'replyApproved'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'replyApproved'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [Number.parseInt(req.params.id, 10)]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/:id/hide', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid discussion ID.');
    await adminHideDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      return res.redirect(buildThreadRedirect(id, 'hidden'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'hidden'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      const did = Number.parseInt(req.params.id, 10);
      if (Number.isFinite(did) && did > 0) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/:id/unhide', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid discussion ID.');
    await adminUnhideDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      return res.redirect(buildThreadRedirect(id, 'unhidden'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'unhidden'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      const did = Number.parseInt(req.params.id, 10);
      if (Number.isFinite(did) && did > 0) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/:id/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid discussion ID.');
    const discussion = await getDiscussion(id);
    await adminDeleteDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      if (discussion && discussion.item_path) {
         return res.redirect(contentRouteForPath(discussion.item_path) + discussion.item_path.split('/').map(encodeURIComponent).join('/') + '?msg=' + encodeURIComponent('Deleted.'));
      }
      return res.redirect(buildThreadRedirect(id, 'deleted'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'deleted'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      const did = Number.parseInt(req.params.id, 10);
      if (Number.isFinite(did) && did > 0) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/replies/:id/hide', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid reply ID.');
    await adminHideReply(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [id]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, 'replyHidden'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'replyHidden'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [Number.parseInt(req.params.id, 10)]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/replies/:id/unhide', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid reply ID.');
    await adminUnhideReply(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [id]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, 'replyUnhidden'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'replyUnhidden'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [Number.parseInt(req.params.id, 10)]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/replies/:id/delete', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid reply ID.');
    await adminDeleteReply(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [id]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, 'replyDeleted'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'replyDeleted'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [Number.parseInt(req.params.id, 10)]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/:id/restore', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid discussion ID.');
    await adminRestoreDiscussion(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      return res.redirect(buildThreadRedirect(id, 'restored'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'restored'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      const did = Number.parseInt(req.params.id, 10);
      if (Number.isFinite(did) && did > 0) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

app.post('/admin/discussions/replies/:id/restore', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid reply ID.');
    await adminRestoreReply(id, req.user.id);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [id]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, 'replyRestored'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, 'replyRestored'));
  } catch (error) {
    console.error(error);
    if (String(req.body?.returnTo).trim() === 'thread') {
      try {
        const r = await pool.query('SELECT discussion_id FROM discussion_replies WHERE id = $1', [Number.parseInt(req.params.id, 10)]);
        const did = r.rows[0]?.discussion_id;
        if (did) return res.redirect(buildThreadRedirect(did, null, error.message || 'Failed.'));
      } catch {}
    }
    res.redirect(buildAdminDiscussionsRedirect(req, null, error.message || 'Failed.'));
  }
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
// Lightweight periodic persistence of daily aggregates (no per-request writes).
if (process.env.NODE_ENV !== 'test') {
  scheduleDailyFlush(5 * 60 * 1000);
}
// Retention cleanup — reuses same setInterval pattern, no heavy queue.
// Respects RETENTION_ENABLED / RETENTION_DRY_RUN / per-table *_RETENTION_DAYS env vars.
// Interval 24h; skipped in test env and when RETENTION_ENABLED != true.
if (process.env.NODE_ENV !== 'test') {
  const retentionIntervalMs = Number.parseInt(process.env.RETENTION_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
  const safeInterval = Number.isFinite(retentionIntervalMs) && retentionIntervalMs > 0 ? retentionIntervalMs : 24 * 60 * 60 * 1000;
  scheduleRetentionCleanup(safeInterval);
}
// Premium reconciliation — daily at 3:00 AM IST, uses existing reconcileAllPremiumRoles (no duplicate logic)
if (process.env.NODE_ENV !== 'test') {
  schedulePremiumReconcile();
}
// Generic Paid Products reconciliation — daily at 3:00 AM IST, uses existing reconcileAllPaidProducts (Thought #4 Phase 2D)
if (process.env.NODE_ENV !== 'test') {
  schedulePaidProductsReconcile();
}
// Inactive user deletion — daily batch, reuses same deletion service (USER_INACTIVE_DELETE_DAYS)
if (process.env.NODE_ENV !== 'test') {
  const inactiveMs = Number.parseInt(process.env.INACTIVE_DELETE_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
  const safeInactive = Number.isFinite(inactiveMs) && inactiveMs > 0 ? inactiveMs : 24 * 60 * 60 * 1000;
  scheduleInactiveUserCleanup(safeInactive);
}
// Allow tests to import the app and bind an ephemeral port without the
// production listener stealing the default port.
if (process.env.NODE_ENV !== 'test') {
  pool.query(`ALTER TABLE paid_products ADD COLUMN IF NOT EXISTS max_active_members INTEGER DEFAULT NULL`)
    .catch(err => console.warn('Column max_active_members backfill warning:', err.message));
  app.listen(port, () => console.log(`Learn with me listening on http://localhost:${port}`));
}

// Video Progress API
app.get('/api/video-progress', requireAuth, async (req, res) => {
  try {
    const videoPath = String(req.query.path || '').trim();
    if (!videoPath) return res.status(400).json({ error: 'Missing path' });
    
    const result = await pool.query(
      'SELECT progress_seconds FROM video_progress WHERE user_id = $1 AND video_path = $2',
      [req.user.id, videoPath]
    );
    
    if (result.rows.length > 0) {
      res.json({ progress: parseFloat(result.rows[0].progress_seconds) });
    } else {
      res.json({ progress: 0 });
    }
  } catch (error) {
    console.error('Error fetching video progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/video-progress', requireAuth, express.json(), async (req, res) => {
  try {
    const videoPath = String(req.body.path || '').trim();
    const progress = parseFloat(req.body.progress);
    
    if (!videoPath || isNaN(progress)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    
    await pool.query(
      `INSERT INTO video_progress (user_id, video_path, progress_seconds, updated_at) 
       VALUES ($1, $2, $3, NOW()) 
       ON CONFLICT (user_id, video_path) 
       DO UPDATE SET progress_seconds = EXCLUDED.progress_seconds, updated_at = NOW()`,
      [req.user.id, videoPath, progress]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving video progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-video branding configuration — Admin/Owner only. Persists ONLY the
// branding { style, opacity } for the video into the file-backed store
// (src/config/video-branding.json); viewer-specific watermark data stays
// runtime-generated and is never stored. No database involvement.
app.post('/api/admin/video-branding', requireApiAuth, requireAdmin, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const itemPath = String(body.itemPath || '').trim();
    if (!itemPath) {
      return res.status(400).json({ error: 'Invalid item path.' });
    }
    let branding;
    try {
      branding = setVideoBranding(itemPath, body.style, body.opacity, body.color, body.enabled === undefined ? true : body.enabled);
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid branding configuration.' });
    }
    return res.json({ ok: true, itemPath, branding });
  } catch {
    return res.status(500).json({ error: 'Unable to save branding configuration.' });
  }
});

// Video Recording Protection signal endpoint — authenticated users only.
// Browser signals (visibility, focus, fullscreen, ...) drive client-side
// protection behavior only and are NOT persisted per event; the lightweight
// session mapping is maintained by page-view touches. The request contract
// (auth + payload validation) is preserved for existing clients.
app.post('/api/video-protection-event', requireApiAuth, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.itemPath !== 'string' || !body.itemPath.trim()) {
      return res.status(400).json({ error: 'Invalid item path.' });
    }
    if (!PROTECTION_EVENT_TYPES.has(body.eventType)) {
      return res.status(400).json({ error: 'Invalid event type.' });
    }
    return res.json({ ok: true, logged: false });
  } catch {
    return res.status(500).json({ error: 'Unable to record event.' });
  }
});

// Standalone Image Effects & Editor — page for Admins/Owners.
app.get('/admin/image-editor', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-image-editor', {
    user: req.user
  });
});

app.post('/api/admin/image-editor/export', requireApiAuth, requireAdmin, async (req, res) => {
  try {
    const { spec, format } = req.body || {};
    const buf = await renderImageEffectsToBuffer(null, spec, format || 'png');
    res.type(format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png');
    return res.send(buf);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Unable to render image effects.' });
  }
});

// Local-only Admin/Owner video editor — page. The editor works on an
// admin-selected LOCAL file (browser file picker), never on library paths, so
// library originals are untouched and External/YouTube items are not editable.
// Renders for admins even in production, but the UI shows a disabled notice
// there (see editorAvailable). Normal users are rejected by requireAdmin.
app.get('/admin/video-editor', requireAuth, requireAdmin, async (req, res) => {
  // Optional exact-match preselect (?path=<library rel path>) from the
  // "Edit Video" link on a local video page. Validated strictly: safe path,
  // not an external resource, accessible to this admin, and an exact video
  // leaf in the current tree (no fuzzy filename matching). Anything else
  // falls back to standalone mode (preselectedPath null).
  let preselectedPath = null;
  const requestedPath = String(req.query.path || '').trim();
  if (requestedPath && isSafeLibraryPath(requestedPath) && !isExternalFileName(path.basename(requestedPath))) {
    try {
      if (canAccessLibraryPath(req.user, requestedPath)) {
        const tree = await getLibrary();
        if (findVideo(tree, requestedPath)) preselectedPath = requestedPath;
      }
    } catch {}
  }
  res.render('admin-video-editor', {
    user: req.user,
    editorAvailable: isVideoEditorAvailable(),
    editorMaxVideoMb: editorMaxVideoMb(),
    preselectedPath,
    aiVideoEnabled: isAiVideoEnabled()
  });
});

// Local ffprobe resolver for the multi-track editor: filter graphs have no
// "optional stream" operator, so companion-audio presence per video file is
// detected up front. Ships with every system FFmpeg install (same local-only
// premise as ffmpeg itself); absence degrades to assume-audio downstream.
function findLocalFfprobe() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    try {
      const cand = path.join(
        path.dirname(process.env.FFMPEG_PATH),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      );
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return 'ffprobe';
}

// Probe one temp media file. Resolves {hasAudio, duration, width, height} or
// null when ffprobe is unavailable/unparseable (caller falls back safely).
function probeMediaFile(absPath) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child = null;
    try {
      child = spawn(findLocalFfprobe(), [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,width,height',
        '-show_entries', 'format=duration',
        '-of', 'json',
        absPath
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      done(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(null);
    }, 30000);
    try {
      child.stdout.on('data', chunk => {
        out += chunk.toString('utf8');
        if (out.length > 65536) out = out.slice(-65536);
      });
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const vStream = streams.find(s => s && s.codec_type === 'video') || null;
        const dur = parsed.format ? Number(parsed.format.duration) : NaN;
        done({
          hasAudio: streams.some(s => s && s.codec_type === 'audio'),
          duration: Number.isFinite(dur) ? dur : null,
          width: vStream && typeof vStream.width === 'number' && Number.isFinite(vStream.width) ? Math.round(vStream.width) : null,
          height: vStream && typeof vStream.height === 'number' && Number.isFinite(vStream.height) ? Math.round(vStream.height) : null
        });
      } catch {
        done(null);
      }
    });
  });
}

// Resolve a .ttf font for drawtext (local editor only). Explicit
// VIDEO_EDITOR_FONT wins; otherwise probe common OS locations. Returns the
// path or null. Needed because drawtext without a usable font crashes ffmpeg
// on machines without a working fontconfig (verified on Windows).
function findLocalEditorFont() {  const candidates = [];
  if (process.env.VIDEO_EDITOR_FONT) candidates.push(process.env.VIDEO_EDITOR_FONT);
  if (process.platform === 'win32') {
    candidates.push('C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/verdana.ttf');
  } else if (process.platform === 'darwin') {
    candidates.push('/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc');
  } else {
    candidates.push(
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans.ttf'
    );
  }
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

const exportProgress = new Map();
const activeExports = new Map();

// Run a local system ffmpeg render and stream the bytes back. Used only by
// the local editor client above; never reads/writes queries/ or persists.
function runLocalFfmpeg(argv, timeoutMs, exportId, totalDuration) {
  return new Promise(resolve => {
    if (exportId && totalDuration > 0) {
      exportProgress.set(exportId, { percent: 0, status: 'starting' });
    }
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', ...argv], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (exportId) {
      activeExports.set(exportId, child);
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      const chunkStr = chunk.toString('utf8');
      stderr += chunkStr;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);

      if (exportId && totalDuration > 0) {
        const current = exportProgress.get(exportId);
        if (current && current.status === 'cancelled') {
          return;
        }

        const matches = [...stderr.matchAll(/time=\s*(\d+):(\d+):(\d+)/g)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          const hours = parseInt(lastMatch[1], 10);
          const minutes = parseInt(lastMatch[2], 10);
          const seconds = parseInt(lastMatch[3], 10);
          const currentSecs = hours * 3600 + minutes * 60 + seconds;
          const rawPercent = (currentSecs / totalDuration) * 100;
          const percent = Math.min(99.99, Math.round(rawPercent * 100) / 100);
          exportProgress.set(exportId, { percent, status: 'rendering' });
        }
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (exportId) {
        activeExports.delete(exportId);
        exportProgress.set(exportId, { percent: 0, status: 'failed' });
        setTimeout(() => { exportProgress.delete(exportId); }, 10 * 60 * 1000);
      }
      resolve({ ok: false, timedOut: false, code: null, stderr: error?.message || String(error) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (exportId) {
        activeExports.delete(exportId);
        if (timedOut) {
          exportProgress.set(exportId, { percent: 0, status: 'timedout' });
        } else if (code === 0) {
          exportProgress.set(exportId, { percent: 100, status: 'done' });
        } else {
          const current = exportProgress.get(exportId);
          if (current && current.status === 'cancelled') {
            // Keep status cancelled
          } else {
            exportProgress.set(exportId, { percent: 0, status: 'failed' });
          }
        }
        setTimeout(() => { exportProgress.delete(exportId); }, 10 * 60 * 1000);
      }
      resolve({ ok: timedOut ? false : code === 0, timedOut, code, stderr });
    });
  });
}

// Multi-track export (spec version 2): repeated `video`/`audio`/`image`
// parts index-aligned with spec.files entries of each kind. Probes every
// media file (dims + audio presence + duration bound), renders the v2 graph,
// and streams back a fresh MP4. Temp originals are deleted afterwards; the
// library is never written.
async function handleEditorExportV2(req, res, parsed, spec) {
  const videoCount = spec.files.filter(f => f.kind === 'video').length;
  const audioCount = spec.files.filter(f => f.kind === 'audio').length;
  const videoParts = parsed.files.filter(f => f.fieldName === 'video');
  const audioParts = parsed.files.filter(f => f.fieldName === 'audio');
  let imageParts = parsed.files.filter(f => f.fieldName === 'image' && f.data.length > 0);
  if (videoParts.length !== videoCount || videoCount < 1 || videoCount > EDITOR_MAX_VIDEO_FILES) {
    return res.status(400).json({ error: 'Uploaded video files do not match the project.' });
  }
  if (audioParts.length !== audioCount || audioCount > EDITOR_MAX_AUDIO_FILES) {
    return res.status(400).json({ error: 'Uploaded audio files do not match the project.' });
  }
  if (imageParts.length > EDITOR_MAX_IMAGE_FILES) {
    return res.status(400).json({ error: `At most ${EDITOR_MAX_IMAGE_FILES} overlay images.` });
  }
  for (const vf of videoParts) {
    if (!vf.data.length || vf.data.length > editorMaxVideoBytes()) {
      return res.status(400).json({ error: `Video file is empty or exceeds ${editorMaxVideoMb()} MB.` });
    }
    if (!isAllowedEditorInput(vf.filename)) {
      return res.status(400).json({ error: 'Video must be mp4, webm, mov or mkv.' });
    }
  }
  for (const af of audioParts) {
    if (!af.data.length || af.data.length > EDITOR_MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'Audio file is empty or exceeds 200 MB.' });
    }
    if (!isAllowedEditorAudio(af.filename)) {
      return res.status(400).json({ error: 'Audio must be mp3, wav, m4a, aac, ogg or flac.' });
    }
  }
  for (const img of imageParts) {
    if (!isAllowedEditorImage(img.filename)) {
      return res.status(400).json({ error: 'Overlay image must be png, jpg or webp.' });
    }
    if (img.data.length > EDITOR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'Overlay image exceeds 5 MB.' });
    }
  }
  if (spec.images.length > 0) {
    for (let i = 0; i < spec.images.length; i++) {
      const needed = spec.images[i].file;
      if (!Number.isInteger(needed) || needed < 0 || needed >= imageParts.length) {
        return res.status(400).json({ error: `images[${i}] references an image that was not uploaded.` });
      }
    }
  } else {
    imageParts = [];
  }
  // Overlay videos reuse the already-uploaded `video` parts by kind-index.
  for (let i = 0; i < (spec.videoOverlays || []).length; i++) {
    const needed = spec.videoOverlays[i].file;
    if (!Number.isInteger(needed) || needed < 0 || needed >= videoParts.length) {
      return res.status(400).json({ error: `videoOverlays[${i}] references a video that was not uploaded.` });
    }
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gosu-video-editor-'));
  try {
    const videoPaths = [];
    for (let i = 0; i < videoParts.length; i++) {
      const p = path.join(tmpDir, `video${i}.bin`);
      await writeFile(p, videoParts[i].data);
      videoPaths.push(p);
    }
    const audioPaths = [];
    for (let i = 0; i < audioParts.length; i++) {
      const p = path.join(tmpDir, `audio${i}.bin`);
      await writeFile(p, audioParts[i].data);
      audioPaths.push(p);
    }
    const imgPaths = [];
    for (let i = 0; i < imageParts.length; i++) {
      const p = path.join(tmpDir, `overlay${i}.bin`);
      await writeFile(p, imageParts[i].data);
      imgPaths.push(p);
    }
    const outPath = path.join(tmpDir, 'edited.mp4');

    // Probe media facts the graph depends on. Missing ffprobe degrades to
    // assume-audio + declared dims (documented local-only behavior).
    const probes = [];
    for (const p of [...videoPaths, ...audioPaths]) probes.push(await probeMediaFile(p));
    const videoProbes = probes.slice(0, videoPaths.length);
    const audioProbes = probes.slice(videoPaths.length);
    for (let i = 0; i < videoProbes.length; i++) {
      const pr = videoProbes[i];
      // Null probe = ffprobe unavailable: skip checks, the render surfaces
      // real errors. A successful probe without dimensions = no video stream.
      if (pr && pr.width === null) {
        return res.status(400).json({ error: `Video file ${i + 1} has no video stream.` });
      }
    }
    for (let i = 0; i < audioProbes.length; i++) {
      const pr = audioProbes[i];
      if (pr && !pr.hasAudio) {
        return res.status(400).json({ error: `Audio file ${i + 1} has no audio stream.` });
      }
    }
    const clipBound = (list, paths, probes, label) => {
      for (const c of list) {
        const pr = probes[c.file];
        if (pr && pr.duration !== null && c.sourceOut > pr.duration + 1.0) {
          return `${label} extends beyond its file duration.`;
        }
      }
      return null;
    };
    const boundErr =
      clipBound(spec.videoClips, videoPaths, videoProbes, 'A video clip') ||
      clipBound(spec.audioClips, audioPaths, audioProbes, 'An audio clip');
    if (boundErr) return res.status(400).json({ error: boundErr });
    // Overlay source ranges must fit their file too (overlay audio is muted,
    // so only the video stream duration matters).
    for (let i = 0; i < (spec.videoOverlays || []).length; i++) {
      const ov = spec.videoOverlays[i];
      const pr = videoProbes[ov.file];
      const need = (ov.sourceIn || 0) + (ov.end - ov.start);
      if (pr && pr.duration !== null && need > pr.duration + 1.0) {
        return res.status(400).json({ error: `videoOverlays[${i}] extends beyond its file duration.` });
      }
    }

    const firstProbe = videoProbes[0] || null;
    const media = {
      width: Math.round(firstProbe && firstProbe.width ? firstProbe.width : spec.width),
      height: Math.round(firstProbe && firstProbe.height ? firstProbe.height : spec.height),
      hasAudio: videoProbes.map(pr => (pr ? pr.hasAudio : true))
    };
    let argv;
    try {
      const fontFile = (spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) ? findLocalEditorFont() : null;
      if ((spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) && !fontFile) {
        return res.status(400).json({ error: 'Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.' });
      }
      argv = buildFfmpegArgs({
        videoPaths, audioPaths, imagePaths: imgPaths, outputPath: outPath, spec, fontFile, media
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid edit spec.' });
    }
    const exportIdRaw = parsed.fields.exportId;
    const exportId = Array.isArray(exportIdRaw) ? exportIdRaw[0] : exportIdRaw;
    let totalDuration = 0;
    for (const c of [...spec.videoClips, ...spec.audioClips]) {
      totalDuration = Math.max(totalDuration, c.start + (c.sourceOut - c.sourceIn));
    }
    const result = await runLocalFfmpeg(argv, EDITOR_FFMPEG_TIMEOUT_MS, exportId, totalDuration);
    if (!result.ok) {
      if (result.timedOut) return res.status(504).json({ error: 'Render timed out (10 min limit). Try a shorter clip.' });
      if (/ENOENT/i.test(result.stderr || '')) {
        return res.status(500).json({ error: 'Local ffmpeg was not found. Install FFmpeg on this machine to export.' });
      }
      const tail = String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(-500);
      return res.status(500).json({ error: `Render failed.${tail ? ` ${tail}` : ''}` });
    }
    let outStat;
    try {
      outStat = await stat(outPath);
    } catch {
      return res.status(500).json({ error: 'Render produced no output.' });
    }
    if (!outStat.isFile() || outStat.size === 0) {
      return res.status(500).json({ error: 'Render produced no output.' });
    }
    const downloadName = `edited-${Date.now()}.mp4`;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outStat.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'X-Export-Filename': downloadName
    });
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(outPath);
      stream.on('error', rejectPromise);
      res.on('close', resolvePromise);
      res.on('finish', resolvePromise);
      stream.pipe(res);
    });
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Local-only export progress polling endpoint.
app.get('/api/admin/video-editor/export-progress', requireApiAuth, requireAdmin, (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const progress = exportProgress.get(id) || { percent: 0, status: 'unknown' };
  res.json(progress);
});

// Local-only export cancel endpoint.
app.post('/api/admin/video-editor/cancel-export', requireApiAuth, requireAdmin, (req, res) => {
  const id = (req.body && req.body.id) || req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const child = activeExports.get(id);
  if (!child) {
    return res.status(400).json({ error: 'No active export with this ID, or it already completed.' });
  }
  try {
    exportProgress.set(id, { percent: 0, status: 'cancelled' });
    child.kill('SIGKILL');
  } catch (err) {
    console.error('Failed to kill ffmpeg child process:', err);
  }
  activeExports.delete(id);
  res.json({ ok: true, message: 'Export cancelled.' });
});

// ── Isolated AI Video Generation POC (LTX-Video) — additive, admin-only ──
// Disabled unless AI_VIDEO_ENABLED=true, so the existing Video Editor is
// untouched by default. The web process NEVER runs the model: it only tracks
// queued/processing/completed/failed jobs and delegates execution to the
// isolated GPU worker (scripts/ltx-worker.js) via dispatchToWorker().
// Official upstream: https://github.com/Lightricks/LTX-Video
// (ltx_video.inference.infer / inference.py + pipeline YAML).
const aiVideoJobs = createAiVideoJobStore();

function aiVideoNotEnabled(res) {
  return res.status(404).json({ error: 'AI video generation is disabled.' });
}

// Deterministic placeholder MP4 bytes for mock-mode downloads. This is NOT
// model output; real runs are produced solely by the isolated worker.
function aiVideoMockMp4Bytes(prompt) {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31
  ]);
  const note = Buffer.from(`LTX-Video POC mock output. Prompt: ${String(prompt || 'mock').slice(0, 80)}. `, 'utf8');
  return Buffer.concat([ftyp, note]);
}

function aiVideoPublicJob(job) {
  if (!job) return job;
  const { id, prompt, options, state, createdAt, updatedAt, outputUrl, error } = job;
  return { id, prompt, options, state, createdAt, updatedAt, ...(outputUrl ? { outputUrl } : {}), ...(error ? { error } : {}) };
}

// Advance a queued job without blocking the create response. Real LTX
// execution happens only inside dispatchToWorker()'s target worker.
function aiVideoProcessInBackground(jobId) {
  setImmediate(async () => {
    try {
      aiVideoJobs.setState(jobId, 'processing');
    } catch {
      return;
    }
    const snap = aiVideoJobs.get(jobId);
    if (!snap) return;
    const config = aiVideoConfig();
    if (!config.workerUrl) {
      // No isolated worker configured (POC mock loop): complete with a
      // same-origin mock download URL. No model runs in this process.
      try {
        aiVideoJobs.setState(jobId, 'completed', { outputUrl: `/api/admin/ai-video/jobs/${jobId}/download` });
      } catch (err) {
        try { aiVideoJobs.markFailed(jobId, err?.message || 'Generation failed.'); } catch {}
      }
      return;
    }
    try {
      await dispatchToWorker(snap);
      try {
        aiVideoJobs.setState(jobId, 'completed', { outputUrl: `/api/admin/ai-video/jobs/${jobId}/download` });
      } catch {}
    } catch (err) {
      try { aiVideoJobs.markFailed(jobId, err?.message || 'Generation failed.'); } catch {}
    }
  });
}

app.post('/api/admin/ai-video/jobs', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isAiVideoEnabled()) return aiVideoNotEnabled(res);
  const checked = validateAiVideoRequest(req.body || {});
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  let job;
  try {
    job = aiVideoJobs.create(checked.prompt, checked.options);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid request.' });
  }
  aiVideoProcessInBackground(job.id);
  return res.status(201).json({ job: aiVideoPublicJob(job) });
});

app.get('/api/admin/ai-video/jobs/:id', requireApiAuth, requireAdmin, (req, res) => {
  if (!isAiVideoEnabled()) return aiVideoNotEnabled(res);
  const job = aiVideoJobs.get(String(req.params.id || ''));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json({ job: aiVideoPublicJob(job) });
});

app.get('/api/admin/ai-video/jobs/:id/download', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isAiVideoEnabled()) return aiVideoNotEnabled(res);
  const job = aiVideoJobs.get(String(req.params.id || ''));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.state !== 'completed') return res.status(409).json({ error: `Job is ${job.state}.` });
  // Real artifact (bytes the isolated worker wrote to AI_VIDEO_OUTPUT_DIR)
  // wins when present; otherwise the mock placeholder. No model code runs in
  // this process: this branch only streams a file off disk.
  try {
    const rawId = String(job.id || '');
    if (/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) {
      const outDir = aiVideoConfig().outputDir;
      if (outDir) {
        const abs = path.join(outDir, `${rawId}.mp4`);
        const st = await stat(abs);
        if (st.isFile() && st.size > 0) {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': st.size,
            'Content-Disposition': `attachment; filename="ai-video-${rawId.slice(0, 8)}.mp4"`
          });
          const stream = createReadStream(abs);
          stream.on('error', () => {
            try { res.end(); } catch {}
          });
          stream.pipe(res);
          return;
        }
      }
    }
  } catch {}
  const bytes = aiVideoMockMp4Bytes(job.prompt);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="ai-video-${job.id.slice(0, 8)}.mp4"`
  });
  return res.end(bytes);
});

// EDL evidence validation for the Admin Video Editor panel (local-only,
// Admin/Owner). Pure JSON validation of a hand-authored EDL against a
// manually supplied transcript: never renders, never exports, never touches
// the filesystem (source names are bare-filename gated and only ever echoed
// as keys, never resolved to paths).
function validateEdlEvidenceRequest(body) {
  const fail = (errors, summary = null) => ({ ok: false, status: 'FAILED', errors, warnings: [], summary });
  const summaryOf = (edl) => (edl && typeof edl === 'object' && !Array.isArray(edl) ? edlCutSummary(edl) : null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(['Request body must be a JSON object with "edl" and optional "transcript".']);
  }
  let edl = body.edl;
  if (typeof edl === 'string') {
    try {
      edl = JSON.parse(edl);
    } catch {
      return fail(['EDL is not valid JSON.']);
    }
  }
  let transcript = body.transcript;
  if (transcript === undefined || transcript === null || (typeof transcript === 'string' && transcript.trim() === '')) {
    transcript = null;
  } else if (typeof transcript === 'string') {
    try {
      transcript = JSON.parse(transcript);
    } catch {
      return fail(['Transcript is not valid JSON.']);
    }
  }
  const structural = validateEdlStructure(edl);
  if (!structural.ok) return fail([structural.error], summaryOf(edl));
  const sources = edl.sources && typeof edl.sources === 'object' ? edl.sources : {};
  for (const key of Object.keys(sources)) {
    if (!allowlistedEdlSource(sources[key], null)) {
      return fail([`sources.${key}: must be a bare file name (no paths).`], summaryOf(edl));
    }
  }
  for (const ov of Array.isArray(edl.overlays) ? edl.overlays : []) {
    if (ov && ov.file !== undefined && !allowlistedEdlSource(ov.file, null)) {
      return fail(['Overlay file must be a bare file name (no paths).'], summaryOf(edl));
    }
  }
  if (transcript === null) {
    return { ok: true, status: 'PASS', errors: [], warnings: [], summary: edlCutSummary(edl) };
  }
  const res = checkEdlEvidence(edl, transcript);
  const status = !res.ok ? 'FAILED' : res.warnings.length > 0 ? 'WARNINGS' : 'PASS';
  return { ok: res.ok, status, errors: res.errors, warnings: res.warnings, summary: edlCutSummary(edl) };
}

// Local-only EDL evidence validation endpoint. Disabled in production like
// the rest of the video editor; admin-only like the export routes.
app.post('/api/admin/edl-evidence/validate', requireApiAuth, requireAdmin, express.json({ limit: '1mb' }), (req, res) => {
  if (!isVideoEditorAvailable()) {
    return res.status(403).json({ ok: false, status: 'FAILED', errors: ['EDL evidence validation is disabled in production.'], warnings: [] });
  }
  const verdict = validateEdlEvidenceRequest(req.body);
  return res.status(verdict.ok ? 200 : 422).json(verdict);
});

// Local-only V2 spec generation from a validated EDL. Re-validates
// server-side; failed validation never produces a spec. Never renders.
app.post('/api/admin/edl-evidence/generate', requireApiAuth, requireAdmin, express.json({ limit: '1mb' }), (req, res) => {
  if (!isVideoEditorAvailable()) {
    return res.status(403).json({ ok: false, status: 'FAILED', errors: ['EDL evidence validation is disabled in production.'], warnings: [] });
  }
  const verdict = validateEdlEvidenceRequest(req.body);
  if (!verdict.ok) {
    return res.status(422).json({ ...verdict, spec: null, note: 'No V2 spec generated: validation failed.' });
  }
  let edl = req.body && req.body.edl;
  if (typeof edl === 'string') {
    try {
      edl = JSON.parse(edl);
    } catch {
      return res.status(422).json({ ok: false, status: 'FAILED', errors: ['EDL is not valid JSON.'], warnings: [], summary: null, spec: null });
    }
  }
  let spec;
  try {
    spec = edlToSpecV2(edl);
  } catch {
    return res.status(422).json({ ok: false, status: 'FAILED', errors: ['EDL collections are malformed (texts/overlays must be arrays of objects).'], warnings: [], summary: verdict.summary, spec: null });
  }
  const checked = validateSpecV2(spec);
  if (!checked.ok) {
    return res.status(422).json({ ok: false, status: 'FAILED', errors: [checked.error], warnings: verdict.warnings, summary: verdict.summary, spec: null });
  }
  return res.json({ ...verdict, spec: checked.spec });
});

// Import Thiings assets directly into the Video Editor workflow.
// Resolves item slugs or URLs to downloadable Vercel Blob / media assets and proxies the binary safely.
app.post('/api/admin/video-editor/import-thiings-asset', requireApiAuth, requireAdmin, async (req, res) => {
  try {
    const rawInput = (req.body && req.body.url) ? String(req.body.url).trim() : '';
    if (!rawInput) {
      return res.status(400).json({ error: 'Please provide a valid Thiings asset name, URL, or ID.' });
    }

    let downloadUrl = null;
    let canonicalSlug = 'asset';
    let assetName = 'thiings-asset.png';

    // Helper to fetch Thiings catalog
    async function getCatalog() {
      try {
        const catRes = await fetch('https://www.thiings.co/things', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (catRes.ok) {
          const text = await catRes.text();
          const unescaped = text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
          if (match) return JSON.parse(match[1]);
        }
      } catch (e) {}
      return [];
    }

    if (rawInput.includes('blob.vercel-storage.com/image-') || /\.(png|webp|jpg|jpeg|gif|mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov|mkv)$/i.test(rawInput)) {
      downloadUrl = rawInput;
      const fileMatch = rawInput.match(/image-([a-zA-Z0-9]+)\.png/i);
      if (fileMatch) {
        const catalog = await getCatalog();
        const catItem = catalog.find(i => i.fileId === fileMatch[1]);
        if (catItem) {
          canonicalSlug = catItem.id;
          assetName = `thiings-${catItem.id}.png`;
        }
      }
      if (!canonicalSlug || canonicalSlug === 'asset') {
        const uParts = rawInput.split('?')[0].split('/');
        assetName = uParts[uParts.length - 1] || 'thiings-asset.png';
      }
    } else {
      let slug = rawInput;
      if (rawInput.includes('/things/')) {
        const match = rawInput.match(/\/things\/([^\/\?#]+)/i);
        if (match) slug = match[1].toLowerCase();
      } else if (rawInput.startsWith('http://') || rawInput.startsWith('https://')) {
        const uParts = rawInput.split('?')[0].split('#')[0].split('/');
        slug = uParts[uParts.length - 1].toLowerCase();
      } else {
        slug = rawInput.replace(/^\/+/, '').replace(/^things\//i, '').trim().toLowerCase().replace(/\s+/g, '-');
      }
      canonicalSlug = slug;
      assetName = `thiings-${slug}.png`;

      // 1. Check catalog
      const catalog = await getCatalog();
      let catItem = catalog.find(i => i.id === slug || (i.name && i.name.toLowerCase() === slug.replace(/-/g, ' ')));
      if (!catItem) {
        const normQuery = slug.replace(/-/g, ' ').toLowerCase();
        catItem = catalog.find(i => i.id.toLowerCase().includes(slug.toLowerCase()) || (i.name && i.name.toLowerCase().includes(normQuery)));
      }
      if (catItem && catItem.fileId) {
        downloadUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${catItem.fileId}.png`;
        canonicalSlug = catItem.id;
        assetName = `thiings-${catItem.id}.png`;
      } else {
        // 2. Fetch target page HTML and inspect for item's verified image blob
        const targetUrl = `https://www.thiings.co/things/${slug}`;
        const pageRes = await fetch(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!pageRes.ok) {
          return res.status(404).json({ error: `Could not find Thiings item '${slug}' (HTTP ${pageRes.status}).` });
        }
        const html = await pageRes.text();
        const imageBlobMatches = html.match(/https:\/\/[a-zA-Z0-9\.-]+\.blob\.vercel-storage\.com\/image-[a-zA-Z0-9]+\.png/g);
        if (imageBlobMatches && imageBlobMatches.length > 0) {
          downloadUrl = imageBlobMatches[0];
        } else {
          return res.status(404).json({ error: `Could not verify downloadable asset for Thiings item '${slug}'.` });
        }
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: 'Could not resolve a verified downloadable asset for the specified Thiings item.' });
    }

    const assetRes = await fetch(downloadUrl);
    if (!assetRes.ok) {
      return res.status(assetRes.status).json({ error: `Failed to download asset binary from Thiings (HTTP ${assetRes.status}).` });
    }

    const contentType = assetRes.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await assetRes.arrayBuffer());

    if (!buffer || buffer.length === 0) {
      return res.status(500).json({ error: 'Downloaded asset is empty.' });
    }

    let ext = '.png';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('webp')) ext = '.webp';
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
    else if (contentType.includes('mp3') || contentType.includes('mpeg')) ext = '.mp3';
    else if (contentType.includes('wav')) ext = '.wav';
    else if (contentType.includes('mp4')) ext = '.mp4';
    else if (contentType.includes('quicktime')) ext = '.mov';

    if (!assetName.endsWith(ext)) {
      if (/\.[a-z0-9]+$/i.test(assetName)) {
        assetName = assetName.replace(/\.[a-z0-9]+$/i, ext);
      } else {
        assetName += ext;
      }
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${assetName}"`,
      'X-Asset-Filename': assetName,
      'X-Asset-Slug': canonicalSlug,
      'X-Asset-Source-Url': downloadUrl
    });
    return res.end(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error importing Thiings asset.' });
  }
});

// Search and lookup Thiings assets via publicly accessible catalog and page metadata
app.get('/api/admin/video-editor/search-thiings', requireApiAuth, requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || req.query.query || '').toString().trim();
    if (!q) {
      return res.json({ query: '', results: [] });
    }

    const qLower = q.toLowerCase();
    const slugCandidate = qLower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    let catalog = [];
    try {
      const catalogRes = await fetch('https://www.thiings.co/things', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (catalogRes.ok) {
        const rawText = await catalogRes.text();
        const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
        if (match) {
          catalog = JSON.parse(match[1]);
        }
      }
    } catch (e) {
      // Catalog fetch fallback
    }

    // Filter catalog items by query
    let results = catalog.filter(item => {
      const nameMatch = item.name && item.name.toLowerCase().includes(qLower);
      const idMatch = item.id && item.id.toLowerCase().includes(qLower);
      const catMatch = Array.isArray(item.categories) && item.categories.some(c => c.toLowerCase().includes(qLower));
      return nameMatch || idMatch || catMatch;
    }).slice(0, 15).map(item => ({
      id: item.id,
      name: item.name,
      categories: item.categories || [],
      pageUrl: `https://www.thiings.co/things/${item.id}`,
      assetUrl: item.fileId ? `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${item.fileId}.png` : null
    }));

    // If no catalog matches found, attempt direct page metadata resolution for the slug candidate
    if (results.length === 0 && slugCandidate) {
      const pageUrl = `https://www.thiings.co/things/${slugCandidate}`;
      const pageRes = await fetch(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (pageRes.ok) {
        const pageText = await pageRes.text();
        const imageBlobMatches = pageText.match(/https:\/\/[a-zA-Z0-9\.-]+\.blob\.vercel-storage\.com\/image-[a-zA-Z0-9]+\.png/g);
        if (imageBlobMatches && imageBlobMatches.length > 0) {
          const titleMatch = pageText.match(/<title>([^<]+)<\/title>/i);
          let realName = slugCandidate.replace(/-/g, ' ');
          if (titleMatch && titleMatch[1]) {
            realName = titleMatch[1].split('—')[0].replace(/3D Icon/i, '').trim() || realName;
          }
          results.push({
            id: slugCandidate,
            name: realName,
            categories: ['custom'],
            pageUrl,
            assetUrl: imageBlobMatches[0]
          });
        }
      }
    }

    return res.json({ query: q, results });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to search Thiings assets.' });
  }
});


// Finalize browser screen recordings as seekable MP4 using the local FFmpeg.
// Browser MediaRecorder MP4 support is inconsistent across desktop builds; the
// website records WebM efficiently, then converts once after Stop. This route
// is local-only and bounded by the existing editor upload limit.
app.post('/api/admin/video-editor/finalize-recording', requireApiAuth, requireAdmin, async (req, res) => {
  try { req.setTimeout(0); } catch {}
  try { res.setTimeout(0); } catch {}
  if (!isVideoEditorAvailable()) {
    return res.status(403).json({ error: 'Recording finalization is available only when the video editor is running locally.' });
  }
  const maxBytes = editorMaxVideoBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) {
    return res.status(413).json({ error: 'Recording is too large to finalize.' });
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gosu-screen-recording-'));
  try {
    const inputPath = path.join(tmpDir, 'recording.webm');
    const outputPath = path.join(tmpDir, 'recording.mp4');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) return res.status(413).json({ error: 'Recording is too large to finalize.' });
      chunks.push(chunk);
    }
    if (!size) return res.status(400).json({ error: 'Recording upload was empty.' });
    await writeFile(inputPath, Buffer.concat(chunks, size));
    const args = buildScreenRecordingFfmpegArgs({ inputPath, outputPath });
    const result = await runLocalFfmpeg(args, EDITOR_FFMPEG_TIMEOUT_MS, null, 0);
    if (!result.ok) {
      if (/ENOENT/i.test(result.stderr || '')) {
        return res.status(500).json({ error: 'Local FFmpeg was not found. Install FFmpeg to finalize the recording as MP4.' });
      }
      return res.status(result.timedOut ? 504 : 500).json({ error: 'Could not finalize recording as MP4.' });
    }
    const outStat = await stat(outputPath);
    if (!outStat.isFile() || outStat.size === 0) {
      return res.status(500).json({ error: 'FFmpeg produced an empty MP4.' });
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outStat.size,
      'Content-Disposition': 'attachment; filename="screen-recording.mp4"',
      'X-Recording-Filename': 'screen-recording.mp4'
    });
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(outputPath);
      stream.on('error', rejectPromise);
      res.on('close', resolvePromise);
      res.on('finish', resolvePromise);
      stream.pipe(res);
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Could not finalize recording as MP4.' });
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// Local-only Admin/Owner video export. Disabled in production/Render: the
// handler refuses before touching the body, so no ffmpeg ever runs there.
// The 15s global req/res timeout is lifted for this route only (uploads +
// transcodes legitimately take longer); all other routes are unaffected.
app.post('/api/admin/video-editor/export', requireApiAuth, requireAdmin, async (req, res) => {
  try { req.setTimeout(0); } catch {}
  try { res.setTimeout(0); } catch {}
  if (!isVideoEditorAvailable()) {
    return res.status(403).json({ error: 'Video editor is disabled in production. Run the app locally to export.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  let body;
  const maxRequestBytes = editorMaxRequestBytes();
  const maxRequestMb = Math.round(maxRequestBytes / 1048576);
  // Reject oversized uploads before buffering a byte (chunked uploads still
  // hit the streaming cap below).
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: `Upload too large (max ~${maxRequestMb} MB).` });
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: `Upload too large (max ~${maxRequestMb} MB).` });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;
  const specRaw = parsed.fields.spec;
  const specText = Array.isArray(specRaw) ? specRaw[0] : specRaw;
  if (typeof specText !== 'string' || !specText || Buffer.byteLength(specText, 'utf8') > EDITOR_MAX_SPEC_BYTES) {
    return res.status(400).json({ error: 'Missing or oversized edit spec.' });
  }
  let specJson;
  try {
    specJson = JSON.parse(specText);
  } catch {
    return res.status(400).json({ error: 'Edit spec is not valid JSON.' });
  }
  // Export quality/resolution: the client sends it both inside the spec and
  // as a top-level `resolution` field; the field wins when present. Unknown
  // values are rejected (400) so typos never silently render wrong.
  const resRaw = parsed.fields.resolution;
  const resText = Array.isArray(resRaw) ? resRaw[0] : resRaw;
  if (typeof resText === 'string' && resText.trim() !== '') {
    if (!normalizeExportResolution(resText)) {
      return res.status(400).json({ error: 'resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.' });
    }
    specJson.resolution = resText;
  }
  const checked = validateEditSpec(specJson);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const spec = checked.spec;
  if (spec.version === 2) {
    return handleEditorExportV2(req, res, parsed, spec);
  }

  const videoFile = parsed.files.find(f => f.fieldName === 'video');
  if (!videoFile) return res.status(400).json({ error: 'Missing video file.' });
  if (!isAllowedEditorInput(videoFile.filename)) {
    return res.status(400).json({ error: 'Video must be mp4, webm, mov or mkv.' });
  }
  if (videoFile.data.length === 0 || videoFile.data.length > editorMaxVideoBytes()) {
    return res.status(400).json({ error: `Video file is empty or exceeds ${editorMaxVideoMb()} MB.` });
  }
  // Overlay images: repeated `image` parts, order = spec images[].file index.
  // Legacy single-image uploads (one `image` part + V1 `image` spec key,
  // normalized to images[0].file = 0) keep working unchanged.
  let imageFiles = parsed.files.filter(f => f.fieldName === 'image' && f.data.length > 0);
  if (imageFiles.length > EDITOR_MAX_IMAGE_FILES) {
    return res.status(400).json({ error: `At most ${EDITOR_MAX_IMAGE_FILES} overlay images.` });
  }
  for (const imageFile of imageFiles) {
    if (!isAllowedEditorImage(imageFile.filename)) {
      return res.status(400).json({ error: 'Overlay image must be png, jpg or webp.' });
    }
    if (imageFile.data.length > EDITOR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'Overlay image exceeds 5 MB.' });
    }
  }
  if (spec.images.length > 0) {
    for (let i = 0; i < spec.images.length; i++) {
      const needed = spec.images[i].file;
      if (!Number.isInteger(needed) || needed < 0 || needed >= imageFiles.length) {
        return res.status(400).json({ error: `images[${i}] references an image that was not uploaded.` });
      }
    }
  } else {
    imageFiles = [];
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gosu-video-editor-'));
  try {
    const inPath = path.join(tmpDir, 'input.bin');
    const outPath = path.join(tmpDir, 'edited.mp4');
    await writeFile(inPath, videoFile.data);
    const imgPaths = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const imgPath = path.join(tmpDir, `overlay${i}.bin`);
      await writeFile(imgPath, imageFiles[i].data);
      imgPaths.push(imgPath);
    }
    let argv;
    try {
      const fontFile = (spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) ? findLocalEditorFont() : null;
      if ((spec.texts.length > 0 || (spec.watermark && spec.watermark.enabled)) && !fontFile) {
        return res.status(400).json({ error: 'Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.' });
      }
      argv = buildFfmpegArgs({ inputPath: inPath, imagePaths: imgPaths, outputPath: outPath, spec, fontFile });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid edit spec.' });
    }
    const exportIdRaw = parsed.fields.exportId;
    const exportId = Array.isArray(exportIdRaw) ? exportIdRaw[0] : exportIdRaw;
    let totalDuration = 0;
    const firstProbe = await probeMediaFile(inPath);
    if (firstProbe && firstProbe.duration) {
      totalDuration = firstProbe.duration;
    }
    const result = await runLocalFfmpeg(argv, EDITOR_FFMPEG_TIMEOUT_MS, exportId, totalDuration);
    if (!result.ok) {
      if (result.timedOut) return res.status(504).json({ error: 'Render timed out (10 min limit). Try a shorter clip.' });
      if (/ENOENT/i.test(result.stderr || '')) {
        return res.status(500).json({ error: 'Local ffmpeg was not found. Install FFmpeg on this machine to export.' });
      }
      const tail = String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(-500);
      return res.status(500).json({ error: `Render failed.${tail ? ` ${tail}` : ''}` });
    }
    let outStat;
    try {
      outStat = await stat(outPath);
    } catch {
      return res.status(500).json({ error: 'Render produced no output.' });
    }
    if (!outStat.isFile() || outStat.size === 0) {
      return res.status(500).json({ error: 'Render produced no output.' });
    }
    const downloadName = `edited-${Date.now()}.mp4`;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outStat.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'X-Export-Filename': downloadName
    });
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(outPath);
      stream.on('error', rejectPromise);
      res.on('close', resolvePromise);
      res.on('finish', resolvePromise);
      stream.pipe(res);
    });
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// Local-only Admin/Owner PDF editor — page. Mirrors the video editor:
// works on admin-selected LOCAL bytes (or a read-only library preselect),
// never writes library originals. Renders for admins even in production,
// but the UI shows a disabled notice there. Normal users: requireAdmin.
app.get('/admin/pdf-editor', requireAuth, requireAdmin, async (req, res) => {
  let preselectedPath = null;
  const requestedPath = String(req.query.path || '').trim();
  if (requestedPath && isSafeLibraryPath(requestedPath) && !isExternalFileName(path.basename(requestedPath))) {
    try {
      if (canAccessLibraryPath(req.user, requestedPath)) {
        const abs = resolveLibraryPath(requestedPath);
        if (abs && pdfInputExtensionOk(abs)) {
          const st = await stat(abs);
          if (st.isFile()) preselectedPath = requestedPath;
        }
      }
    } catch {}
  }
  res.render('admin-pdf-editor', {
    user: req.user,
    pdfEditorAvailable: isPdfEditorAvailable(),
    pdfEditorMaxFileMb: PDF_EDITOR_MAX_FILE_MB,
    preselectedPath
  });
});

function pdfInputExtensionOk(absPath) {
  try {
    return String(absPath).toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

// Local-only Admin/Owner PDF export. Disabled in production: refuses before
// touching the body. Fully in-memory (pdf-lib): no temp files, no shell, no
// external services. Multipart parts: repeated `pdf` (index-aligned with
// spec.files), repeated `image` (index-aligned with spec.images), `spec`.
app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfEditorAvailable()) {
    return res.status(403).json({ error: 'PDF editor is disabled in production. Run the app locally to export.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfEditorMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;
  const specRaw = parsed.fields.spec;
  const specText = Array.isArray(specRaw) ? specRaw[0] : specRaw;
  if (typeof specText !== 'string' || !specText || Buffer.byteLength(specText, 'utf8') > PDF_EDITOR_MAX_SPEC_BYTES) {
    return res.status(400).json({ error: 'Missing or oversized edit spec.' });
  }
  let specJson;
  try {
    specJson = JSON.parse(specText);
  } catch {
    return res.status(400).json({ error: 'Edit spec is not valid JSON.' });
  }
  const checked = validatePdfEditSpec(specJson);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const spec = checked.spec;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length !== spec.files.length || spec.files.length < 1 || spec.files.length > PDF_EDITOR_MAX_FILES) {
    return res.status(400).json({ error: 'Uploaded PDF files do not match the project.' });
  }
  for (const pf of pdfParts) {
    if (!pf.data.length || pf.data.length > PDF_EDITOR_MAX_FILE_BYTES) {
      return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_EDITOR_MAX_FILE_MB} MB.` });
    }
    if (!isAllowedPdfInput(pf.filename)) {
      return res.status(400).json({ error: 'Source files must be .pdf.' });
    }
  }
  let imageParts = parsed.files.filter(f => f.fieldName === 'image' && f.data.length > 0);
  if (imageParts.length > PDF_EDITOR_MAX_IMAGE_FILES) {
    return res.status(400).json({ error: `At most ${PDF_EDITOR_MAX_IMAGE_FILES} overlay images.` });
  }
  for (const img of imageParts) {
    if (!isAllowedPdfImage(img.filename)) {
      return res.status(400).json({ error: 'Overlay image must be png or jpg.' });
    }
    if (img.data.length > PDF_EDITOR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: 'Overlay image exceeds 5 MB.' });
    }
  }
  const needsImages = spec.pages.some(p => p.markups.some(m => m.kind === 'image'));
  if (needsImages) {
    for (const entry of spec.pages) {
      for (const m of entry.markups) {
        if (m.kind === 'image' && (!Number.isInteger(m.file) || m.file < 0 || m.file >= imageParts.length)) {
          return res.status(400).json({ error: 'An image markup references an image that was not uploaded.' });
        }
      }
    }
  } else {
    imageParts = [];
  }

  let outBytes;
  try {
    outBytes = await renderPdfExport({
      pdfBytesList: pdfParts.map(p => p.data),
      imageBytesList: imageParts.map(p => p.data),
      spec
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid edit spec.' });
  }
  if (!outBytes || outBytes.length === 0) {
    return res.status(500).json({ error: 'Render produced no output.' });
  }
  const outBuf = Buffer.from(outBytes);
  const downloadName = `edited-${Date.now()}.pdf`;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Merge PDF utility (admin-only). Deliberately separate from the
// PDF Editor routes above: no editor code paths are touched.
// Page: GET /admin/pdf-tools/merge. API: POST /api/admin/pdf-tools/merge.
// Multipart parts: repeated `pdf` in DISPLAYED merge order + optional `order`
// JSON array (explicit index map, validated strictly). In-memory via pdf-lib;
// sources are never modified — output is a NEW PDF download.
app.get('/admin/pdf-tools/merge', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-merge', {
    user: req.user,
    pdfMergeAvailable: isPdfMergeAvailable(),
    pdfMergeMaxFileMb: PDF_MERGE_MAX_FILE_MB,
    pdfMergeMaxFiles: PDF_MERGE_MAX_FILES
  });
});

app.post('/api/admin/pdf-tools/merge', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfMergeAvailable()) {
    return res.status(403).json({ error: 'PDF merge is disabled in production. Run the app locally to merge.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfMergeMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  const selection = validatePdfMergeSelection(
    pdfParts.map(p => ({ name: p.filename, size: p.data.length }))
  );
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  for (const pf of pdfParts) {
    if (!pf.data.length || pf.data.length > PDF_MERGE_MAX_FILE_BYTES) {
      return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_MERGE_MAX_FILE_MB} MB.` });
    }
    if (!isAllowedPdfInput(pf.filename)) {
      return res.status(400).json({ error: 'Source files must be .pdf.' });
    }
  }

  // Optional explicit order map (client sends displayed order explicitly).
  let orderedBytes = pdfParts.map(p => p.data);
  const orderRaw = parsed.fields.order;
  const orderText = Array.isArray(orderRaw) ? orderRaw[0] : orderRaw;
  if (typeof orderText === 'string' && orderText.trim() !== '') {
    let orderJson;
    try {
      orderJson = JSON.parse(orderText);
    } catch {
      return res.status(400).json({ error: 'order is not valid JSON.' });
    }
    const checkedOrder = validatePdfMergeOrder(orderJson, pdfParts.length);
    if (!checkedOrder.ok) return res.status(400).json({ error: checkedOrder.error });
    orderedBytes = checkedOrder.order.map(i => pdfParts[i].data);
  }

  let outBytes;
  try {
    outBytes = await mergePdfs(orderedBytes);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to merge PDFs.' });
  }
  if (!outBytes || outBytes.length === 0) {
    return res.status(500).json({ error: 'Merge produced no output.' });
  }
  const outBuf = Buffer.from(outBytes);
  const downloadName = `merged-${Date.now()}.pdf`;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Unlock PDF utility (admin-only). Deliberately separate from the
// PDF Editor and Merge routes above: no editor/merge code paths are touched.
// Page: GET /admin/pdf-tools/unlock. API: POST /api/admin/pdf-tools/unlock.
// Multipart parts: exactly one `pdf` file + one `password` text field. The
// password is tried exactly once (never guessed, brute-forced, bypassed or
// recovered); the upload is never modified — output is a NEW unencrypted PDF
// download named `<original>-unlocked.pdf`. Fully in-memory; the password is
// never logged or persisted.
app.get('/admin/pdf-tools/unlock', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-unlock', {
    user: req.user,
    pdfUnlockAvailable: isPdfUnlockAvailable(),
    pdfUnlockMaxFileMb: PDF_UNLOCK_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/unlock', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfUnlockAvailable()) {
    return res.status(403).json({ error: 'PDF unlock is disabled in production. Run the app locally to unlock.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfUnlockMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfUnlockUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_UNLOCK_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_UNLOCK_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const pwRaw = parsed.fields.password;
  const pwText = Array.isArray(pwRaw) ? pwRaw[0] : pwRaw;
  const checkedPw = validatePdfUnlockPassword(
    typeof pwText === 'string' ? pwText : (pwText === undefined || pwText === null ? '' : null)
  );
  if (!checkedPw.ok) return res.status(400).json({ error: checkedPw.error });

  let outBytes;
  try {
    outBytes = await unlockPdf(pf.data, checkedPw.password);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to unlock PDF.' });
  }
  if (!outBytes || outBytes.length === 0) {
    return res.status(500).json({ error: 'Unlock produced no output.' });
  }
  const outBuf = Buffer.from(outBytes);
  const downloadName = unlockDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Protect PDF utility (admin-only). Deliberately separate from the
// PDF Editor, Merge and Unlock routes above: no editor/merge/unlock code
// paths are touched.
// Page: GET /admin/pdf-tools/protect. API: POST /api/admin/pdf-tools/protect.
// Multipart parts: exactly one `pdf` file + `password` and `confirmPassword`
// text fields (mismatch rejected server-side as well as client-side). The
// password is used for AES-256 encryption only (never recovered, cracked or
// bypassed); the upload is never modified — output is a NEW encrypted PDF
// download named `<original>-protected.pdf`. Fully in-memory; the password is
// never logged or persisted.
app.get('/admin/pdf-tools/protect', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-protect', {
    user: req.user,
    pdfProtectAvailable: isPdfProtectAvailable(),
    pdfProtectMaxFileMb: PDF_PROTECT_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/protect', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfProtectAvailable()) {
    return res.status(403).json({ error: 'PDF protect is disabled in production. Run the app locally to protect.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfProtectMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfProtectUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_PROTECT_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_PROTECT_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedPw = validatePdfProtectPasswords(fieldText('password'), fieldText('confirmPassword'));
  if (!checkedPw.ok) return res.status(400).json({ error: checkedPw.error });

  let outBytes;
  try {
    outBytes = await protectPdf(pf.data, checkedPw.password);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to protect PDF.' });
  }
  if (!outBytes || outBytes.length === 0) {
    return res.status(500).json({ error: 'Protection produced no output.' });
  }
  const outBuf = Buffer.from(outBytes);
  const downloadName = protectDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Compress PDF utility (admin-only). Deliberately separate from the
// PDF Editor, Merge, Unlock and Protect routes above: no editor/merge/unlock/
// protect code paths are touched.
// Page: GET /admin/pdf-tools/compress. API: POST /api/admin/pdf-tools/compress.
// Multipart parts: exactly one `pdf` file + optional `level` text field
// (fast|balanced|maximum, default balanced). Compression is lossless only
// (stream recompression + object-stream packing; images are never
// downsampled). The upload is never modified — output is a NEW PDF download
// named `<original>-compressed.pdf`. If the engine cannot shrink the file,
// the ORIGINAL bytes are returned with X-Compress-Reduced: 0 rather than a
// bigger file. Fully in-memory.
app.get('/admin/pdf-tools/compress', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-compress', {
    user: req.user,
    pdfCompressAvailable: isPdfCompressAvailable(),
    pdfCompressMaxFileMb: PDF_COMPRESS_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/compress', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfCompressAvailable()) {
    return res.status(403).json({ error: 'PDF compress is disabled in production. Run the app locally to compress.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfCompressMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfCompressUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_COMPRESS_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_COMPRESS_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const levelRaw = parsed.fields.level;
  const levelText = Array.isArray(levelRaw) ? levelRaw[0] : levelRaw;
  const checkedLevel = validatePdfCompressLevel(
    typeof levelText === 'string' ? levelText : (levelText === undefined || levelText === null ? '' : null)
  );
  if (!checkedLevel.ok) return res.status(400).json({ error: checkedLevel.error });

  let result;
  try {
    result = await compressPdf(pf.data, checkedLevel.level);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to compress PDF.' });
  }
  if (!result || !result.bytes || result.bytes.length === 0) {
    return res.status(500).json({ error: 'Compression produced no output.' });
  }
  const outBuf = Buffer.from(result.bytes);
  const downloadName = compressDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Compress-Reduced': result.reduced ? '1' : '0',
    'X-Compress-Ratio': String(Math.round(result.ratio * 10) / 10),
    'X-Compress-Level': result.level
  });
  res.end(outBuf);
});

// Standalone Split PDF utility (admin-only). Deliberately separate from the
// PDF Editor, Merge, Unlock, Protect and Compress routes above: no
// editor/merge/unlock/protect/compress code paths are touched.
// Page: GET /admin/pdf-tools/split. API: POST /api/admin/pdf-tools/split.
// Multipart parts: exactly one `pdf` file + `mode` (extract|every|pages) +
// `selection` (extract mode, e.g. "1-3,5") + `every` (every mode chunk size).
// A single result downloads directly as PDF; multiple results download as a
// ZIP built fully in memory. The upload is never modified. Fully in-memory.
app.get('/admin/pdf-tools/split', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-split', {
    user: req.user,
    pdfSplitAvailable: isPdfSplitAvailable(),
    pdfSplitMaxFileMb: PDF_SPLIT_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/split', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfSplitAvailable()) {
    return res.status(403).json({ error: 'PDF split is disabled in production. Run the app locally to split.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfSplitMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfSplitUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_SPLIT_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_SPLIT_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };

  let result;
  try {
    result = await splitPdf(pf.data, {
      mode: fieldText('mode'),
      selectionText: fieldText('selection'),
      every: fieldText('every')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to split PDF.' });
  }
  if (!result || !Array.isArray(result.parts) || result.parts.length === 0) {
    return res.status(500).json({ error: 'Split produced no output.' });
  }
  if (result.parts.length === 1) {
    const outBuf = Buffer.from(result.parts[0].bytes);
    const names = splitPartNames({
      originalName: pf.filename, mode: result.mode,
      selectionText: fieldText('selection'),
      groups: [result.parts[0].pages]
    });
    const downloadName = names[0];
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': outBuf.length,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'X-Export-Filename': downloadName,
      'X-Split-Parts': '1'
    });
    res.end(outBuf);
    return;
  }
  const names = splitPartNames({
    originalName: pf.filename, mode: result.mode,
    selectionText: fieldText('selection'),
    groups: result.parts.map(p => p.pages)
  });
  let zipBuf;
  try {
    zipBuf = buildZip(result.parts.map((p, i) => ({ name: names[i], data: p.bytes })));
  } catch {
    return res.status(500).json({ error: 'Unable to package split output.' });
  }
  const downloadName = splitZipName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Split-Parts': String(result.parts.length)
  });
  res.end(zipBuf);
});

// Standalone Images to PDF utility (admin-only). Deliberately separate from
// the PDF Editor, Merge, Unlock, Protect, Compress and Split routes above: no
// existing code paths are touched.
// Page: GET /admin/pdf-tools/images-to-pdf.
// API: POST /api/admin/pdf-tools/images-to-pdf.
// Multipart parts: repeated `image` files in DISPLAYED order + `pageSize`,
// `orientation` and `margin` text fields. Images are embedded with pdf-lib
// (JPEG bytes verbatim, PNG losslessly — no quality change). The uploads are
// never modified — output is a NEW PDF download named after the first image.
// Fully in-memory.
app.get('/admin/pdf-tools/images-to-pdf', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-images', {
    user: req.user,
    pdfImagesAvailable: isPdfImagesAvailable(),
    pdfImagesMaxFileMb: PDF_IMAGES_MAX_FILE_MB,
    pdfImagesMaxFiles: PDF_IMAGES_MAX_FILES
  });
});

app.post('/api/admin/pdf-tools/images-to-pdf', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfImagesAvailable()) {
    return res.status(403).json({ error: 'Images to PDF is disabled in production. Run the app locally to convert.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfImagesMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const imageParts = parsed.files.filter(f => f.fieldName === 'image');
  const selection = validatePdfImagesUpload(
    imageParts.map(p => ({ name: p.filename, size: p.data.length }))
  );
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  for (const img of imageParts) {
    if (!img.data.length || img.data.length > PDF_IMAGES_MAX_FILE_BYTES) {
      return res.status(400).json({ error: `Image is empty or exceeds ${PDF_IMAGES_MAX_FILE_MB} MB.` });
    }
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedOpts = validatePdfImagesOptions({
    pageSize: fieldText('pageSize'),
    orientation: fieldText('orientation'),
    margin: fieldText('margin')
  });
  if (!checkedOpts.ok) return res.status(400).json({ error: checkedOpts.error });

  let outBuf;
  try {
    outBuf = await imagesToPdf(
      imageParts.map(p => ({ bytes: p.data, name: p.filename })),
      checkedOpts.options
    );
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to convert images.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Conversion produced no output.' });
  }
  const downloadName = imagesDownloadName(imageParts[0].filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Images-Pages': String(imageParts.length)
  });
  res.end(outBuf);
});

// Standalone PDF to Images utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
//
// Rendering happens client-side (a 2D canvas only exists in the browser —
// neither pdf-lib nor pdfjs-dist can rasterize in Node, and no native canvas
// runtime was added). The source PDF is never uploaded: the client renders
// selected pages with the vendored pdf.js and downloads a single image
// directly. Only multi-page results come here, as already-rendered PNG/JPEG
// uploads to be packaged into a ZIP.
//
// Page: GET /admin/pdf-tools/pdf-to-images.
// API: POST /api/admin/pdf-tools/pdf-to-images/zip.
// Multipart parts: repeated `image` files (validated PNG/JPEG renders in
// displayed page order) + `basename` text field for output naming.
// Fully in-memory.
app.get('/admin/pdf-tools/pdf-to-images', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-to-images', {
    user: req.user,
    pdfToImagesAvailable: isPdfToImagesAvailable()
  });
});

app.post('/api/admin/pdf-tools/pdf-to-images/zip', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfToImagesAvailable()) {
    return res.status(403).json({ error: 'PDF to Images is disabled in production. Run the app locally to convert.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfToImagesMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const imageParts = parsed.files.filter(f => f.fieldName === 'image');
  const selection = validatePdfToImagesUpload(
    imageParts.map(p => ({ name: p.filename, size: p.data.length, bytes: p.data }))
  );
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  for (const img of imageParts) {
    if (!img.data.length || img.data.length > PDF_TO_IMAGES_MAX_PART_BYTES) {
      return res.status(400).json({ error: `Rendered image is empty or exceeds ${PDF_TO_IMAGES_MAX_PART_MB} MB.` });
    }
  }
  if (imageParts.length > PDF_TO_IMAGES_MAX_PARTS) {
    return res.status(400).json({ error: `At most ${PDF_TO_IMAGES_MAX_PARTS} page images per ZIP.` });
  }

  const baseRaw = parsed.fields.basename;
  const baseText = Array.isArray(baseRaw) ? baseRaw[0] : baseRaw;
  const basename = typeof baseText === 'string' && baseText.trim() !== '' ? baseText : 'document';

  let zipBuf;
  try {
    zipBuf = zipRenderedImages(imageParts.map(p => ({ name: p.filename, bytes: p.data })));
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to package images.' });
  }
  const downloadName = renderedZipName(basename);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Rendered-Parts': String(imageParts.length)
  });
  res.end(zipBuf);
});

// Standalone Extract Images utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
//
// Embedded raster images are read from the file's object model (no page
// rasterization): JPEGs return byte-verbatim, other 8-bit images return as
// losslessly re-encoded PNGs. The source PDF is only read, never modified.
//
// Page: GET /admin/pdf-tools/extract-images.
// API: POST /api/admin/pdf-tools/extract-images/list — multipart `pdf` file,
//   responds JSON { images: [{ index, page, width, height, format, sizeBytes,
//   name, dataBase64 }], skipped: [{ page, reason }] }.
// API: POST /api/admin/pdf-tools/extract-images/download — multipart `pdf`
//   file + `selection` ("all" or "1,3" image numbers). One image downloads
//   directly; several download as a ZIP built fully in memory.
app.get('/admin/pdf-tools/extract-images', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-extract-images', {
    user: req.user,
    pdfExtractImagesAvailable: isPdfExtractImagesAvailable(),
    pdfExtractImagesMaxFileMb: PDF_EXTRACT_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/extract-images/list', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfExtractImagesAvailable()) {
    return res.status(403).json({ error: 'Extract Images is disabled in production. Run the app locally to extract.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfExtractImagesMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfExtractImagesUpload, PDF_EXTRACT_MAX_FILE_BYTES, PDF_EXTRACT_MAX_FILE_MB);
  if (!pf) return;
  let listing;
  try {
    listing = await extractPdfImages(pf.data);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to extract images.' });
  }
  const names = extractedImageNames({ originalName: pf.filename, images: listing.images });
  res.json({
    images: listing.images.map((img, i) => ({
      index: img.index,
      page: img.page,
      width: img.width,
      height: img.height,
      format: img.format,
      sizeBytes: img.sizeBytes,
      name: names[i],
      dataBase64: Buffer.from(img.data).toString('base64')
    })),
    skipped: listing.skipped
  });
});

app.post('/api/admin/pdf-tools/extract-images/download', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfExtractImagesAvailable()) {
    return res.status(403).json({ error: 'Extract Images is disabled in production. Run the app locally to extract.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfExtractImagesMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfExtractImagesUpload, PDF_EXTRACT_MAX_FILE_BYTES, PDF_EXTRACT_MAX_FILE_MB);
  if (!pf) return;
  const selRaw = parsed.fields.selection;
  const selText = Array.isArray(selRaw) ? selRaw[0] : selRaw;
  let listing;
  try {
    listing = await extractPdfImages(pf.data);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to extract images.' });
  }
  if (listing.images.length === 0) {
    return res.status(400).json({ error: 'No extractable images found in this PDF.' });
  }
  let selected;
  try {
    selected = selectExtractedImages(listing, typeof selText === 'string' ? selText : 'all');
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid selection.' });
  }
  const names = extractedImageNames({ originalName: pf.filename, images: listing.images });
  const byIndex = new Map(listing.images.map((img, i) => [img.index, names[i]]));
  if (selected.length === 1) {
    const img = selected[0];
    const outBuf = Buffer.from(img.data);
    const downloadName = byIndex.get(img.index);
    res.writeHead(200, {
      'Content-Type': img.format === 'jpg' ? 'image/jpeg' : 'image/png',
      'Content-Length': outBuf.length,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'X-Export-Filename': downloadName,
      'X-Extracted-Count': '1'
    });
    res.end(outBuf);
    return;
  }
  let zipBuf;
  try {
    zipBuf = zipExtractedImages(selected.map(img => ({ name: byIndex.get(img.index), bytes: img.data })));
  } catch {
    return res.status(500).json({ error: 'Unable to package extracted images.' });
  }
  const downloadName = extractedZipName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Extracted-Count': String(selected.length)
  });
  res.end(zipBuf);
});

// Standalone Rotate PDF utility (admin-only). Deliberately separate from all
// other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/rotate. API: POST /api/admin/pdf-tools/rotate.
// Multipart parts: exactly one `pdf` file + `angle` + `scope` (all|range) +
// `selection` (range mode). Relative rotation via qpdf. Fully in-memory.
app.get('/admin/pdf-tools/rotate', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-rotate', {
    user: req.user,
    pdfRotateAvailable: isPdfRotateAvailable(),
    pdfRotateMaxFileMb: PDF_ROTATE_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/rotate', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfRotateAvailable()) {
    return res.status(403).json({ error: 'PDF rotate is disabled in production. Run the app locally to rotate.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfRotateMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfRotateUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_ROTATE_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_ROTATE_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };

  let outBuf;
  let usedAngle = PDF_ROTATE_DEFAULT_ANGLE;
  try {
    const checkedAngle = validatePdfRotateAngle(fieldText('angle') || String(PDF_ROTATE_DEFAULT_ANGLE));
    if (!checkedAngle.ok) return res.status(400).json({ error: checkedAngle.error });
    usedAngle = checkedAngle.angle;
    outBuf = await rotatePdf(pf.data, {
      angle: usedAngle,
      scope: fieldText('scope'),
      selectionText: fieldText('selection')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to rotate PDF.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Rotation produced no output.' });
  }
  const downloadName = rotateDownloadName(pf.filename, usedAngle);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Crop PDF utility (admin-only). Deliberately separate from all
// other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/crop. API: POST /api/admin/pdf-tools/crop.
// Multipart parts: exactly one `pdf` file + `scope` (all|range) +
// `selection` (range mode) + marginTop/marginRight/marginBottom/marginLeft
// (points). Narrows page CropBoxes only — content untouched. Fully in-memory.
app.get('/admin/pdf-tools/crop', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-crop', {
    user: req.user,
    pdfCropAvailable: isPdfCropAvailable(),
    pdfCropMaxFileMb: PDF_CROP_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/crop', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfCropAvailable()) {
    return res.status(403).json({ error: 'PDF crop is disabled in production. Run the app locally to crop.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfCropMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfCropUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_CROP_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_CROP_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedMargins = validatePdfCropMargins({
    top: fieldText('marginTop'),
    right: fieldText('marginRight'),
    bottom: fieldText('marginBottom'),
    left: fieldText('marginLeft')
  });
  if (!checkedMargins.ok) return res.status(400).json({ error: checkedMargins.error });

  let outBuf;
  try {
    outBuf = await cropPdf(pf.data, {
      margins: checkedMargins.margins,
      scope: fieldText('scope'),
      selectionText: fieldText('selection')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to crop PDF.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Crop produced no output.' });
  }
  const downloadName = cropDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Page Numbers utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/page-numbers.
// API: POST /api/admin/pdf-tools/page-numbers.
// Multipart parts: exactly one `pdf` file + `scope` (all|range) +
// `selection` (range mode) + `position`, `start`, `fontSize`, `prefix`.
// Numbers are drawn onto pages (content otherwise untouched). Fully in-memory.
app.get('/admin/pdf-tools/page-numbers', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-numbers', {
    user: req.user,
    pdfNumbersAvailable: isPdfNumbersAvailable(),
    pdfNumbersMaxFileMb: PDF_NUMBERS_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/page-numbers', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfNumbersAvailable()) {
    return res.status(403).json({ error: 'Page numbers are disabled in production. Run the app locally to number.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfNumbersMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfNumbersUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_NUMBERS_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_NUMBERS_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedOpts = validatePdfNumbersOptions({
    position: fieldText('position'),
    start: fieldText('start'),
    fontSize: fieldText('fontSize'),
    prefix: fieldText('prefix')
  });
  if (!checkedOpts.ok) return res.status(400).json({ error: checkedOpts.error });

  let outBuf;
  try {
    outBuf = await addPageNumbers(pf.data, {
      ...checkedOpts.options,
      scope: fieldText('scope'),
      selectionText: fieldText('selection')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to add page numbers.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Numbering produced no output.' });
  }
  const downloadName = numbersDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Watermark PDF utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/watermark.
// API: POST /api/admin/pdf-tools/watermark.
// Multipart parts: exactly one `pdf` file + `scope` (all|range) +
// `selection` (range mode) + `text`, `position`, `fontSize`, `color`,
// `opacity`, `angle`. The watermark is drawn over pages (underlying content
// otherwise untouched). Fully in-memory.
app.get('/admin/pdf-tools/watermark', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-watermark', {
    user: req.user,
    pdfWatermarkAvailable: isPdfWatermarkAvailable(),
    pdfWatermarkMaxFileMb: PDF_WATERMARK_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/watermark', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfWatermarkAvailable()) {
    return res.status(403).json({ error: 'Watermarks are disabled in production. Run the app locally to watermark.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfWatermarkMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfWatermarkUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_WATERMARK_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_WATERMARK_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedOpts = validatePdfWatermarkOptions({
    text: fieldText('text'),
    position: fieldText('position'),
    fontSize: fieldText('fontSize'),
    color: fieldText('color'),
    opacity: fieldText('opacity'),
    angle: fieldText('angle')
  });
  if (!checkedOpts.ok) return res.status(400).json({ error: checkedOpts.error });

  let outBuf;
  try {
    outBuf = await addWatermark(pf.data, {
      ...checkedOpts.options,
      scope: fieldText('scope'),
      selectionText: fieldText('selection')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to add watermark.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Watermark produced no output.' });
  }
  const downloadName = watermarkDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Flatten PDF utility (admin-only). Deliberately separate from all
// other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/flatten.
// API: POST /api/admin/pdf-tools/flatten.
// Multipart parts: exactly one `pdf` file. Fillable form fields are baked
// into page content (field count reported via X-Flattened-Count); documents
// without fields return unchanged. Fully in-memory.
app.get('/admin/pdf-tools/flatten', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-flatten', {
    user: req.user,
    pdfFlattenAvailable: isPdfFlattenAvailable(),
    pdfFlattenMaxFileMb: PDF_FLATTEN_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/flatten', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfFlattenAvailable()) {
    return res.status(403).json({ error: 'PDF flatten is disabled in production. Run the app locally to flatten.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfFlattenMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfFlattenUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_FLATTEN_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_FLATTEN_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  let result;
  try {
    result = await flattenPdf(pf.data);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to flatten PDF.' });
  }
  if (!result || !result.bytes || result.bytes.length === 0) {
    return res.status(500).json({ error: 'Flatten produced no output.' });
  }
  const outBuf = Buffer.from(result.bytes);
  const downloadName = flattenDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Flattened-Count': String(result.flattened.length)
  });
  res.end(outBuf);
});

// Standalone Bookmarks utility (admin-only). Deliberately separate from all
// other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/bookmarks.
// API: POST /api/admin/pdf-tools/bookmarks/info — multipart `pdf` file,
//   responds JSON { bookmarks: [{ title, page }] } (page null when the
//   destination cannot be resolved).
// API: POST /api/admin/pdf-tools/bookmarks/apply — multipart `pdf` file plus
//   `entries` ("Title | page" lines) and `mode` (append|replace). Appending
//   preserves existing bookmarks; replacing rebuilds the outline. Responds
//   with a NEW PDF. Fully in-memory.
app.get('/admin/pdf-tools/bookmarks', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-bookmarks', {
    user: req.user,
    pdfBookmarksAvailable: isPdfBookmarksAvailable(),
    pdfBookmarksMaxFileMb: PDF_BOOKMARKS_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/bookmarks/info', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfBookmarksAvailable()) {
    return res.status(403).json({ error: 'PDF bookmarks are disabled in production. Run the app locally to edit.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfBookmarksMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfBookmarksUpload, PDF_BOOKMARKS_MAX_FILE_BYTES, PDF_BOOKMARKS_MAX_FILE_MB);
  if (!pf) return;
  try {
    res.json({ bookmarks: await getPdfBookmarks(pf.data) });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to read bookmarks.' });
  }
});

app.post('/api/admin/pdf-tools/bookmarks/apply', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfBookmarksAvailable()) {
    return res.status(403).json({ error: 'PDF bookmarks are disabled in production. Run the app locally to edit.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfBookmarksMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfBookmarksUpload, PDF_BOOKMARKS_MAX_FILE_BYTES, PDF_BOOKMARKS_MAX_FILE_MB);
  if (!pf) return;
  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedMode = validatePdfBookmarksMode(fieldText('mode'));
  if (!checkedMode.ok) return res.status(400).json({ error: checkedMode.error });
  const entriesText = fieldText('entries');
  let outBuf;
  try {
    outBuf = await setPdfBookmarks(pf.data, { entriesText, mode: checkedMode.mode });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to edit bookmarks.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Bookmarks produced no output.' });
  }
  const downloadName = bookmarksDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Sign PDF utility (admin-only, VISUAL signatures only — this is
// NOT a cryptographic digital signature: no /Sig dictionaries, no ByteRange,
// no certification). Deliberately separate from all other PDF routes above:
// no existing code paths are touched.
// Page: GET /admin/pdf-tools/sign.
// API: POST /api/admin/pdf-tools/sign.
// Multipart parts: exactly one `pdf` file + exactly one `signature` image
// (PNG/JPG) + `page`, `position`, `widthPt`. The image is drawn onto the
// page like a stamp. Fully in-memory.
app.get('/admin/pdf-tools/sign', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-sign', {
    user: req.user,
    pdfSignAvailable: isPdfSignAvailable(),
    pdfSignMaxFileMb: PDF_SIGN_MAX_FILE_MB,
    pdfSignMaxImageMb: PDF_SIGN_MAX_IMAGE_MB
  });
});

app.post('/api/admin/pdf-tools/sign', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfSignAvailable()) {
    return res.status(403).json({ error: 'PDF signing is disabled in production. Run the app locally to sign.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfSignMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  const sigParts = parsed.files.filter(f => f.fieldName === 'signature');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  if (sigParts.length === 0) {
    return res.status(400).json({ error: 'Upload one signature image (PNG or JPG).' });
  }
  if (sigParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one signature image at a time.' });
  }
  const pf = pdfParts[0];
  const sf = sigParts[0];
  const selection = validatePdfSignUpload(
    { pdf: { name: pf.filename, size: pf.data.length }, image: { name: sf.filename, size: sf.data.length } }
  );
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_SIGN_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_SIGN_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }
  if (!sf.data.length || sf.data.length > PDF_SIGN_MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: `Signature image is empty or exceeds ${PDF_SIGN_MAX_IMAGE_MB} MB.` });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedOpts = validatePdfSignOptions({
    position: fieldText('position'),
    widthPt: fieldText('widthPt'),
    page: fieldText('page')
  });
  if (!checkedOpts.ok) return res.status(400).json({ error: checkedOpts.error });

  let outBuf;
  try {
    outBuf = await signPdf(
      {
        pdf: { bytes: pf.data, name: pf.filename },
        image: { bytes: sf.data, name: sf.filename }
      },
      checkedOpts.options
    );
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to sign PDF.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Signing produced no output.' });
  }
  const downloadName = signDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone Header/Footer utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/header-footer.
// API: POST /api/admin/pdf-tools/header-footer.
// Multipart parts: exactly one `pdf` file + `scope` (all|range) +
// `selection` (range mode) + `header`, `footer` ({page}/{total} tokens),
// `align`, `fontSize`. Text is drawn onto pages (content otherwise
// untouched). Fully in-memory.
app.get('/admin/pdf-tools/header-footer', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-header-footer', {
    user: req.user,
    pdfHeaderFooterAvailable: isPdfHeaderFooterAvailable(),
    pdfHeaderFooterMaxFileMb: PDF_HEADER_FOOTER_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/header-footer', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfHeaderFooterAvailable()) {
    return res.status(403).json({ error: 'Headers/footers are disabled in production. Run the app locally.' });
  }
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = pdfHeaderFooterMaxRequestBytes();
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  const selection = validatePdfHeaderFooterUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (!pf.data.length || pf.data.length > PDF_HEADER_FOOTER_MAX_FILE_BYTES) {
    return res.status(400).json({ error: `PDF file is empty or exceeds ${PDF_HEADER_FOOTER_MAX_FILE_MB} MB.` });
  }
  if (!isAllowedPdfInput(pf.filename)) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  const checkedOpts = validatePdfHeaderFooterOptions({
    header: fieldText('header'),
    footer: fieldText('footer'),
    align: fieldText('align'),
    fontSize: fieldText('fontSize')
  });
  if (!checkedOpts.ok) return res.status(400).json({ error: checkedOpts.error });

  let outBuf;
  try {
    outBuf = await addHeaderFooter(pf.data, {
      ...checkedOpts.options,
      scope: fieldText('scope'),
      selectionText: fieldText('selection')
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to add header/footer.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Header/footer produced no output.' });
  }
  const downloadName = headerFooterDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Standalone PDF to Text utility (admin-only). Deliberately separate from all
// other PDF routes above: no existing code paths are touched. Selectable text
// only — no OCR is performed or claimed.
// Page: GET /admin/pdf-tools/pdf-to-text.
// API: POST /api/admin/pdf-tools/pdf-to-text/info — multipart `pdf` file +
//   `scope` (all|range) + `selection` (range mode); responds JSON
//   { text, pages: [{ page, chars }], pageCount }.
// API: POST /api/admin/pdf-tools/pdf-to-text/download — same parts;
//   responds text/plain `<original>.txt` with X-Text-Pages/X-Text-Chars.
// Fully in-memory.
app.get('/admin/pdf-tools/pdf-to-text', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-text', {
    user: req.user,
    pdfTextAvailable: isPdfTextAvailable(),
    pdfTextMaxFileMb: PDF_TEXT_MAX_FILE_MB
  });
});

app.post('/api/admin/pdf-tools/pdf-to-text/info', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfTextAvailable()) {
    return res.status(403).json({ error: 'PDF to Text is disabled in production. Run the app locally to extract.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfTextMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfTextUpload, PDF_TEXT_MAX_FILE_BYTES, PDF_TEXT_MAX_FILE_MB);
  if (!pf) return;
  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  try {
    const result = await extractPdfText(pf.data, { scope: fieldText('scope'), selectionText: fieldText('selection') });
    res.json({ text: result.text, pages: result.pages, pageCount: result.pageCount });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to extract text.' });
  }
});

app.post('/api/admin/pdf-tools/pdf-to-text/download', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfTextAvailable()) {
    return res.status(403).json({ error: 'PDF to Text is disabled in production. Run the app locally to extract.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfTextMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfTextUpload, PDF_TEXT_MAX_FILE_BYTES, PDF_TEXT_MAX_FILE_MB);
  if (!pf) return;
  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : '';
  };
  let result;
  try {
    result = await extractPdfText(pf.data, { scope: fieldText('scope'), selectionText: fieldText('selection') });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to extract text.' });
  }
  const outBuf = Buffer.from(result.text, 'utf8');
  const downloadName = textDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName,
    'X-Text-Pages': String(result.pages.length),
    'X-Text-Chars': String(outBuf.length)
  });
  res.end(outBuf);
});

// Standalone PDF Metadata utility (admin-only). Deliberately separate from
// all other PDF routes above: no existing code paths are touched.
// Page: GET /admin/pdf-tools/metadata.
// API: POST /api/admin/pdf-tools/metadata/info — multipart `pdf` file,
//   responds JSON with the current title/author/subject/keywords/creator/
//   producer (missing values come back null, keywords as an array).
// API: POST /api/admin/pdf-tools/metadata/apply — multipart `pdf` file plus
//   any of the six fields (empty string clears). Responds with a NEW PDF that
//   differs only in metadata. Fully in-memory.
app.get('/admin/pdf-tools/metadata', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-pdf-metadata', {
    user: req.user,
    pdfMetadataAvailable: isPdfMetadataAvailable(),
    pdfMetadataMaxFileMb: PDF_METADATA_MAX_FILE_MB
  });
});

async function readPdfUploadBody(req, res, maxRequestBytes) {
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    res.status(400).json({ error: 'Expected multipart/form-data.' });
    return null;
  }
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    res.status(413).json({ error: 'Upload too large.' });
    return null;
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        res.status(413).json({ error: 'Upload too large.' });
        return null;
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    res.status(400).json({ error: 'Unable to read upload.' });
    return null;
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    res.status(400).json({ error: 'Unable to parse upload.' });
    return null;
  }
  return parsed;
}

function singlePdfPart(parsed, res, validateUpload, maxFileBytes, maxFileMb) {
  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    res.status(400).json({ error: 'Upload one PDF file.' });
    return null;
  }
  if (pdfParts.length > 1) {
    res.status(400).json({ error: 'Upload only one PDF file at a time.' });
    return null;
  }
  const pf = pdfParts[0];
  const selection = validateUpload({ name: pf.filename, size: pf.data.length });
  if (!selection.ok) {
    res.status(400).json({ error: selection.error });
    return null;
  }
  if (!pf.data.length || pf.data.length > maxFileBytes) {
    res.status(400).json({ error: `PDF file is empty or exceeds ${maxFileMb} MB.` });
    return null;
  }
  if (!isAllowedPdfInput(pf.filename)) {
    res.status(400).json({ error: 'Source file must be .pdf.' });
    return null;
  }
  return pf;
}

app.post('/api/admin/pdf-tools/metadata/info', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfMetadataAvailable()) {
    return res.status(403).json({ error: 'PDF metadata is disabled in production. Run the app locally to edit.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfMetadataMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfMetadataUpload, PDF_METADATA_MAX_FILE_BYTES, PDF_METADATA_MAX_FILE_MB);
  if (!pf) return;
  try {
    res.json({ metadata: await getPdfMetadata(pf.data) });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to read metadata.' });
  }
});

app.post('/api/admin/pdf-tools/metadata/apply', requireApiAuth, requireAdmin, async (req, res) => {
  if (!isPdfMetadataAvailable()) {
    return res.status(403).json({ error: 'PDF metadata is disabled in production. Run the app locally to edit.' });
  }
  const parsed = await readPdfUploadBody(req, res, pdfMetadataMaxRequestBytes());
  if (!parsed) return;
  const pf = singlePdfPart(parsed, res, validatePdfMetadataUpload, PDF_METADATA_MAX_FILE_BYTES, PDF_METADATA_MAX_FILE_MB);
  if (!pf) return;
  const fieldText = name => {
    const raw = parsed.fields[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === 'string' ? text : undefined;
  };
  const incoming = {};
  for (const key of ['title', 'author', 'subject', 'keywords', 'creator', 'producer']) {
    const v = fieldText(key);
    if (v !== undefined) incoming[key] = v;
  }
  const checked = validatePdfMetadataFields(incoming);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  let outBuf;
  try {
    outBuf = await setPdfMetadata(pf.data, checked.fields);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Unable to edit metadata.' });
  }
  if (!outBuf || outBuf.length === 0) {
    return res.status(500).json({ error: 'Metadata edit produced no output.' });
  }
  const downloadName = metadataDownloadName(pf.filename);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': outBuf.length,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'X-Export-Filename': downloadName
  });
  res.end(outBuf);
});

// Developer Tools: Guidewire SQL Log Parameter Stitcher
app.get('/admin/developer-tools/sql-stitcher', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-sql-stitcher', {
    user: req.user,
    currentUrl: '/admin/developer-tools/sql-stitcher'
  });
});

// Developer Tools: Integration Payload Decoder
app.get('/admin/developer-tools/payload-decoder', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-payload-decoder', {
    user: req.user,
    currentUrl: '/admin/developer-tools/payload-decoder'
  });
});

// Developer Tools: Gosu / Java Stack Trace Analyzer
app.get('/admin/developer-tools/stack-analyzer', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-stack-analyzer', {
    user: req.user,
    currentUrl: '/admin/developer-tools/stack-analyzer'
  });
});

// Developer Tools: PDF AcroForm Field Inspector Page
app.get('/admin/developer-tools/pdf-inspector', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-pdf-inspector', {
    user: req.user,
    currentUrl: '/admin/developer-tools/pdf-inspector'
  });
});

// Developer Tools: Generate Synthetic Fillable PDF Sample
app.get('/api/admin/developer-tools/pdf-inspector/sample', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const page1 = pdfDoc.addPage([600, 400]);
    const page2 = pdfDoc.addPage([600, 400]);

    const form = pdfDoc.getForm();

    // 1. Text Field
    const textField = form.createTextField('sample_firstName');
    textField.setText('Gosu Developer');
    textField.addToPage(page1, { x: 50, y: 300, width: 200, height: 30 });

    // 2. Checkbox
    const checkboxField = form.createCheckBox('sample_isActive');
    checkboxField.check();
    checkboxField.addToPage(page1, { x: 50, y: 250, width: 20, height: 20 });

    // 3. Radio Group on Page 2
    const radioGroup = form.createRadioGroup('sample_role');
    radioGroup.addOptionToPage('admin', page2, { x: 50, y: 200, width: 20, height: 20 });
    radioGroup.addOptionToPage('user', page2, { x: 50, y: 150, width: 20, height: 20 });
    radioGroup.select('admin');

    // 4. Dropdown on Page 2
    const dropdownField = form.createDropdown('sample_product');
    dropdownField.setOptions(['PolicyCenter', 'ClaimCenter', 'BillingCenter']);
    dropdownField.select('PolicyCenter');
    dropdownField.addToPage(page2, { x: 50, y: 100, width: 150, height: 25 });

    const bytes = await pdfDoc.save();
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="synthetic_fillable_sample.pdf"',
      'Content-Length': bytes.length
    });
    res.end(Buffer.from(bytes));
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate synthetic PDF sample.' });
  }
});

// Developer Tools: PDF AcroForm Field Inspector API (multipart/form-data)
app.post('/api/admin/developer-tools/pdf-inspector', requireApiAuth, requireAdmin, async (req, res) => {
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = 10 * 1024 * 1024; // 10 MB limit for form inspector
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large. Limit is 10 MB.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large. Limit is 10 MB.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const pdfParts = parsed.files.filter(f => f.fieldName === 'pdf');
  if (pdfParts.length === 0) {
    return res.status(400).json({ error: 'Upload one PDF file.' });
  }
  if (pdfParts.length > 1) {
    return res.status(400).json({ error: 'Upload only one PDF file at a time.' });
  }
  const pf = pdfParts[0];
  if (!pf.data.length || pf.data.length > maxRequestBytes) {
    return res.status(400).json({ error: 'PDF file is empty or exceeds 10 MB.' });
  }
  if (!pf.filename.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'Source file must be .pdf.' });
  }

  try {
    const fields = await inspectAcroFormFields(pf.data);
    res.json({
      success: true,
      filename: pf.filename,
      fieldCount: fields.length,
      fields
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to inspect PDF.' });
  }
});

// Developer Tools: JSON / XML / Text Diff Page
app.get('/admin/developer-tools/diff', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-diff', {
    user: req.user,
    currentUrl: '/admin/developer-tools/diff'
  });
});

// Developer Tools: PCF / XML Formatter, Validator & Path Explorer Page
app.get('/admin/developer-tools/pcf-explorer', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-pcf-explorer', {
    user: req.user,
    currentUrl: '/admin/developer-tools/pcf-explorer'
  });
});

// Developer Tools: Guidewire Typelist Generator Page
app.get('/admin/developer-tools/typelist-generator', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-typelist-generator', {
    user: req.user,
    currentUrl: '/admin/developer-tools/typelist-generator'
  });
});

// Developer Tools: DOCX Structural Inspector Page
app.get('/admin/developer-tools/docx-inspector', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-docx-inspector', {
    user: req.user,
    currentUrl: '/admin/developer-tools/docx-inspector'
  });
});

// Developer Tools: File Metadata / Hash Inspector Page
app.get('/admin/developer-tools/hash-inspector', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-hash-inspector', {
    user: req.user,
    currentUrl: '/admin/developer-tools/hash-inspector'
  });
});

// Developer Tools: CSV / TSV Analyzer Page
app.get('/admin/developer-tools/csv-analyzer', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-csv-analyzer', {
    user: req.user,
    currentUrl: '/admin/developer-tools/csv-analyzer'
  });
});

// Developer Tools: Regex Tester Page
app.get('/admin/developer-tools/regex-tester', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-regex-tester', {
    user: req.user,
    currentUrl: '/admin/developer-tools/regex-tester'
  });
});

// Developer Tools: Encoding Converter Page
app.get('/admin/developer-tools/encoding-converter', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-encoding-converter', {
    user: req.user,
    currentUrl: '/admin/developer-tools/encoding-converter'
  });
});

// Developer Tools: JWT Decoder Page
app.get('/admin/developer-tools/jwt-decoder', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-jwt-decoder', {
    user: req.user,
    currentUrl: '/admin/developer-tools/jwt-decoder'
  });
});

// Developer Tools: Timestamp Converter Page
app.get('/admin/developer-tools/timestamp-converter', requireAuth, requireAdmin, async (req, res) => {
  res.render('admin-developer-tools-timestamp-converter', {
    user: req.user,
    currentUrl: '/admin/developer-tools/timestamp-converter'
  });
});

// Developer Tools: Generate Synthetic DOCX Sample File
app.get('/api/admin/developer-tools/docx-inspector/sample', requireAuth, requireAdmin, async (req, res) => {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="Heading1"/>
      </w:pPr>
      <w:r>
        <w:t>Guidewire Claim Template Report</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>This is a synthetic document representing Claim {{ClaimNumber}} with priority level {{ClaimPriority}}.</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>Policyholder details for {{PolicyholderName}} have been validated against our local database.</w:t>
      </w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Column 1 Header</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Column 2 Header</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Claim Status</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>{{ClaimStatus}}</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`);

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': 'attachment; filename="synthetic_word_sample.docx"',
      'Content-Length': buffer.length
    });
    res.end(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate synthetic DOCX sample. ' + err.message });
  }
});

// Developer Tools: DOCX Structural Inspector API (multipart/form-data)
app.post('/api/admin/developer-tools/docx-inspector', requireApiAuth, requireAdmin, async (req, res) => {
  const boundary = getMultipartBoundary(req.get('content-type') || '');
  if (!boundary) {
    return res.status(400).json({ error: 'Expected multipart/form-data.' });
  }
  const maxRequestBytes = 15 * 1024 * 1024;
  const announced = Number(req.get('content-length'));
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    return res.status(413).json({ error: 'Upload too large. Limit is 15 MB.' });
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        return res.status(413).json({ error: 'Upload too large. Limit is 15 MB.' });
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read upload.' });
  }
  let parsed;
  try {
    parsed = parseMultipartForm(body, boundary);
  } catch {
    return res.status(400).json({ error: 'Unable to parse upload.' });
  }
  body = null;

  const docxParts = parsed.files.filter(f => f.fieldName === 'docx');
  if (docxParts.length === 0) {
    return res.status(400).json({ error: 'Upload one DOCX file.' });
  }
  const pf = docxParts[0];
  if (!pf.data.length || pf.data.length > maxRequestBytes) {
    return res.status(400).json({ error: 'DOCX file is empty or exceeds 15 MB.' });
  }
  if (!pf.filename.toLowerCase().endsWith('.docx')) {
    return res.status(400).json({ error: 'Source file must be .docx.' });
  }

  try {
    const mammoth = (await import('mammoth')).default;
    const htmlResult = await mammoth.convertToHtml({ buffer: pf.data });
    const textResult = await mammoth.extractRawText({ buffer: pf.data });

    const html = htmlResult.value;
    const rawText = textResult.value;

    const pCount = (html.match(/<p\b[^>]*>/g) || []).length;
    const headingCount = (html.match(/<h[1-6]\b[^>]*>/g) || []).length;
    const tableCount = (html.match(/<table\b[^>]*>/g) || []).length;
    const linkCount = (html.match(/<a\b[^>]*>/g) || []).length;
    const imageCount = (html.match(/<img\b[^>]*>/g) || []).length;

    const placeholderMatches = Array.from(new Set(rawText.match(/\{\{[^{}\r\n]+\}\}/g) || []));

    res.json({
      success: true,
      filename: pf.filename,
      pCount,
      headingCount,
      tableCount,
      linkCount,
      imageCount,
      placeholders: placeholderMatches,
      extractedText: rawText,
      warnings: htmlResult.messages.map(m => m.message)
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to parse DOCX.' });
  }
});

export { app };
