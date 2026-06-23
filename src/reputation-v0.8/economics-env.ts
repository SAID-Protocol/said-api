/**
 * Launch-economics thresholds for reputation v0.8.
 *
 * These are the market-cap + age thresholds that influence launch scoring
 * and tiering. The exact tuning values are kept out of source and read from
 * environment ONLY — there are deliberately no real-value defaults here.
 * When a threshold is unset the sustained-launch tier-floor and/or the
 * survival gate are DISABLED. This is fail-safe, not silent: a load-time
 * warning fires (see bottom of file) so a missing var is noticed, not
 * swallowed.
 *
 * Set these on BOTH services that touch v0.8:
 *   - the SCORE BACKFILL cron (compute + backfill), AND
 *   - the API (read path) — otherwise the served tier won't match the
 *     computed one.
 *
 * Weight MAGNITUDES (how much a surviving launch / on-chain activity / peer
 * signal contributes to an axis) intentionally stay in code: they're
 * diffuse and meaningless without these thresholds, so on their own they
 * don't reveal the tuning.
 */

/** Parse an env var as a finite number, or null when unset/blank/invalid. */
function envNum(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Market-cap bars (USD) and the age gate (days). Real values live in env.
export const LAUNCH_GOLD_FLOOR_USD = envNum('LAUNCH_GOLD_FLOOR_USD');
export const LAUNCH_PLATINUM_FLOOR_USD = envNum('LAUNCH_PLATINUM_FLOOR_USD');
export const LAUNCH_MID_USD = envNum('LAUNCH_MID_USD');
export const LAUNCH_SURVIVAL_MIN_USD = envNum('LAUNCH_SURVIVAL_MIN_USD');
export const LAUNCH_SUSTAIN_DAYS = envNum('LAUNCH_SUSTAIN_DAYS');

/** The sustained-launch tier-floor needs both mcap bars + the age gate. */
export const LAUNCH_FLOOR_ENABLED =
  LAUNCH_GOLD_FLOOR_USD !== null &&
  LAUNCH_PLATINUM_FLOOR_USD !== null &&
  LAUNCH_SUSTAIN_DAYS !== null;

/** The survival gate (does a launch count at all) needs min mcap + age gate. */
export const LAUNCH_SURVIVAL_ENABLED =
  LAUNCH_SURVIVAL_MIN_USD !== null && LAUNCH_SUSTAIN_DAYS !== null;

// Load-time warning — fail-safe, not silent. Fires once when this module is
// first imported (server / script start), never inside hot loops.
if (!LAUNCH_FLOOR_ENABLED || !LAUNCH_SURVIVAL_ENABLED) {
  const missing = (
    [
      ['LAUNCH_GOLD_FLOOR_USD', LAUNCH_GOLD_FLOOR_USD],
      ['LAUNCH_PLATINUM_FLOOR_USD', LAUNCH_PLATINUM_FLOOR_USD],
      ['LAUNCH_MID_USD', LAUNCH_MID_USD],
      ['LAUNCH_SURVIVAL_MIN_USD', LAUNCH_SURVIVAL_MIN_USD],
      ['LAUNCH_SUSTAIN_DAYS', LAUNCH_SUSTAIN_DAYS],
    ] as const
  )
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  console.warn(
    `[v0.8 launch-economics] thresholds unset (${missing.join(', ')}) — ` +
      `tier-floor=${LAUNCH_FLOOR_ENABLED ? 'on' : 'OFF'}, ` +
      `survival-gate=${LAUNCH_SURVIVAL_ENABLED ? 'on' : 'OFF'}. ` +
      `Set them on this service to enable launch scoring.`,
  );
}
