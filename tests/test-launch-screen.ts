/**
 * Launch screen — verdict rules, exercised on the six real launcher profiles
 * measured on StonkFun on 2026-09-11 plus the edge cases the rules exist for.
 * No network. Run: npx tsx tests/test-launch-screen.ts
 */
import { judge, type LauncherHistory, type LauncherIdentity, type TokenSafety } from '../src/launch-screen.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) failures += 1;
}

const h = (o: Partial<LauncherHistory>): LauncherHistory => ({ walletAgeHours: 100 * 24, truncated: false, firstTxAt: null, txCount: 500, fundedBy: null, openLaunchPools: 0, ...o });
const anon: LauncherIdentity = { registered: false, verified: false, tier: 'unranked', score: null, scored: false, staked: false, stakeSol: 0, slashed: false, badge: 'unverified' };
const verifiedStaked: LauncherIdentity = { ...anon, registered: true, verified: true, tier: 'gold', score: 82, scored: true, staked: true, stakeSol: 0.1, badge: 'verified-launcher' };
const fresh: TokenSafety = { available: false, flags: [], risk: 'unknown', reason: 'no GoPlus record yet' };
const honeypot: TokenSafety = { available: true, flags: ['mint authority live (supply can inflate)', 'freeze authority live (accounts can be frozen)'], risk: 'high' };

// The six real profiles from the 17:40 UTC scan
check('6-minute-old bot wallet (AgmLJ…) is high-risk',
  judge(h({ walletAgeHours: 0.1, txCount: 5000, truncated: true }), anon, fresh).verdict, 'high-risk');
check('3-day-old bot-scale wallet (C4grM…, HOODx) is caution',
  judge(h({ walletAgeHours: 3 * 24, txCount: 5000, truncated: true }), anon, fresh).verdict, 'caution');
check('240-day bot-scale wallet with a funder (DBALL…, SPCXx) is caution',
  judge(h({ walletAgeHours: 240 * 24, txCount: 5000, truncated: true, fundedBy: '4YgX7Wkp' }), anon, fresh).verdict, 'caution');
check('211-day human-scale wallet (FMyBk…) with no identity is caution (unregistered, under 90d? no — 211d) → clear',
  judge(h({ walletAgeHours: 211 * 24, txCount: 634 }), anon, fresh).verdict, 'clear');

// The carrot: verified identity clears soft flags but not hard ones
check('3-day-old wallet becomes clear once SAID-verified with stake',
  judge(h({ walletAgeHours: 3 * 24, txCount: 400 }), verifiedStaked, fresh).verdict, 'clear');
check('verified identity does NOT clear a 6-minute-old wallet',
  judge(h({ walletAgeHours: 0.1, txCount: 50 }), verifiedStaked, fresh).verdict, 'high-risk');
check('verified identity does NOT clear a honeypot token',
  judge(h({ walletAgeHours: 300 * 24, txCount: 200 }), verifiedStaked, honeypot).verdict, 'high-risk');
check('a slashed launcher is high-risk regardless of history',
  judge(h({}), { ...verifiedStaked, slashed: true }, fresh).verdict, 'high-risk');

// Serial launcher + unknowns
check('four open launch pools is caution',
  judge(h({ openLaunchPools: 4 }), anon, fresh).verdict, 'caution');
check('unknown history is never clear for an anonymous launcher',
  judge(h({ walletAgeHours: null, txCount: 0 }), anon, null).verdict, 'caution');
check('unknown history still returns the reason',
  judge(h({ walletAgeHours: null, txCount: 0 }), anon, null).reasons.includes('launcher history unavailable'), true);
check('unknown history IS cleared by a verified identity',
  judge(h({ walletAgeHours: null, txCount: 0 }), verifiedStaked, null).verdict, 'clear');
check('reasons name the clearing when identity clears history',
  judge(h({ walletAgeHours: 2 * 24, txCount: 100 }), verifiedStaked, fresh).reasons.some((r) => r.includes('cleared by verified identity')), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
