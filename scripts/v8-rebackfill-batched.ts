/**
 * Delete + re-emit ReputationEvent rows for the batched-signal sources
 * (x402 + said_engagement). Used when the weight policy for these
 * batched events changes — sourceKey idempotency would otherwise prevent
 * re-emission.
 *
 * Per-row source events (Agent, Feedback, Attestation, LaunchedToken)
 * are NOT touched. Their weights derive from per-row data and don't need
 * re-emission when batch policies change.
 *
 * Idempotent: safe to run multiple times. After running this, also re-run
 * scripts/v8-compute-signals.ts to rebuild the ReputationSignal layer.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-rebackfill-batched.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Deleting batched ReputationEvent rows (x402:* and said:*)...');

  // Delete by sourceKey prefix patterns.
  const xResult = await prisma.reputationEvent.deleteMany({
    where: { sourceKey: { startsWith: 'x402:' } },
  });
  const sResult = await prisma.reputationEvent.deleteMany({
    where: { sourceKey: { startsWith: 'said:' } },
  });

  console.log(`Deleted ${xResult.count} x402 events.`);
  console.log(`Deleted ${sResult.count} said events.`);
  console.log('\nNow run:');
  console.log('  npx tsx scripts/v8-backfill-events.ts');
  console.log('  npx tsx scripts/v8-compute-signals.ts');

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
