import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { agents, riskAssessments } from '../db/schema.js';
import { assessRisk } from '../services/risk-scorer.js';
import { HeliusClient } from '../utils/helius.js';
import { riskAssessmentRateLimit } from '../middleware/rate-limit.js';

// Base58 Solana addresses are 32–44 characters long and contain only alphanumeric
// characters excluding 0, O, I, l (standard Base58 alphabet).
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const addressParam = z.object({
  agentAddress: z.string().regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address'),
});
const idParam = z.object({ id: z.string().uuid() });
const historyQuery = z.object({
  agent: z.string().regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Insert a new assessment record and update the agents cache */
async function saveAssessment(
  db: FastifyInstance['db'],
  agentAddress: string,
  assessment: Awaited<ReturnType<typeof assessRisk>>,
): Promise<string> {
  // Drizzle's jsonb columns accept `unknown` — cast through unknown to satisfy the
  // column type without silencing the compiler entirely with a bare `as any`.
  type JsonValue = Record<string, unknown> | unknown[];
  const toJson = (v: unknown): JsonValue => v as JsonValue;

  // Insert assessment as a new record (never overwrite)
  const [row] = await db
    .insert(riskAssessments)
    .values({
      agentAddress,
      riskScore: assessment.score,
      riskTier: assessment.tier,
      premiumBps: assessment.premiumBps,
      factors: toJson(assessment.factors),
      factorDetails: toJson(assessment.factorDetails),
      categoryRisks: toJson(assessment.categoryRisks),
      weightInfo: toJson(assessment.weightInfo),
      dataAvailability: toJson(assessment.dataAvailability),
      overallConfidence: assessment.overallConfidence,
      summary: assessment.summary,
      recommendation: assessment.recommendation,
      assessedAt: assessment.assessedAt,
    })
    .returning({ id: riskAssessments.id });

  if (!row) {
    throw new Error('INSERT into riskAssessments returned no row — database may be unavailable');
  }
  const assessmentId = row.id;

  // Update agents table with latest cached score
  await db
    .insert(agents)
    .values({
      walletAddress: agentAddress,
      ownerAddress: agentAddress,
      riskScore: assessment.score,
      riskTier: assessment.tier,
      riskScoredAt: assessment.assessedAt,
      riskData: toJson(assessment.factors),
    })
    .onConflictDoUpdate({
      target: agents.walletAddress,
      set: {
        riskScore: assessment.score,
        riskTier: assessment.tier,
        riskScoredAt: assessment.assessedAt,
        riskData: toJson(assessment.factors),
        updatedAt: new Date(),
      },
    });

  return assessmentId;
}

export async function riskRoutes(app: FastifyInstance) {
  const helius = new HeliusClient(app.config.HELIUS_API_KEY);

  /** GET /api/risk/:agentAddress — Run a NEW risk assessment (always creates a new record) */
  app.get('/api/risk/:agentAddress', { preHandler: [riskAssessmentRateLimit] }, async (request, reply) => {
    const parseResult = addressParam.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid agent address' });
    }
    const { agentAddress } = parseResult.data;

    const assessment = await assessRisk(agentAddress, app.solanaConnection, helius);
    const assessmentId = await saveAssessment(app.db, agentAddress, assessment);

    return reply.send({ ...assessment, agentAddress, assessmentId });
  });

  /** POST /api/risk/:agentAddress/refresh — Force recalculate (alias, also creates new record) */
  app.post('/api/risk/:agentAddress/refresh', { preHandler: [riskAssessmentRateLimit] }, async (request, reply) => {
    const parseResult = addressParam.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid agent address' });
    }
    const { agentAddress } = parseResult.data;

    const assessment = await assessRisk(agentAddress, app.solanaConnection, helius);
    const assessmentId = await saveAssessment(app.db, agentAddress, assessment);

    return reply.send({ ...assessment, agentAddress, assessmentId });
  });

  /** GET /api/assessments/:id — Retrieve a stored assessment by ID (for shareable URLs) */
  app.get('/api/assessments/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);

    const rows = await app.db
      .select()
      .from(riskAssessments)
      .where(eq(riskAssessments.id, id))
      .limit(1);

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Assessment not found' });
    }

    const row = rows[0]!;
    return reply.send({
      assessmentId: row.id,
      agentAddress: row.agentAddress,
      score: row.riskScore,
      tier: row.riskTier,
      premiumBps: row.premiumBps,
      factors: row.factors,
      factorDetails: row.factorDetails,
      categoryRisks: row.categoryRisks,
      weightInfo: row.weightInfo,
      dataAvailability: row.dataAvailability,
      overallConfidence: row.overallConfidence,
      summary: row.summary,
      recommendation: row.recommendation,
      assessedAt: row.assessedAt,
      createdAt: row.createdAt,
    });
  });

  /** GET /api/assessments — List assessment history (optionally filtered by agent) */
  app.get('/api/assessments', async (request, reply) => {
    const parseResult = historyQuery.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid query parameters' });
    }
    const { agent, limit, offset } = parseResult.data;

    // Build the base query first, then conditionally attach .where() before awaiting.
    // This pattern avoids type-unsafe query mutation after the fact.
    const baseQuery = app.db
      .select({
        id: riskAssessments.id,
        agentAddress: riskAssessments.agentAddress,
        riskScore: riskAssessments.riskScore,
        riskTier: riskAssessments.riskTier,
        premiumBps: riskAssessments.premiumBps,
        overallConfidence: riskAssessments.overallConfidence,
        assessedAt: riskAssessments.assessedAt,
        createdAt: riskAssessments.createdAt,
      })
      .from(riskAssessments)
      .orderBy(desc(riskAssessments.createdAt))
      .limit(limit)
      .offset(offset);

    const rows = agent
      ? await baseQuery.where(eq(riskAssessments.agentAddress, agent))
      : await baseQuery;

    return reply.send({ assessments: rows });
  });
}
