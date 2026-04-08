import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents } from '../db/schema.js';
import { assessRisk } from '../services/risk-scorer.js';
import { HeliusClient } from '../utils/helius.js';

const addressParam = z.object({ agentAddress: z.string().min(32).max(44) });

export async function riskRoutes(app: FastifyInstance) {
  const helius = new HeliusClient(app.config.HELIUS_API_KEY);

  /** GET /api/risk/:agentAddress — Get risk score for an agent */
  app.get('/api/risk/:agentAddress', async (request, reply) => {
    const { agentAddress } = addressParam.parse(request.params);

    // Check cached score in DB
    const existing = await app.db
      .select()
      .from(agents)
      .where(eq(agents.walletAddress, agentAddress))
      .limit(1);

    if (existing.length > 0 && existing[0]!.riskScore != null) {
      return reply.send({
        agentAddress,
        score: existing[0]!.riskScore,
        tier: existing[0]!.riskTier,
        scoredAt: existing[0]!.riskScoredAt,
        cached: true,
      });
    }

    // Compute fresh score
    const assessment = await assessRisk(agentAddress, helius);

    // Upsert agent record
    await app.db
      .insert(agents)
      .values({
        walletAddress: agentAddress,
        ownerAddress: agentAddress, // Default; updated by caller
        riskScore: assessment.score,
        riskTier: assessment.tier,
        riskScoredAt: assessment.assessedAt,
        riskData: assessment.factors as any,
      })
      .onConflictDoUpdate({
        target: agents.walletAddress,
        set: {
          riskScore: assessment.score,
          riskTier: assessment.tier,
          riskScoredAt: assessment.assessedAt,
          riskData: assessment.factors as any,
          updatedAt: new Date(),
        },
      });

    return reply.send({ ...assessment, agentAddress, cached: false });
  });

  /** POST /api/risk/:agentAddress/refresh — Force recalculate risk score */
  app.post('/api/risk/:agentAddress/refresh', async (request, reply) => {
    const { agentAddress } = addressParam.parse(request.params);

    const assessment = await assessRisk(agentAddress, helius);

    await app.db
      .insert(agents)
      .values({
        walletAddress: agentAddress,
        ownerAddress: agentAddress,
        riskScore: assessment.score,
        riskTier: assessment.tier,
        riskScoredAt: assessment.assessedAt,
        riskData: assessment.factors as any,
      })
      .onConflictDoUpdate({
        target: agents.walletAddress,
        set: {
          riskScore: assessment.score,
          riskTier: assessment.tier,
          riskScoredAt: assessment.assessedAt,
          riskData: assessment.factors as any,
          updatedAt: new Date(),
        },
      });

    return reply.send({ ...assessment, agentAddress });
  });
}
