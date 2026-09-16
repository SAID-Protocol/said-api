/**
 * Regression test for the 2026-09-16 production bug: reserves were captured
 * once at the daily registry build, the classifier refuses `backed` on a
 * figure older than six hours, so every real Backed asset read as
 * "issuer-claimed" for eighteen hours of every day.
 *
 * NETWORK: hits Backed's public proof-of-reserves API. Run: npx tsx tests/test-reserve-refresh.ts
 */
import { applyBackedReserves, refreshReserve, type CanonicalAsset } from '../src/asset-passport/issuers.js';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ·  ' + detail : ''}`); if (!ok) failures += 1; };
const ageMin = (r?: CanonicalAsset['reserve'] | null) => r ? Math.round((Date.now() - Date.parse(r.asOf)) / 60000) : Infinity;
const stale = { sharesHeld: 1, circulating: 1, ratio: 1, custodians: [], asOf: '2026-09-15T00:00:00.000Z' };
const tsla: CanonicalAsset = { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', symbol: 'TSLAx', name: 'Tesla xStock', issuer: 'backed', backing: 'backed', reserve: { ...stale } };
const nvda: CanonicalAsset = { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', symbol: 'NVDAx', name: 'NVIDIA xStock', issuer: 'backed', backing: 'backed' };
const ondo: CanonicalAsset = { mint: 'K1', symbol: 'NVDAon', name: 'NVIDIA Ondo', issuer: 'ondo', backing: 'issuer-claimed' };

const n = await applyBackedReserves([tsla, nvda, ondo]);
check('bulk refresh updates every Backed asset in place', n === 2 && ageMin(tsla.reserve) < 120 && ageMin(nvda.reserve) < 120, `updated=${n}, TSLAx ${ageMin(tsla.reserve)} min, NVDAx ${ageMin(nvda.reserve)} min`);
check('bulk refresh leaves non-Backed issuers untouched', ondo.reserve === undefined);
check('refreshed ratio is sane (≥ 0.99, ≤ 2)', !!tsla.reserve && tsla.reserve.ratio >= 0.99 && tsla.reserve.ratio <= 2, `ratio ${tsla.reserve?.ratio.toFixed(4)}`);

tsla.reserve = { ...stale };
const live = await refreshReserve(tsla);
check('single-asset refresh replaces a stale figure with a live one', ageMin(live) < 120 && tsla.reserve?.asOf === live?.asOf, `${ageMin(live)} min old, custodians ${live?.custodians.join(',')}`);
check('single-asset refresh is cached for 5 minutes', (await refreshReserve(tsla)) === live);
check('single-asset refresh is a no-op for non-Backed issuers', (await refreshReserve(ondo)) === null && ondo.reserve === undefined);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
