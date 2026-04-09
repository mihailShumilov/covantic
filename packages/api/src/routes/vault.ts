import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { vaultSnapshots, policies } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export async function vaultRoutes(app: FastifyInstance) {
  /** GET /api/vault/stats — Current vault statistics */
  app.get('/api/vault/stats', async (_request, reply) => {
    const snapshots = await app.db
      .select()
      .from(vaultSnapshots)
      .orderBy(desc(vaultSnapshots.snapshotAt))
      .limit(1);

    if (snapshots.length === 0) {
      return reply.send({
        totalStaked: 0,
        totalCoverage: 0,
        totalPremiums: 0,
        totalClaimsPaid: 0,
        stakerCount: 0,
        solvencyRatio: 0,
        activePolicies: 0,
      });
    }

    return reply.send(snapshots[0]);
  });

  /** GET /api/vault/history — Vault snapshot history */
  app.get('/api/vault/history', async (request, reply) => {
    const { limit } = z
      .object({ limit: z.coerce.number().min(1).max(100).default(30) })
      .parse(request.query);

    const history = await app.db
      .select()
      .from(vaultSnapshots)
      .orderBy(desc(vaultSnapshots.snapshotAt))
      .limit(limit);

    return reply.send({ snapshots: history });
  });

  /** GET /api/protocol/overview — Public protocol metrics */
  app.get('/api/protocol/overview', async (_request, reply) => {
    const snapshot = await app.db
      .select()
      .from(vaultSnapshots)
      .orderBy(desc(vaultSnapshots.snapshotAt))
      .limit(1);

    const activePoliciesCount = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(policies)
      .where(eq(policies.state, 0));

    const stats = snapshot[0] ?? {
      totalStaked: 0,
      totalCoverage: 0,
      totalPremiums: 0,
      totalClaimsPaid: 0,
      stakerCount: 0,
      solvencyRatio: 0,
    };

    return reply.send({
      ...stats,
      activePolicies: activePoliciesCount[0]?.count ?? 0,
    });
  });
}
