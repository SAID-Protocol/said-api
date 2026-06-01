/**
 * Show active agents by day on the SAID protocol registry.
 * "Active" = lastActiveAt was updated within the window.
 *
 * Usage:
 *   npx tsx scripts/active-agents.ts            # last 7 days
 *   npx tsx scripts/active-agents.ts --days 30  # last 30 days
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const days = daysArg !== -1 ? parseInt(args[daysArg + 1], 10) : 7;

function toDateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const agents = await prisma.agent.findMany({
    where: { lastActiveAt: { gte: since } },
    select: {
      name: true,
      wallet: true,
      lastActiveAt: true,
      activityCount: true,
      isVerified: true,
      layer2Verified: true,
    },
    orderBy: { lastActiveAt: 'desc' },
  });

  if (agents.length === 0) {
    console.log(`No agents active in the last ${days} days.`);
    return;
  }

  // Group by day
  const byDay: Record<string, typeof agents> = {};
  for (const agent of agents) {
    const key = toDateKey(agent.lastActiveAt!);
    (byDay[key] ??= []).push(agent);
  }

  console.log(`\n=== SAID Protocol — Active Agents (last ${days} days) ===\n`);
  console.log(`Total unique active agents: ${agents.length}\n`);

  for (const day of Object.keys(byDay).sort().reverse()) {
    const list = byDay[day];
    console.log(`${day}  (${list.length} agent${list.length === 1 ? '' : 's'})`);
    for (const a of list) {
      const flags = [
        a.isVerified ? '✓verified' : '',
        a.layer2Verified ? 'L2' : '',
      ].filter(Boolean).join(' ');
      console.log(
        `  ${(a.name ?? 'unnamed').padEnd(32)} ${a.wallet.slice(0, 8)}...  activity=${a.activityCount}  ${flags}`
      );
    }
    console.log();
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
