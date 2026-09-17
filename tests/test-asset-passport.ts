/**
 * Asset passport — the verdict rules, on the real cases measured 2026-09-13.
 * Pure, no network. Run: npx tsx tests/test-asset-passport.ts
 */
import { verdictFor, detectImpersonation, disclosureFor, type MarketView } from '../src/asset-passport/classify.js';
import type { CanonicalAsset } from '../src/asset-passport/issuers.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) failures += 1;
}
const NOW = Date.parse('2026-09-13T18:00:00Z');
const fresh = '2026-09-13T17:51:35.350Z';
const stale = '2026-09-01T00:00:00Z';

// The real Tesla xStock, with the reserve figures actually returned today.
const tslax: CanonicalAsset = {
  mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', symbol: 'TSLAx', name: 'Tesla xStock',
  issuer: 'backed', backing: 'backed', isin: 'CH1436219252', underlyingSymbol: 'TSLA',
  underlyingIsin: 'US88160R1014', exchangeMic: 'XNAS',
  reserve: { sharesHeld: 195625, circulating: 195013.005893, ratio: 195625 / 195013.005893, custodians: ['Alpaca'], asOf: fresh },
};
const market = (o: Partial<MarketView>): MarketView => ({ verifiedOnJupiter: false, tags: [], ...o });

check('real xStock with fresh reserves is backed', verdictFor(tslax, null, null, NOW).verdict, 'backed');
check('backed verdict cites the ratio', verdictFor(tslax, null, null, NOW).reasons.some((r) => r.includes('1.0031')), true);
check('backed verdict names the custodian', verdictFor(tslax, null, null, NOW).reasons.some((r) => r.includes('Alpaca')), true);

check('stale reserves downgrade to issuer-claimed',
  verdictFor({ ...tslax, reserve: { ...tslax.reserve!, asOf: stale } }, null, null, NOW).verdict, 'issuer-claimed');
check('missing reserves downgrade to issuer-claimed',
  verdictFor({ ...tslax, reserve: undefined }, null, null, NOW).verdict, 'issuer-claimed');
check('under-collateralised downgrades to issuer-claimed',
  verdictFor({ ...tslax, reserve: { ...tslax.reserve!, sharesHeld: 100, circulating: 200, ratio: 0.5 } }, null, null, NOW).verdict, 'issuer-claimed');

// Issuer-level backing
check('Ondo is issuer-claimed',
  verdictFor({ mint: 'K1', symbol: 'NVDAon', name: 'NVIDIA Ondo', issuer: 'ondo', backing: 'issuer-claimed' }, null, null, NOW).verdict, 'issuer-claimed');
check('PreStocks is issuer-claimed, never synthetic (holdings are unverifiable, not disproven)',
  verdictFor({ mint: 'P1', symbol: 'OPENAI', name: 'OpenAI', issuer: 'prestocks', backing: 'issuer-claimed' }, null, null, NOW).verdict, 'issuer-claimed');
check('PreStocks verdict quotes the terms beside the homepage claim',
  verdictFor({ mint: 'P1', symbol: 'OPENAI', name: 'OpenAI', issuer: 'prestocks', backing: 'issuer-claimed' }, null, null, NOW)
    .reasons.some((r) => r.includes('no legal, equitable or contractual right') && r.includes('backed 1:1')), true);
check('PreStocks verdict never asserts nothing is held',
  !verdictFor({ mint: 'P1', symbol: 'OPENAI', name: 'OpenAI', issuer: 'prestocks', backing: 'issuer-claimed' }, null, null, NOW).reasons.join(' ').match(/nothing (is )?(held|behind)/), true);

// Impersonators — the real ones found on 2026-09-13
const bySymbol = new Map([['tslax', [tslax]], ['nvdax', [{ ...tslax, mint: 'Xsc9qvGR', symbol: 'NVDAx', name: 'NVIDIA xStock' }]]]);
const byName = new Map([['tesla xstock', [tslax]]]);

const fakeExact = detectImpersonation('FAKE1', market({ symbol: 'NVDAx', name: 'NVIDIA xStock', holders: 1, liquidityUsd: 3136, launchpad: 'pump.fun' }), bySymbol, byName);
check('exact ticker collision is detected', fakeExact?.basis, 'exact-symbol');
check('exact ticker collision is an impersonator',
  verdictFor(undefined, market({ symbol: 'NVDAx', holders: 1, liquidityUsd: 3136, launchpad: 'pump.fun' }), fakeExact, NOW).verdict, 'impersonator');
check('impersonator reason says it can be bought',
  verdictFor(undefined, market({ symbol: 'NVDAx', holders: 1, liquidityUsd: 3136 }), fakeExact, NOW).reasons.some((r) => r.includes('can be bought')), true);

const fakeCase = detectImpersonation('FAKE2', market({ symbol: 'TSLAX', name: 'Collection NO. 01' }), bySymbol, byName);
check('casing trick (TSLAX vs TSLAx) is detected', fakeCase?.basis, 'symbol-case');

const fakeName = detectImpersonation('FAKE3', market({ symbol: 'WAT', name: 'Tesla xStock' }), bySymbol, byName);
check('name collision is detected when the symbol differs', fakeName?.basis, 'name');

check('the real mint is never flagged as impersonating itself',
  detectImpersonation(tslax.mint, market({ symbol: 'TSLAx', name: 'Tesla xStock' }), bySymbol, byName), null);

// A plain memecoin
check('an unlisted token with no collision is meme',
  verdictFor(undefined, market({ symbol: 'BONK', name: 'Bonk', launchpad: 'pump.fun' }), null, NOW).verdict, 'meme');

// Disclosure, not risk scoring
check('issuer control powers are disclosed, not scored',
  disclosureFor(null, tslax).some((d) => d.includes('not on their own a sign of risk')), true);
check('a token with no issuer gets no issuer disclosure', disclosureFor(null, undefined).length, 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
