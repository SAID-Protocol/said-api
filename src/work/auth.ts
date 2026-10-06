/**
 * Work loop — signatures.
 *
 * Two keys, on purpose. The agent's wallet signs exactly once, to bind a
 * worker key to its slot. Everything after that is signed by the worker key,
 * so the wallet key never needs to be on the machine doing the work.
 *
 * All messages follow the API's existing `SAID:<thing>:…:<timestamp>` style
 * (see getFeedbackMessage in index.ts). Timestamps are unix milliseconds and
 * must be within five minutes of the server clock.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

/** A base58 Solana public key. */
export function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** A base58 Solana transaction signature. */
export const TX_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export function slotClaimMessage(wallet: string, workerKey: string, timestamp: number): string {
  return `SAID:work:claim-slot:${wallet}:${workerKey}:${timestamp}`;
}

export function jobClaimMessage(workerKey: string, timestamp: number): string {
  return `SAID:work:claim-job:${workerKey}:${timestamp}`;
}

export function submitMessage(assignmentId: string, resultHash: string, timestamp: number): string {
  return `SAID:work:submit:${assignmentId}:${resultHash}:${timestamp}`;
}

export function isFresh(timestamp: unknown, now: number = Date.now()): timestamp is number {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && Math.abs(now - timestamp) <= SIGNATURE_WINDOW_MS;
}

/** True when `signature` (base58) is `signer`'s (base58 Ed25519 key) signature over `message`. */
export function verifyMessage(message: string, signature: unknown, signer: unknown): boolean {
  if (typeof signature !== 'string' || typeof signer !== 'string') return false;
  try {
    const sig = bs58.decode(signature);
    const key = bs58.decode(signer);
    if (sig.length !== nacl.sign.signatureLength || key.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, key);
  } catch {
    return false;
  }
}

export function signMessage(message: string, secretKey: Uint8Array): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secretKey));
}
