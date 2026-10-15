// src/config/inactiveDeletion.js — parses USER_INACTIVE_DELETE_DAYS (no hardcoded fallback)
function parsePositiveIntEnv(name, raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || String(n) !== trimmed) return null;
  if (n <= 0) return null;
  return n;
}

export function getInactiveDeleteDays(env = process.env) {
  const raw = env.USER_INACTIVE_DELETE_DAYS;
  const v = parsePositiveIntEnv('USER_INACTIVE_DELETE_DAYS', raw);
  if (v === null) {
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      console.warn(`[inactive-deletion] Invalid USER_INACTIVE_DELETE_DAYS="${String(raw)}" — must be positive integer days. Skipping automatic deletion.`);
    } else {
      console.warn('[inactive-deletion] USER_INACTIVE_DELETE_DAYS not set — automatic user deletion skipped.');
    }
    return null;
  }
  return v;
}

// Configurable daily time for automatic cleanup – default 02:00 IST (UTC+5:30, no DST)
// Env: INACTIVE_DELETE_TIME="HH:MM" (24h), INACTIVE_DELETE_TIMEZONE currently fixed to IST for simplicity
export function parseDeleteTime(timeStr) {
  const raw = String(timeStr || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

export function getInactiveDeleteTime(env = process.env) {
  const raw = env.INACTIVE_DELETE_TIME || env.USER_INACTIVE_DELETE_TIME || '02:00';
  const parsed = parseDeleteTime(raw);
  if (!parsed) {
    console.warn(`[inactive-deletion] Invalid INACTIVE_DELETE_TIME="${String(raw)}" — expected HH:MM. Using default 02:00 IST.`);
    return { hour: 2, minute: 0, raw: '02:00' };
  }
  return { hour: parsed.hour, minute: parsed.minute, raw: `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}` };
}

// Whether scheduler should auto-run destructive cleanup. Disabled in test always.
// In development, requires explicit opt-in via INACTIVE_DELETE_ENABLED=true or USER_INACTIVE_DELETE_ENABLED=true.
// In production, enabled when USER_INACTIVE_DELETE_DAYS is set.
export function isInactiveDeleteAutoEnabled(env = process.env) {
  if ((env.NODE_ENV || '').toLowerCase() === 'test') return false;
  const explicit = String(env.INACTIVE_DELETE_ENABLED || env.USER_INACTIVE_DELETE_ENABLED || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  // Default: only auto-enable in production
  if ((env.NODE_ENV || '').toLowerCase() === 'production') return true;
  return false;
}

export { parsePositiveIntEnv };
