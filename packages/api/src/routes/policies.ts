import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { policies } from '../db/schema.js';
import { calculatePremium, RiskTier } from '@covantic/shared';

const policyQuerySchema = z.object({
  holder: z.string().optional(),
  agent: z.string().optional(),
  state: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().default(0),
});

const quoteSchema = z.object({
  coverageAmount: z.number().positive(),
  durationSeconds: z.number().positive(),
  riskTier: z.number().min(0).max(2),
});

export async function policyRoutes(app: FastifyInstance) {
  /** GET /api/policies — List policies with filters */
  app.get('/api/policies', async (request, reply) => {
    const query = policyQuerySchema.parse(request.query);
    const conditions = [];

    if (query.holder) conditions.push(eq(policies.holderAddress, query.holder));
    if (query.agent) conditions.push(eq(policies.agentAddress, query.agent));
    if (query.state !== undefined) conditions.push(eq(policies.state, query.state));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [result, countResult] = await Promise.all([
      app.db
        .select()
        .from(policies)
        .where(where)
        .orderBy(desc(policies.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      app.db
        .select({ count: sql<number>`count(*)` })
        .from(policies)
        .where(where),
    ]);

    return reply.send({ policies: result, total: countResult[0]?.count ?? 0 });
  });

  /** GET /api/policies/:policyId — Get policy details */
  app.get('/api/policies/:policyId', async (request, reply) => {
    const { policyId } = z.object({ policyId: z.coerce.number() }).parse(request.params);

    const result = await app.db
      .select()
      .from(policies)
      .where(eq(policies.policyId, policyId))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Policy not found' });
    }

    return reply.send(result[0]);
  });

  /** POST /api/policies/quote — Get premium quote */
  app.post('/api/policies/quote', async (request, reply) => {
    const body = quoteSchema.parse(request.body);

    const premium = calculatePremium(
      body.coverageAmount,
      body.durationSeconds,
      body.riskTier as RiskTier,
    );

    if (premium < 0) {
      return reply.status(400).send({ error: 'Risk tier EXTREME is not insurable' });
    }

    return reply.send({
      coverageAmount: body.coverageAmount,
      durationSeconds: body.durationSeconds,
      riskTier: body.riskTier,
      premiumAmount: premium,
      premiumMultiplier: 10000,
    });
  });
}
