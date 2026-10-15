import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

// --- Schema inspection helpers ---

async function tableExists(client, tableName) {
  const r = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists`,
    [tableName]
  );
  return r.rows[0]?.exists === true;
}

async function columnExists(client, tableName, columnName) {
  const r = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS exists`,
    [tableName, columnName]
  );
  return r.rows[0]?.exists === true;
}

async function columnIsNullable(client, tableName, columnName) {
  const r = await client.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  if (r.rows.length === 0) return false;
  return r.rows[0].is_nullable === 'YES';
}

// Per-migration schema check: returns true if the migration's effects are already present
export async function isMigrationAppliedBySchema(client, filename) {
  try {
    switch (filename) {
      case '001_initial.sql':
        return (await tableExists(client, 'users')) && (await tableExists(client, 'query_usage'));
      case '002_status_and_audit.sql':
        return (await columnExists(client, 'users', 'status')) && (await tableExists(client, 'access_audit_log'));
      case '003_admin_protection.sql':
        // 003 makes access_expires_at nullable (001 had NOT NULL)
        return await columnIsNullable(client, 'users', 'access_expires_at');
      case '004_video_views_likes.sql':
        return await tableExists(client, 'video_views');
      case '005_item_likes_generalize.sql':
        return await tableExists(client, 'item_likes');
      case '006_folder_permissions.sql':
        return await tableExists(client, 'folder_permissions');
      case '007_rbac.sql':
        return (await tableExists(client, 'roles')) && (await columnExists(client, 'folder_permissions', 'access_level'));
      case '008_discussions.sql':
        return (await tableExists(client, 'discussions')) && (await tableExists(client, 'discussion_replies'));
      case '009_discussions_moderation_enhancements.sql':
        return (await columnExists(client, 'discussions', 'deleted_at')) && (await columnExists(client, 'discussion_replies', 'deleted_at'));
      case '010_discussions_audit_and_restore.sql':
        return await tableExists(client, 'discussion_moderation_actions');
      case '011_app_roles.sql':
        return (await columnExists(client, 'users', 'app_role')) && (await tableExists(client, 'role_audit_log'));
      case '012_accepted_answer.sql':
        // 012 added discussions.accepted_reply_id; 013 replaces it with discussion_replies.accepted_at
        // After 013, 012 should be considered applied even though column is dropped
        return (await columnExists(client, 'discussions', 'accepted_reply_id')) || (await columnExists(client, 'discussion_replies', 'accepted_at'));
      case '013_multiple_accepted_answers.sql':
        return await columnExists(client, 'discussion_replies', 'accepted_at');
      case '014_recently_viewed.sql':
        return await tableExists(client, 'recently_viewed');
      case '015_content_seen.sql':
        return await tableExists(client, 'content_seen');
      case '016_content_ignore.sql':
        return await columnExists(client, 'content_seen', 'status');
      case '017_content_action_permissions.sql':
        return await tableExists(client, 'content_action_permissions');
      case '018_daily_usage_history.sql':
        return await tableExists(client, 'daily_usage_stats');
      case '019_ad_eligibility.sql':
        return await tableExists(client, 'ad_settings');
      case '020_retention_indexes.sql': {
        const r = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_video_views_viewed_at'`);
        return r.rowCount > 0;
      }
      case '021_add_premium_role.sql': {
        const r = await client.query(`
          SELECT pg_get_constraintdef(oid) as def 
          FROM pg_constraint 
          WHERE conname = 'chk_users_app_role'
        `);
        return r.rowCount > 0 && r.rows[0].def.includes('PREMIUM');
      }
      case '022_premium_membership.sql': {
        return await tableExists(client, 'premium_subscriptions');
      }
      case '023_premium_one_time_promotions.sql': {
        return await tableExists(client, 'premium_promo_redemptions');
      }
      case '024_paid_products_framework.sql': {
        return (await tableExists(client, 'paid_products')) && (await tableExists(client, 'user_product_grants'));
      }
      case '025_paid_product_promotions.sql': {
        return (await tableExists(client, 'paid_product_promotions')) && (await tableExists(client, 'paid_product_promo_redemptions'));
      }
      case '026_role_ads_available.sql': {
        return await columnExists(client, 'roles', 'ads_available');
      }
      case '027_add_expired_status_and_audit.sql': {
        const rUsers = await client.query(`
          SELECT pg_get_constraintdef(oid) as def 
          FROM pg_constraint 
          WHERE conname = 'chk_users_status'
        `);
        const rAudit = await client.query(`
          SELECT pg_get_constraintdef(oid) as def 
          FROM pg_constraint 
          WHERE conname = 'chk_access_audit_log_action'
        `);
        return (
          rUsers.rowCount > 0 &&
          rUsers.rows[0].def.includes('expired') &&
          rAudit.rowCount > 0 &&
          rAudit.rows[0].def.includes('expire')
        );
      }
      case '028_add_pending_and_approved_to_discussions.sql': {
        const r = await client.query(`
          SELECT pg_get_constraintdef(oid) as def 
          FROM pg_constraint 
          WHERE conname = 'discussions_status_check'
        `);
        return r.rowCount > 0 && r.rows[0].def.includes('pending');
      }
      case '029_discussions_nested_and_likes.sql': {
        return (await columnExists(client, 'discussion_replies', 'parent_id')) && (await tableExists(client, 'discussion_likes'));
      }
      case '030_default_roles.sql': {
        return await columnExists(client, 'roles', 'default_role');
      }
      case '031_user_lifecycle_audit.sql': {
        const rAudit = await client.query(`
          SELECT pg_get_constraintdef(oid) as def 
          FROM pg_constraint 
          WHERE conname = 'chk_access_audit_log_action'
        `);
        return (
          rAudit.rowCount > 0 &&
          rAudit.rows[0].def.includes('register') &&
          rAudit.rows[0].def.includes('delete') &&
          (await columnExists(client, 'access_audit_log', 'details'))
        );
      }
      case '032_interview_question_notes.sql': {
        return await tableExists(client, 'interview_question_notes');
      }
      case '033_role_notes_permission.sql': {
        return await columnExists(client, 'roles', 'notes_available');
      }
      case '038_capacity_restriction.sql': {
        return await columnExists(client, 'paid_products', 'max_active_members');
      }
      case '039_p2_performance_indexes.sql': {
        const r = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_users_created_at_desc'`);
        return r.rowCount > 0;
      }
      case '040_add_last_activity_at.sql': {
        return await columnExists(client, 'users', 'last_activity_at');
      }
      case '041_video_protection_events.sql': {
        return await tableExists(client, 'video_protection_events');
      }
      case '042_video_protection_sessions.sql': {
        return await tableExists(client, 'video_protection_sessions');
      }
      case '043_share_links.sql': {
        return await tableExists(client, 'share_links');
      }
      case '044_reviews_premium_knowledge.sql': {
        const role = await client.query(
          `SELECT 1 FROM roles WHERE name = 'Reviews - Premium Knowledge' LIMIT 1`
        );
        const folder = await client.query(
          `SELECT 1 FROM folder_permissions
           WHERE folder_path = 'Reviews/Premium Knowledge'
             AND access_level = 'role'
           LIMIT 1`
        );
        const grant = await client.query(
          `SELECT 1 FROM folder_roles fr
           JOIN roles r ON r.id = fr.role_id
           WHERE fr.folder_path = 'Reviews/Premium Knowledge'
             AND r.name = 'Reviews - Premium Knowledge'
           LIMIT 1`
        );
        return role.rowCount > 0 && folder.rowCount > 0 && grant.rowCount > 0;
      }
      default:
        // Unknown future migration: cannot inspect, assume not applied
        return false;
    }
  } catch {
    return false;
  }
}

export async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getAppliedFilenames(client) {
  const r = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(r.rows.map(row => row.filename));
}

export async function runMigrations({ client, migrationsDir: dir = migrationsDir, readdirFn = readdir, readFileFn = readFile } = {}) {
  let pgClient = client;
  let owned = false;
  if (!pgClient) {
    pgClient = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    await pgClient.connect();
    owned = true;
  }

  try {
    await ensureMigrationsTable(pgClient);
    const applied = await getAppliedFilenames(pgClient);
    const files = (await readdirFn(dir)).filter(f => f.endsWith('.sql')).sort();

    if (files.length === 0) {
      console.log('No migrations found.');
      return { applied: [], skipped: [], baselined: [] };
    }

    const result = { applied: [], skipped: [], baselined: [], failed: null };

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping already applied: ${file}`);
        result.skipped.push(file);
        continue;
      }

      // Bootstrap check: if schema already contains this migration's effects, baseline without running SQL
      const alreadyBySchema = await isMigrationAppliedBySchema(pgClient, file);
      if (alreadyBySchema) {
        await pgClient.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        console.log(`Baselined (already in schema): ${file}`);
        result.baselined.push(file);
        continue;
      }

      const sql = await readFileFn(path.join(dir, file), 'utf8');
      await pgClient.query('BEGIN');
      try {
        await pgClient.query(sql);
        await pgClient.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await pgClient.query('COMMIT');
        console.log(`Migration completed: ${file}`);
        result.applied.push(file);
      } catch (error) {
        try { await pgClient.query('ROLLBACK'); } catch {}
        result.failed = file;
        throw new Error(`${file}: ${error.message}`);
      }
    }
    return result;
  } finally {
    if (owned) await pgClient.end();
  }
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  await runMigrations({ migrationsDir });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}
