#!/usr/bin/env node
// scripts/cleanup.js — Manual retention cleanup CLI
// Usage:
//   node scripts/cleanup.js --dry-run          # counts only, no deletes
//   node scripts/cleanup.js                    # runs according to env (RETENTION_DRY_RUN etc)
//   RETENTION_ENABLED=true RETENTION_DRY_RUN=true node scripts/cleanup.js
import 'dotenv/config';
import { getRetentionConfig } from '../src/config/retention.js';
import { runRetentionCleanup } from '../src/cleanup/retention.js';

const args = process.argv.slice(2);
const cliDryRun = args.includes('--dry-run') ? true : args.includes('--no-dry-run') ? false : null;

async function main() {
  const cfg = getRetentionConfig();
  // CLI --dry-run overrides env for one-off safety
  const effectiveDryRun = cliDryRun !== null ? cliDryRun : cfg.dryRun;
  console.log('[retention] Manual run');
  console.log(`[retention] Config: enabled=${cfg.enabled} dryRun=${effectiveDryRun} (env dryRun=${cfg.dryRun}) batch=${cfg.batchSize}`);
  console.log(`[retention] Per-table: query_usage=${cfg.queryUsageDays} video_views=${cfg.videoViewsDays} video_protection_sessions=${cfg.videoProtectionSessionsDays} recently_viewed=${cfg.recentlyViewedDays} daily_usage=${cfg.dailyUsageDays} del_disc=${cfg.deletedDiscussionsDays} del_rep=${cfg.deletedRepliesDays}`);
  if (!cfg.enabled) {
    console.log('[retention] Note: RETENTION_ENABLED != true — cleanup will be reported as skipped (use RETENTION_ENABLED=true to allow deletes, or dry-run still shows counts only when enabled? Current behavior: disabled skips all).');
  }
  // For manual dry-run we want to show counts even if RETENTION_ENABLED not set; force enabled semantics via call
  // But spec says Missing RETENTION_ENABLED should skip; CLI lets operator decide: if user passed --dry-run we honour it and run with forced enabled=false still reports skip.
  // To allow pre-enabling dry-run without touching prod env, we treat manual run with --dry-run as enabled override.
  let configOverride = cfg;
  if (cliDryRun === true && !cfg.enabled) {
    // Force enabled for dry-run visibility without persisting env change
    configOverride = { ...cfg, enabled: true };
    console.log('[retention] CLI --dry-run: forcing enabled=true for visibility (env still disabled, no deletes will occur due to dryRun).');
  }
  const result = await runRetentionCleanup({ config: configOverride, dryRun: effectiveDryRun });
  console.log('[retention] Result:', JSON.stringify(result, null, 2));
  if (result.skipped && result.reason === 'retention_disabled') {
    console.log('[retention] No tables cleaned — enable with RETENTION_ENABLED=true and set per-table *_RETENTION_DAYS vars.');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[retention] Manual cleanup failed:', err);
  process.exit(1);
});
