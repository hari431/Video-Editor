export function isLunaEnabled() {
  return String(process.env.LUNA_ENABLED || 'false').trim().toLowerCase() === 'true';
}
