/**
 * Work loop — the parts that must be exact for panels to agree: the
 * wallet-history summary, its hash, answer validation and the signatures.
 * Pure, no network, no database. Run: npx tsx tests/test-work-loop.ts
 */
import { Keypair } from '@solana/web3.js';
import {
  canonicalResult,
  hashResult,
  isValidSpec,
  summarize,
  type SigInfo,
  type WalletHistorySpec,
} from '../src/work/wallet-history.js';
import { isFresh, signMessage, slotClaimMessage, submitMessage, verifyMessage } from '../src/work/auth.js';
import { loadWorkConfig, panelAgrees } from '../src/work/engine.js';
import { canonicalActivity, hashActivity, summarizeActivity, type TxView } from '../src/work/wallet-activity-job.js';
import { jobKind } from '../src/work/kinds.js';
import { computeShares, unitsFor } from '../src/work/payouts.js';
import { leafHash, merkleProof, merkleRoot, verifyProof } from '../src/work/records.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) failures += 1;
}

const DAY = 86400;
const TO = 1_790_000_000; // window end
const wallet = Keypair.generate().publicKey.toBase58();
const spec: WalletHistorySpec = { wallet, fromTime: TO - 30 * DAY, toTime: TO, maxSignatures: 5 };
const sig = (signature: string, blockTime: number | null, err: unknown = null): SigInfo => ({ signature, blockTime, err });

// Newest-first, as the RPC returns them.
const sigs: SigInfo[] = [
  sig('zz-after-window', TO + 5),
  sig('d', TO - 10),
  sig('c', TO - 20, { InstructionError: [0, 'Custom'] }),
  sig('no-time', null),
  sig('b', TO - 2 * DAY),
  sig('a', TO - 30 * DAY), // exactly on the inclusive edge
  sig('too-old', TO - 30 * DAY - 1),
];

const r = summarize(sigs, spec);
check('counts only signatures inside the window', r.txCount, 4);
check('window end is exclusive', summarize([sig('x', TO)], spec).txCount, 0);
check('failed transactions are counted', r.failedCount, 1);
check('active days are distinct UTC days', r.activeDays, 3);
check('first and last block times', [r.firstBlockTime, r.lastBlockTime], [TO - 30 * DAY, TO - 10]);
check('not truncated under the cap', r.truncated, false);

check('page order does not change the answer', hashResult(summarize([...sigs].reverse(), spec)), hashResult(r));
check('an extra signature changes the answer', hashResult(summarize([...sigs, sig('e', TO - 30)], spec)) === hashResult(r), false);
check('a failed flag changes the answer', hashResult(summarize(sigs.map((s) => ({ ...s, err: null })), spec)) === hashResult(r), false);

const many = Array.from({ length: 8 }, (_, i) => sig(`s${i}`, TO - 100 - i));
const t = summarize(many, spec);
check('over the cap keeps the newest and flags it', [t.txCount, t.truncated, t.lastBlockTime, t.firstBlockTime], [5, true, TO - 100, TO - 104]);

const empty = summarize([], spec);
check('an empty window is a valid answer', [empty.txCount, empty.firstBlockTime, empty.activeDays], [0, null, 0]);

// Answer validation
check('a real answer survives validation unchanged', hashResult(canonicalResult(r, spec)!), hashResult(r));
check('extra fields are stripped, not hashed', hashResult(canonicalResult({ ...r, bonus: 'x' }, spec)!), hashResult(r));
check('an answer for another wallet is rejected', canonicalResult({ ...r, wallet: Keypair.generate().publicKey.toBase58() }, spec), null);
check('an answer for another window is rejected', canonicalResult({ ...r, toTime: TO + 60 }, spec), null);
check('a count above the cap is rejected', canonicalResult({ ...r, txCount: 6 }, spec), null);
check('a malformed digest is rejected', canonicalResult({ ...r, signaturesDigest: 'abc' }, spec), null);
check('a non-object is rejected', canonicalResult('nope', spec), null);

// Specs
check('a good spec is valid', isValidSpec(spec), true);
check('a placeholder wallet is not a valid spec', isValidSpec({ ...spec, wallet: 'SAID_PROTOCOL' }), false);
check('an inverted window is not a valid spec', isValidSpec({ ...spec, fromTime: TO, toTime: TO - 1 }), false);

// Signatures
const agent = Keypair.generate();
const worker = Keypair.generate();
const now = Date.now();
const claimMsg = slotClaimMessage(agent.publicKey.toBase58(), worker.publicKey.toBase58(), now);
const claimSig = signMessage(claimMsg, agent.secretKey);
check('the agent wallet signature binds the worker key', verifyMessage(claimMsg, claimSig, agent.publicKey.toBase58()), true);
check('another wallet cannot claim with it', verifyMessage(claimMsg, claimSig, worker.publicKey.toBase58()), false);
check('a different worker key breaks the signature',
  verifyMessage(slotClaimMessage(agent.publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), now), claimSig, agent.publicKey.toBase58()), false);
const subSig = signMessage(submitMessage('asg1', hashResult(r), now), worker.secretKey);
check('a submit signature covers the result hash',
  verifyMessage(submitMessage('asg1', hashResult(t), now), subSig, worker.publicKey.toBase58()), false);
check('garbage signatures are refused, not thrown', verifyMessage(claimMsg, 'not-base58-!!', agent.publicKey.toBase58()), false);
check('a current timestamp is fresh', isFresh(now, now), true);
check('a six-minute-old timestamp is stale', isFresh(now - 6 * 60 * 1000, now), false);
check('a non-number timestamp is stale', isFresh(String(now), now), false);

// Panels
check('three matching answers agree', panelAgrees(['h', 'h', 'h']), true);
check('one differing answer breaks the panel', panelAgrees(['h', 'h', 'x']), false);
check('a missing answer breaks the panel', panelAgrees(['h', null, 'h']), false);
check('an empty panel does not agree', panelAgrees([]), false);

// Config
check('the loop is closed unless it is switched on', [loadWorkConfig({}).open, loadWorkConfig({ WORK_OPEN: 'yes' }).open, loadWorkConfig({ WORK_OPEN: 'true' }).open], [false, false, true]);
check('reputation writes are off unless a weight is set', loadWorkConfig({}).evidenceWeight, null);
check('a set weight turns them on', loadWorkConfig({ WORK_EVIDENCE_WEIGHT: '0.5' }).evidenceWeight, 0.5);
check('a nonsense weight leaves them off', loadWorkConfig({ WORK_EVIDENCE_WEIGHT: 'lots' }).evidenceWeight, null);
check('defaults: 500 slots, panels of 3', [loadWorkConfig({}).slotCap, loadWorkConfig({}).panelSize], [500, 3]);

// Wallet activity (the fuller job)
const other = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const view = (o: Partial<TxView>): TxView => ({ accountKeys: [wallet], preBalances: [0], postBalances: [0], instructions: [], ...o });
const txs = new Map<string, TxView>([
  ['d', view({ accountKeys: [wallet, other, '11111111111111111111111111111111'], preBalances: [5_000, 0, 1], postBalances: [2_000, 3_000, 1] })],
  ['b', view({ accountKeys: [other, wallet], preBalances: [9, 1_000], postBalances: [9, 1_500],
    instructions: [{ programId: TOKEN, parsed: { type: 'initializeMint2', info: { mint, mintAuthority: wallet } } },
                   { programId: TOKEN, parsed: { type: 'initializeMint', info: { mint: other, mintAuthority: other } } }] })],
  ['a', view({})],
]);
const act = summarizeActivity(sigs, txs, spec);
check('activity counts only successful transactions', [act.successCount, act.failedCount, act.txCount], [3, 1, 4]);
check('volume is the absolute balance change, summed', act.volumeLamports, '3500');
check('counterparties exclude the wallet and the system program', act.uniqueCounterparties, 1);
check('only mints the wallet initialised are launched mints', act.launchedMints, [mint]);
check('successful active days ignore failed transactions', act.successActiveDays, 3);
let threw = false;
try { summarizeActivity(sigs, new Map([['d', txs.get('d')!]]), spec); } catch { threw = true; }
check('a missing transaction refuses to answer', threw, true);
check('a real activity answer survives validation', hashActivity(canonicalActivity(act, spec)!), hashActivity(act));
check('counts that do not add up are rejected', canonicalActivity({ ...act, successCount: 4 }, spec), null);
check('unsorted mints are rejected', canonicalActivity({ ...act, launchedMints: ['b', 'a'] }, spec), null);
check('a non-numeric volume is rejected', canonicalActivity({ ...act, volumeLamports: '1e9' }, spec), null);
check('a different volume changes the hash', hashActivity({ ...act, volumeLamports: '3501' }) === hashActivity(act), false);
check('both job kinds resolve, unknown ones do not', [!!jobKind('wallet_history_v1'), !!jobKind('wallet_activity_v1'), jobKind('toString')], [true, true, null]);
check('an unknown job kind in config falls back', loadWorkConfig({ WORK_JOB_KIND: 'nope' }).jobKind, 'wallet_history_v1');

// Payout shares
const shares = computeShares(1_000_000_000n, new Map([['a', 30], ['b', 10], ['c', 0]]), 1_000_000n);
check('shares are proportional', shares.map((x) => [x.wallet, x.lamports.toString()]), [['a', '750000000'], ['b', '250000000'], ['c', '0']]);
check('a zero share is not payable', shares.find((x) => x.wallet === 'c')!.payable, false);
check('shares round down and never exceed the pool', computeShares(10n, new Map([['a', 1], ['b', 1], ['c', 1]]), 0n).reduce((t, x) => t + x.lamports, 0n) <= 10n, true);
check('a share under the minimum is not payable', computeShares(1_500_000n, new Map([['a', 2], ['b', 1]]), 1_000_000n).map((x) => x.payable), [true, false]);
check('no work means nothing is paid', computeShares(1_000n, new Map(), 0n), []);
check('one wrong answer cancels ten accepted', [unitsFor(25, 1), unitsFor(8, 1), unitsFor(8, 0)], [15, 0, 8]);
const cfgSplit = loadWorkConfig({ WORK_SPLIT_WORKERS_BPS: '7000', WORK_SPLIT_LOCK_BPS: '5000' });
check('the split can never exceed the whole', cfgSplit.workersBps + cfgSplit.lockBps <= 10000, true);

// Daily record
const lv = ['a', 'b', 'c', 'd', 'e'].map((j) => leafHash(j, 'h' + j));
const root5 = merkleRoot(lv);
check('every leaf proves against the root', lv.every((l, i) => verifyProof(l, merkleProof(lv, i), root5)), true);
check('a leaf does not prove against another day', verifyProof(lv[0], merkleProof(lv, 0), merkleRoot(lv.slice(1))), false);
check('a changed answer does not prove', verifyProof(leafHash('a', 'other'), merkleProof(lv, 0), root5), false);
check('order changes the root', merkleRoot([...lv].reverse()) === root5, false);
check('a single job is its own root', merkleRoot([lv[0]]), lv[0]);
check('an empty day still has a root', merkleRoot([]).length, 64);
check('one and two leaves prove too', [1, 2].every((n) => lv.slice(0, n).every((l, i) => verifyProof(l, merkleProof(lv.slice(0, n), i), merkleRoot(lv.slice(0, n))))), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
