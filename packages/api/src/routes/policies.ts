import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { policies, riskAssessments } from '../db/schema.js';
import {
  RiskTier,
  SOLANA_ADDRESS_REGEX,
  calculatePremium,
  tierToPremiumBps,
} from '@covantic/shared';

const policyQuerySchema = z.object({
  holder: z.string().optional(),
  agent: z.string().optional(),
  state: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().default(0),
});

/**
 * Quote input. `riskTier` is intentionally *not* accepted from the client —
 * it is derived server-side from the agent's latest stored risk assessment,
 * so buyers can't self-select a cheaper tier than their agent earns.
 */
const quoteSchema = z.object({
  coverageAmount: z.number().positive(),
  durationSeconds: z.number().positive(),
  agentAddress: z
    .string()
    .regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address'),
});

/**
 * Max age for the underlying assessment when issuing a quote. Slightly longer
 * than the /api/risk Redis cache TTL (300s) so a quote issued off a fresh
 * assessment doesn't immediately expire, while still forcing a re-scan before
 * long-abandoned sessions can be used to buy a policy.
 */
const QUOTE_MAX_ASSESSMENT_AGE_SECONDS = 600;

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

  /**
   * POST /api/policies/quote — Get premium quote.
   *
   * The tier is derived from the agent's latest stored risk assessment, not
   * supplied by the client. This closes the off-chain adverse-selection hole
   * where buyers could pick LOW for a known-HIGH agent.
   *
   * Returns 400 with a machine-readable `code` when the assessment is
   * missing, EXTREME (uninsurable), or stale — the client is expected to
   * re-run /api/risk and retry.
   */
  app.post('/api/policies/quote', async (request, reply) => {
    const body = quoteSchema.parse(request.body);

    const [latest] = await app.db
      .select({
        id: riskAssessments.id,
        tier: riskAssessments.riskTier,
        assessedAt: riskAssessments.assessedAt,
      })
      .from(riskAssessments)
      .where(eq(riskAssessments.agentAddress, body.agentAddress))
      .orderBy(desc(riskAssessments.createdAt))
      .limit(1);

    if (!latest) {
      return reply.status(400).send({
        error: 'No risk assessment on record for this agent — analyze it first',
        code: 'ASSESSMENT_REQUIRED',
        agentAddress: body.agentAddress,
      });
    }

    if (latest.tier === RiskTier.EXTREME) {
      return reply.status(400).send({
        error: 'Agent is currently assessed as EXTREME risk and is not insurable',
        code: 'AGENT_UNINSURABLE',
        agentAddress: body.agentAddress,
        riskTier: latest.tier,
        assessmentId: latest.id,
      });
    }

    const assessedAtMs = latest.assessedAt.getTime();
    const ageSeconds = Math.floor((Date.now() - assessedAtMs) / 1000);
    if (ageSeconds > QUOTE_MAX_ASSESSMENT_AGE_SECONDS) {
      return reply.status(400).send({
        error: 'Risk assessment is stale — please re-analyze the agent',
        code: 'ASSESSMENT_STALE',
        agentAddress: body.agentAddress,
        assessmentId: latest.id,
        assessedAt: latest.assessedAt.toISOString(),
        maxAgeSeconds: QUOTE_MAX_ASSESSMENT_AGE_SECONDS,
      });
    }

    const tier = latest.tier as RiskTier;
    const premiumBps = tierToPremiumBps(tier);
    const premium = calculatePremium(body.coverageAmount, body.durationSeconds, tier);

    if (premiumBps == null || premium == null) {
      // Defense-in-depth: EXTREME was already rejected above, but guard anyway.
      return reply.status(400).send({
        error: 'Risk tier is not insurable',
        code: 'AGENT_UNINSURABLE',
        agentAddress: body.agentAddress,
        riskTier: tier,
        assessmentId: latest.id,
      });
    }

    // Publish (or refresh) the on-chain attestation. The client needs the
    // PDA in the `create_policy` accounts list — without it, the program
    // will reject the transaction.
    let attestationPda: string | null = null;
    let attestationExpiresAt: string | null = null;
    try {
      const att = await app.attestationPublisher.ensureFresh(body.agentAddress, tier);
      attestationPda = att.attestationPda;
      attestationExpiresAt = att.expiresAt.toISOString();
    } catch (err) {
      app.log.error({ err, agent: body.agentAddress }, 'Failed to publish risk attestation');
      return reply.status(503).send({
        error: 'Could not publish on-chain risk attestation — try again shortly',
        code: 'ATTESTATION_PUBLISH_FAILED',
        agentAddress: body.agentAddress,
      });
    }

    const validUntil = new Date(assessedAtMs + QUOTE_MAX_ASSESSMENT_AGE_SECONDS * 1000);

    return reply.send({
      agentAddress: body.agentAddress,
      coverageAmount: body.coverageAmount,
      durationSeconds: body.durationSeconds,
      riskTier: tier,
      premiumAmount: premium,
      premiumBps,
      premiumMultiplier: 10000,
      assessmentId: latest.id,
      assessedAt: latest.assessedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      attestationPda,
      attestationExpiresAt,
    });
  });
}
