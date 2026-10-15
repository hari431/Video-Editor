-- 037_reconciliation_runs.sql
-- Persistent status for Full Paid Products Reconciliation (manual & scheduled share same table)

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                    BIGSERIAL PRIMARY KEY,
  trigger_source        TEXT NOT NULL CHECK (trigger_source IN ('manual','scheduled')),
  status                TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  checked_users         INTEGER NOT NULL DEFAULT 0,
  grants_created        INTEGER NOT NULL DEFAULT 0,
  grants_revoked        INTEGER NOT NULL DEFAULT 0,
  grants_expired        INTEGER NOT NULL DEFAULT 0,
  subscriptions_expired INTEGER NOT NULL DEFAULT 0,
  users_expired         INTEGER NOT NULL DEFAULT 0,
  roles_granted         INTEGER NOT NULL DEFAULT 0,
  roles_revoked         INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status_started ON reconciliation_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_started_at ON reconciliation_runs(started_at DESC);

-- Helper to keep updated_at fresh
CREATE OR REPLACE FUNCTION update_reconciliation_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reconciliation_runs_updated_at ON reconciliation_runs;
CREATE TRIGGER trg_reconciliation_runs_updated_at
  BEFORE UPDATE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION update_reconciliation_runs_updated_at();
