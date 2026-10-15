import { Pool } from 'pg';
import { readExpenseData as readLegacyExpenseData, writeExpenseData as writeLegacyExpenseData, validateExpenseData } from './store.js';

let pool;
let ready;
const PURPOSE_UPSERT_SQL = `
  INSERT INTO expense_tracker_fund_purposes (account_name, account_key, fund_name, fund_key, isin, purpose)
  VALUES ($1, lower(trim($1)), $2, lower(trim(COALESCE(NULLIF($3, ''), $2))), $3, $4)
  ON CONFLICT (account_key, fund_key)
  DO UPDATE SET isin = EXCLUDED.isin, purpose = EXCLUDED.purpose, updated_at = NOW()
`;

function localDatabaseConfig() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Expense Tracker database is available only in local development.');
  const raw = String(process.env.EXPENSE_TRACKER_DATABASE_URL || '').trim();
  if (!raw) throw new Error('Local database setup required: configure EXPENSE_TRACKER_DATABASE_URL for a dedicated local PostgreSQL database.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('EXPENSE_TRACKER_DATABASE_URL is not a valid PostgreSQL connection URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // A URL without "//" after the scheme parses into an opaque path with no host at all;
  // report that as a malformed URL instead of claiming a remote host was blocked.
  if (!host) throw new Error('EXPENSE_TRACKER_DATABASE_URL is malformed. Expected postgres://postgres:PASSWORD@localhost:5432/DATABASE_NAME.');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Expense Tracker database must use a localhost PostgreSQL host. Remote database hosts are blocked.');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expense Tracker requires a PostgreSQL connection URL.');
  return raw;
}
function getPool() {
  if (!pool) pool = new Pool({ connectionString: localDatabaseConfig(), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 3000 });
  return pool;
}
async function ensureReady() {
  if (!ready) ready = (async () => {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS expense_tracker_workspace (
        workspace_id SMALLINT PRIMARY KEY CHECK (workspace_id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS expense_tracker_fund_purposes (
        account_name TEXT NOT NULL,
        account_key TEXT NOT NULL,
        fund_name TEXT NOT NULL,
        fund_key TEXT NOT NULL,
        isin TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_key, fund_key)
      );
      CREATE INDEX IF NOT EXISTS expense_tracker_workspace_updated_idx ON expense_tracker_workspace (updated_at);
      CREATE TABLE IF NOT EXISTS expense_tracker_monthly_entries (
        month DATE NOT NULL, person TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('income','expenses')),
        entry_index INTEGER NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0), note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Unknown',
        PRIMARY KEY (month, person, entry_type, entry_index)
      );
      ALTER TABLE expense_tracker_monthly_entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Unknown';

      CREATE TABLE IF NOT EXISTS expense_tracker_bank_balances (
        month DATE NOT NULL, account_name TEXT NOT NULL, opening_balance NUMERIC(14,2) NOT NULL,
        closing_balance NUMERIC(14,2) NOT NULL, note TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (month, account_name)
      );
      CREATE TABLE IF NOT EXISTS expense_tracker_broker_funds (
        month DATE NOT NULL, person TEXT NOT NULL, account_name TEXT NOT NULL,
        description TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
        note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Unknown',
        PRIMARY KEY (month, person, description)
      );
      ALTER TABLE expense_tracker_broker_funds ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Unknown';

      CREATE TABLE IF NOT EXISTS expense_tracker_templates (
        template_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expenses', 'brokerFunds')),
        category TEXT NOT NULL DEFAULT 'Other',
        person TEXT NOT NULL DEFAULT 'You',
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS expense_tracker_imports (
        import_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source TEXT NOT NULL,
        asset_type TEXT NOT NULL CHECK (asset_type IN ('stock','mutualFund')),
        report_month DATE, imported_at TIMESTAMPTZ NOT NULL, row_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS expense_tracker_holding_rows (
        import_id BIGINT NOT NULL REFERENCES expense_tracker_imports(import_id) ON DELETE CASCADE,
        row_index INTEGER NOT NULL, account_name TEXT NOT NULL, instrument TEXT NOT NULL, isin TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR','USD')), units NUMERIC(20,6) NOT NULL DEFAULT 0, average_price NUMERIC(16,4) NOT NULL DEFAULT 0,
        current_price NUMERIC(16,4) NOT NULL DEFAULT 0, invested_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
        current_value NUMERIC(16,2) NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (import_id, row_index)
      );
      ALTER TABLE expense_tracker_holding_rows ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
      CREATE INDEX IF NOT EXISTS expense_tracker_holdings_account_idx ON expense_tracker_holding_rows (account_name, instrument);
      CREATE INDEX IF NOT EXISTS expense_tracker_imports_date_idx ON expense_tracker_imports (report_month, imported_at);
    `);
    const existing = await db.query('SELECT 1 FROM expense_tracker_workspace WHERE workspace_id = 1');
    if (!existing.rowCount) {
      // One-time migration from the prior ignored local JSON store; never reads the app's DATABASE_URL.
      const legacy = validateExpenseData(await readLegacyExpenseData());
      await db.query('INSERT INTO expense_tracker_workspace (workspace_id, data) VALUES (1, $1::jsonb) ON CONFLICT (workspace_id) DO NOTHING', [JSON.stringify(legacy)]);
      await persistFundPurposes(db, legacy);
      await syncNormalizedTables(db, legacy);
    }
  })().catch(err => { ready = null; throw err; });
  return ready;
}
async function persistFundPurposes(db, data) {
  for (const report of data.imports || []) {
    if (report.assetType !== 'mutualFund') continue;
    for (const row of report.rows || []) {
      const account = clean(row.account || report.source), fund = clean(row.symbol), isin = clean(row.isin);
      if (!account || !fund) continue;
      await db.query(PURPOSE_UPSERT_SQL, [account, fund, isin, clean(row.purpose).slice(0, 250)]);
    }
  }
}
async function syncNormalizedTables(db, data) {
  await db.query('DELETE FROM expense_tracker_monthly_entries');
  await db.query('DELETE FROM expense_tracker_bank_balances');
  await db.query('DELETE FROM expense_tracker_broker_funds');
  await db.query('DELETE FROM expense_tracker_templates');
  await db.query('DELETE FROM expense_tracker_imports');
  for (const [month, record] of Object.entries(data.months || {})) {
    const date = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : null;
    if (!date) continue;
    for (const [person, p] of Object.entries(record.people || {})) {
      for (const type of ['income', 'expenses']) {
        for (const [entryIndex, entry] of (p[type] || []).entries()) {
          await db.query(`INSERT INTO expense_tracker_monthly_entries (month,person,entry_type,entry_index,description,category,amount,note,status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [date, person, type, entryIndex, entry.description, entry.category, entry.amount, entry.note, entry.status || 'Unknown']);
        }
      }
    }
    for (const bank of record.bankBalances || []) {
      if (!bank.account) continue;
      await db.query(`INSERT INTO expense_tracker_bank_balances (month,account_name,opening_balance,closing_balance,note)
        VALUES ($1,$2,$3,$4,$5)`, [date, bank.account, bank.opening, bank.closing, bank.note]);
    }
    for (const broker of record.brokerFunds || []) {
      if (!broker.description && !broker.account) continue;
      await db.query(`INSERT INTO expense_tracker_broker_funds (month,person,account_name,description,amount,note,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (month, person, description) DO UPDATE SET account_name = EXCLUDED.account_name, amount = EXCLUDED.amount, note = EXCLUDED.note, status = EXCLUDED.status`,
        [date, broker.person || 'Household', broker.account || broker.description || 'Broker Funds', broker.description || broker.account || 'Broker Funds', broker.amount, broker.note || '', broker.status || 'Unknown']);
    }
  }
  for (const [index, tpl] of (data.templates || []).entries()) {
    await db.query(`INSERT INTO expense_tracker_templates (template_id, description, entry_type, category, person, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (template_id) DO UPDATE SET description = EXCLUDED.description, entry_type = EXCLUDED.entry_type, category = EXCLUDED.category, person = EXCLUDED.person, sort_order = EXCLUDED.sort_order`,
      [tpl.id || `tpl_${index + 1}`, tpl.description, tpl.type || 'expenses', tpl.category || 'Other', tpl.person || 'You', index]);
  }
  for (const report of data.imports || []) {
    const reportDate = /^\d{4}-(0[1-9]|1[0-2])$/.test(report.month) ? `${report.month}-01` : null;
    const importedAt = Number.isFinite(Date.parse(report.importedAt)) ? new Date(report.importedAt).toISOString() : new Date().toISOString();
    const inserted = await db.query(`INSERT INTO expense_tracker_imports (source,asset_type,report_month,imported_at,row_count)
      VALUES ($1,$2,$3,$4,$5) RETURNING import_id`, [report.source, report.assetType === 'mutualFund' ? 'mutualFund' : 'stock', reportDate, importedAt, report.rows.length]);
    const importId = inserted.rows[0].import_id;
    for (const [rowIndex, row] of report.rows.entries()) {
      await db.query(`INSERT INTO expense_tracker_holding_rows
        (import_id,row_index,account_name,instrument,isin,currency,units,average_price,current_price,invested_amount,current_value,purpose)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [importId, rowIndex, row.account || report.source, row.symbol, row.isin || '', row.currency === 'USD' ? 'USD' : 'INR', row.units ?? row.quantity ?? 0,
        row.averagePrice || 0, row.currentPrice || 0, row.invested || 0, row.currentValue || 0, row.purpose || '']);
    }
  }
}
function clean(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 250); }

export async function readExpenseData() {
  await ensureReady();
  const db = getPool();
  const result = await db.query('SELECT data FROM expense_tracker_workspace WHERE workspace_id = 1');
  const data = validateExpenseData(result.rows[0]?.data || await readLegacyExpenseData());
  const purposes = await db.query('SELECT account_name, fund_name, isin, purpose FROM expense_tracker_fund_purposes');
  const map = new Map(purposes.rows.map(row => [`${row.account_name.toLowerCase()}\u0000${String(row.isin || row.fund_name).toLowerCase()}`, row]));
  for (const report of data.imports || []) {
    if (report.assetType !== 'mutualFund') continue;
    for (const row of report.rows || []) {
      const purpose = map.get(`${clean(row.account || report.source).toLowerCase()}\u0000${clean(row.isin || row.symbol).toLowerCase()}`);
      if (purpose) { row.purpose = purpose.purpose; if (!row.isin) row.isin = purpose.isin; }
    }
  }
  return data;
}
export async function writeExpenseData(value) {
  const data = validateExpenseData(value);
  await ensureReady();
  const db = getPool(), client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO expense_tracker_workspace (workspace_id, data, updated_at) VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (workspace_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify(data)]);
    await persistFundPurposes(client, data);
    await syncNormalizedTables(client, data);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  return data;
}
export async function closeExpenseTrackerPool() {
  if (pool) { const old = pool; pool = null; ready = null; await old.end(); }
}
