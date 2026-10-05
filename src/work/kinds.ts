/**
 * Work loop — the job kinds a panel can be asked to do. The server and the
 * worker both resolve a job's kind here, so they always run the same code.
 */

import type { Connection } from '@solana/web3.js';
import {
  WALLET_HISTORY_KIND,
  canonicalResult,
  hashResult,
  isValidSpec,
  runWalletHistory,
  type WalletHistoryResult,
  type WalletHistorySpec,
} from './wallet-history.js';
import {
  WALLET_ACTIVITY_KIND,
  canonicalActivity,
  hashActivity,
  runWalletActivity,
  type WalletActivityResult,
} from './wallet-activity-job.js';

export type JobResult = WalletHistoryResult | WalletActivityResult;

export interface JobKind {
  kind: string;
  isValidSpec(spec: unknown): spec is WalletHistorySpec;
  /** Validate an untrusted answer; null when it is not an answer to `spec`. */
  canonical(input: unknown, spec: WalletHistorySpec): JobResult | null;
  /** The value panel members must agree on. */
  hash(result: JobResult): string;
  run(conn: Connection, spec: WalletHistorySpec): Promise<JobResult>;
}

export const JOB_KINDS: Record<string, JobKind> = {
  [WALLET_HISTORY_KIND]: {
    kind: WALLET_HISTORY_KIND,
    isValidSpec,
    canonical: canonicalResult,
    hash: (r) => hashResult(r as WalletHistoryResult),
    run: runWalletHistory,
  },
  [WALLET_ACTIVITY_KIND]: {
    kind: WALLET_ACTIVITY_KIND,
    isValidSpec,
    canonical: canonicalActivity,
    hash: (r) => hashActivity(r as WalletActivityResult),
    run: runWalletActivity,
  },
};

export function jobKind(kind: string): JobKind | null {
  return Object.prototype.hasOwnProperty.call(JOB_KINDS, kind) ? JOB_KINDS[kind] : null;
}
