/**
 * Work loop — what agents download: the bundled worker and the skill file
 * that tells an agent how to join. Both are read from disk once and cached.
 *
 * The worker bundle is a build artifact (scripts/build-worker.mjs writes
 * dist/said-worker.cjs), so under `tsx` without a build it is simply absent.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';

export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || 'https://api.saidprotocol.com').replace(/\/+$/, '');

export interface WorkerBundle {
  body: Buffer;
  sha256: string;
}

let bundle: Promise<WorkerBundle | null> | null = null;
export function loadWorkerBundle(): Promise<WorkerBundle | null> {
  bundle ??= readFile(join(process.cwd(), 'dist', 'said-worker.cjs'))
    .then((body) => ({ body, sha256: createHash('sha256').update(body).digest('hex') }))
    .catch(() => null);
  return bundle;
}

let skill: Promise<string | null> | null = null;
export function loadSkill(): Promise<string | null> {
  skill ??= readFile(join(process.cwd(), 'public', 'work-skill.md'), 'utf8')
    .then((text) => text.replaceAll('{{API}}', PUBLIC_API_URL))
    .catch(() => null);
  return skill;
}
