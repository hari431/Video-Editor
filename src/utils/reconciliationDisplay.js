// Shared formatter for reconciliation timestamps — IST primary, UTC secondary.
// Used by Admin Paid Products display (server EJS + client JS) and verified by tests.
// Requirement: "Sep 17, 2026, 3:00 AM IST (Sep 16, 2026, 9:30 PM UTC)"
export function formatReconciliationDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
    const ist = dt.toLocaleString('en-US', { ...opts, timeZone: 'Asia/Kolkata' });
    const utc = dt.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
    return `${ist} IST (${utc} UTC)`;
  } catch {
    return String(d);
  }
}

// Also export options for direct verification
export const RECONCILIATION_TIMEZONES = { IST: 'Asia/Kolkata', UTC: 'UTC' };
