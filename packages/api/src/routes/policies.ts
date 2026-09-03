import type { FastifyInstance } from 'fastify';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, claims, policies, riskAssessments, vaultSnapshots } from '../db/schema.js';
import {
  PolicyState,
  RiskTier,
  SOLANA_ADDRESS_REGEX,
  SOLVENCY_THRESHOLDS,
  tierToPremiumBps,
  agentMandateCommitment,
} from '@covantic/shared';
import { fetchOnChainPolicy, getPolicyReaderStatus } from '../utils/policy-reader.js';
import { PublicKey } from '@solana/web3.js';
import { decideQuote } from '../services/quote-decision.js';
import { loadOutflowBaseline } from '../services/agent-error/baseline.js';
import { getSolanaReader } from '../utils/solana-reader.js';

/**
 * What the vault currently has behind the coverage it has already sold.
 *
 * Coverage is backed fractionally by design — no insurer holds 100% of its
 * aggregate limits, and the protocol's own ladder runs from 0.5x to 2.0x. The
 * on-chain floor added to `execute_unstake` stops that backing reaching zero,
 * but it does not make it whole, so a buyer is entitled to see the ratio they
 * are buying into before they pay a premium priced as though it were.
 *
 * Read from the `vaultSnapshots` table the solvency-checker writes rather than
 * from the chain: a quote must not depend on an RPC round-trip, and a figure a
 * few minutes old is still an honest one as long as its age is published. Best
 * effort throughout — a missing snapshot returns `null` and never fails the
 * quote, because refusing to sell insurance over a stale dashboard row would
 * be a worse outcome than quoting without the disclosure.
 */
async function readVaultBacking(app: FastifyInstance) {
  try {
    const [snapshot] = await app.db
      .select()
      .from(vaultSnapshots)
      .orderBy(desc(vaultSnapshots.snapshotAt))
      .limit(1);
    if (!snapshot) return null;

    const ratio = Number(snapshot.solvencyRatio ?? 0);
    const band =
      ratio >= SOLVENCY_THRESHOLDS.HEALTHY
        ? 'healthy'
        : ratio >= SOLVENCY_THRESHOLDS.CAUTION
          ? 'caution'
          : ratio >= SOLVENCY_THRESHOLDS.CRITICAL
            ? 'critical'
            : 'emergency';

    return {
      solvencyRatioBps: ratio,
      /** 1.0 means every USDC of outstanding coverage has a USDC behind it. */
      backingMultiple: Number((ratio / 10000).toFixed(4)),
      band,
      totalStaked: Number(snapshot.totalStaked ?? 0),
      totalCoverage: Number(snapshot.totalCoverage ?? 0),
      asOf: snapshot.snapshotAt.toISOString(),
    };
  } catch {
    return null;
  }
}

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

/**
 * Price the declared envelope against what the agent actually does.
 *
 * Two readings, and the second is the one that is easy to skip: the agent's
 * outflow history, and its current balance. The balance matters because the
 * retention floor is measured against it — a floor of 4,990 is generous for an
 * agent holding 50,000 and suffocating for one holding 5,000, and the number
 * alone does not say which.
 *
 * A read that fails is not an agent with no history. `loadOutflowBaseline`
 * returning nothing means the distribution is unknown, and `priceEnvelope`
 * charges the ceiling for that rather than guessing — the same three-valued
 * discipline the claim path uses, applied to a price.
 */
/**
 * The envelope this agent gets, and what it may be insured for.
 *
 * Both come from the same two readings — what the agent holds and what it
 * ordinarily moves — so they are taken together rather than twice.
 *
 * An unreadable balance is a refusal, not a zero. Reading a failed RPC call as
 * an empty account would derive a cap of one base unit and offer a maximum
 * coverage of nothing, and the buyer would be looking at a quote computed from
 * a number nobody actually read.
 */
async function underwriteAgent(
  app: FastifyInstance,
  agentAddress: string,
): Promise<
  | { ok: true; coveredBalanceRaw: number; p95OutflowRaw: number | null; transferCount: number }
  | { ok: false; reason: 'no_covered_mint' | 'balance_unreadable' }
> {
  const mint = app.config.USDC_MINT;
  if (!mint) return { ok: false, reason: 'no_covered_mint' };

  let coveredBalanceRaw: number;
  try {
    const reader = getSolanaReader(app.config);
    const { accounts } = await reader.getParsedTokenAccountsByOwner(agentAddress, { mint });
    coveredBalanceRaw = accounts.reduce((sum, a) => sum + Number(a.amount), 0);
  } catch (err) {
    app.log.warn({ err, agentAddress }, 'underwriting: covered balance unreadable');
    return { ok: false, reason: 'balance_unreadable' };
  }

  const baseline = await loadOutflowBaseline(
    app.db,
    agentAddress,
    mint,
    new Date(),
    ENVELOPE_PRICING_WINDOW_SECONDS,
  ).catch(() => null);

  return {
    ok: true,
    coveredBalanceRaw,
    p95OutflowRaw: baseline?.p95OutflowRaw ?? null,
    transferCount: baseline?.transferCount ?? 0,
  };
}

/** How far back the agent's habits are read for pricing. A month is long
 *  enough to describe a habit and short enough to notice a change. */
const ENVELOPE_PRICING_WINDOW_SECONDS = 30 * 24 * 3600;

const quoteSchema = z.object({
  coverageAmount: z.number().positive(),
  durationSeconds: z.number().positive(),
  agentAddress: z
    .string()
    .regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address'),
  // The operating envelope is not an input any more.
  //
  // It used to be five fields on the purchase form, and that was the whole
  // extraction vector: a holder who picks the cap picks the breach. Pricing it
  // away meant charging what the holder could take at will, which made a
  // policy cost as much as it covered. The quote derives the envelope from the
  // agent's own history instead and returns it, and the oracle commits to that
  // one — so a purchase declaring anything else is refused by the program.
  //
  // A `mandate` sent by an older client is ignored rather than rejected: zod
  // strips what the schema does not name, and the derived envelope is the only
  // one the attestation will ever match.
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
   * GET /api/policies/enrichment — Batch sidecar for the dashboard.
   *
   * The web client reads policies directly from chain for freshness, then
   * calls this endpoint with the agent addresses + policy IDs it found. We
   * return, keyed for O(1) lookup on the client:
   *
   * - `agents`  : name/description/current risk tier+score per address
   * - `claims`  : summary of the most recent claim per policyId (if any)
   * - `meta`    : createTxSignature + indexerLagSec per policyId, lifted
   *               from the DB mirror so the UI can link to Solana Explorer
   *
   * Unknown addresses / policyIds are simply omitted — the client should
   * treat missing keys as "no context yet" and render the on-chain fields
   * it already has.
   */
  app.get('/api/policies/enrichment', async (request, reply) => {
    const { agents: agentsParam, policyIds: policyIdsParam } = z
      .object({
        agents: z.string().optional(),
        policyIds: z.string().optional(),
      })
      .parse(request.query);

    const agentAddresses = (agentsParam?.split(',') ?? [])
      .map((s) => s.trim())
      .filter((s) => SOLANA_ADDRESS_REGEX.test(s))
      .slice(0, 50);

    const policyIds = (policyIdsParam?.split(',') ?? [])
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .slice(0, 50);

    const agentsById: Record<string, {
      walletAddress: string;
      name: string | null;
      description: string | null;
      currentRiskTier: number | null;
      currentRiskScore: number | null;
      riskScoredAt: string | null;
    }> = {};

    const claimsByPolicy: Record<string, {
      id: string;
      status: string;
      triggerType: number;
      triggerTxSignature: string;
      payoutAmount: number | null;
      submittedAt: string;
      verifiedAt: string | null;
      paidAt: string | null;
      payoutTxSignature: string | null;
    }> = {};

    const metaByPolicy: Record<string, {
      createTxSignature: string | null;
      pdaAddress: string;
      updatedAt: string;
      indexerLagSec: number;
    }> = {};

    if (agentAddresses.length > 0) {
      const rows = await app.db
        .select({
          walletAddress: agents.walletAddress,
          name: agents.name,
          description: agents.description,
          riskTier: agents.riskTier,
          riskScore: agents.riskScore,
          riskScoredAt: agents.riskScoredAt,
        })
        .from(agents)
        .where(inArray(agents.walletAddress, agentAddresses));

      for (const row of rows) {
        agentsById[row.walletAddress] = {
          walletAddress: row.walletAddress,
          name: row.name ?? null,
          description: row.description ?? null,
          currentRiskTier: row.riskTier ?? null,
          currentRiskScore: row.riskScore ?? null,
          riskScoredAt: row.riskScoredAt?.toISOString() ?? null,
        };
      }
    }

    if (policyIds.length > 0) {
      // Most-recent claim per policyId. For a holder with a handful of
      // policies this is a cheap ORDER-BY-THEN-GROUP; replace with a window
      // function if volume grows.
      const claimRows = await app.db
        .select()
        .from(claims)
        .where(inArray(claims.policyId, policyIds))
        .orderBy(desc(claims.createdAt));

      for (const row of claimRows) {
        const key = String(row.policyId);
        if (claimsByPolicy[key]) continue; // keep most recent
        claimsByPolicy[key] = {
          id: row.id,
          status: row.status,
          triggerType: row.triggerType,
          triggerTxSignature: row.triggerTxSignature,
          payoutAmount: row.payoutAmount ?? null,
          submittedAt: row.createdAt.toISOString(),
          verifiedAt: row.verifiedAt?.toISOString() ?? null,
          paidAt: row.paidAt?.toISOString() ?? null,
          payoutTxSignature: row.payoutTxSignature ?? null,
        };
      }

      const now = Date.now();
      const policyRows = await app.db
        .select({
          policyId: policies.policyId,
          pdaAddress: policies.pdaAddress,
          createTxSignature: policies.createTxSignature,
          updatedAt: policies.updatedAt,
        })
        .from(policies)
        .where(inArray(policies.policyId, policyIds));

      for (const row of policyRows) {
        metaByPolicy[String(row.policyId)] = {
          createTxSignature: row.createTxSignature ?? null,
          pdaAddress: row.pdaAddress,
          updatedAt: row.updatedAt.toISOString(),
          indexerLagSec: Math.max(0, Math.floor((now - row.updatedAt.getTime()) / 1000)),
        };
      }
    }

    return reply.send({
      agents: agentsById,
      claims: claimsByPolicy,
      meta: metaByPolicy,
    });
  });

  /**
   * GET /api/policies/:policyId/why-active — Diagnostic endpoint.
   *
   * Returns the DB row and the on-chain PDA side-by-side, plus a `diagnosis`
   * array that names every inconsistency we can detect: state mismatch between
   * indexer and chain, expiry elapsed but still Active, stale indexer, etc.
   *
   * This is the tool to reach for when the monitor skips a transaction and
   * you want to know *why* the policy was considered (in)active. It does
   * not mutate any state.
   */
  app.get('/api/policies/:policyId/why-active', async (request, reply) => {
    const { policyId } = z.object({ policyId: z.coerce.number() }).parse(request.params);

    const rows = await app.db
      .select()
      .from(policies)
      .where(eq(policies.policyId, policyId))
      .limit(1);

    const dbRow = rows[0];
    if (!dbRow) {
      return reply.status(404).send({ error: 'Policy not found in database' });
    }

    const readerStatus = getPolicyReaderStatus(app.config);
    const fetchResult = await fetchOnChainPolicy(app.config, dbRow.pdaAddress);
    const onChain = fetchResult.policy;
    const onChainError = fetchResult.detail;
    const onChainReason = fetchResult.reason;

    const now = new Date();
    const expired = dbRow.expiryTime.getTime() <= now.getTime();
    const withinStartWindow = dbRow.startTime.getTime() <= now.getTime();
    const stateName = PolicyState[dbRow.state] ?? `Unknown(${dbRow.state})`;

    const diagnosis: string[] = [];
    if (dbRow.state === PolicyState.Active && expired) {
      diagnosis.push(
        'DB state=Active but expiry_time has passed — expiry-crank is stuck or behind',
      );
    }
    if (!withinStartWindow) {
      diagnosis.push('start_time is in the future — policy not yet in coverage window');
    }
    if (onChain) {
      if (onChain.state !== dbRow.state) {
        diagnosis.push(
          `DB state=${dbRow.state} (${stateName}) but on-chain state=${onChain.state} — indexer lag or drift`,
        );
      }
      if (onChain.expiryTimeSec * 1000 !== dbRow.expiryTime.getTime()) {
        diagnosis.push('DB expiry_time differs from on-chain expiry_time');
      }
      if (onChain.agentAddress !== dbRow.agentAddress) {
        diagnosis.push('DB agent_address differs from on-chain — database corruption');
      }
    } else if (!readerStatus.available) {
      diagnosis.push(
        'On-chain reader unavailable (IDL not loaded) — chain state not verified',
      );
    } else if (onChainReason === 'owner-mismatch') {
      diagnosis.push(
        'DB pda_address points at an account owned by a DIFFERENT program — stale row from a previous program deployment. The policy-indexer will overwrite on its next tick; if the issue persists, check PROGRAM_ID in .env matches the latest deploy.',
      );
    } else if (onChainReason === 'decode-error') {
      diagnosis.push(
        'On-chain account exists but fails to deserialize — layout drift vs the loaded IDL. Rebuild the Anchor program (`pnpm init:devnet`) and restart the API.',
      );
    } else if (onChainReason === 'not-found') {
      diagnosis.push('On-chain PDA not found — policy may have been closed or never existed.');
    } else if (onChainReason === 'rpc-error') {
      diagnosis.push('RPC error fetching on-chain account — chain state not verified.');
    }

    const indexerLagSec = onChain
      ? Math.max(0, Math.floor((Date.now() - dbRow.updatedAt.getTime()) / 1000))
      : null;

    return reply.send({
      policyId,
      now: now.toISOString(),
      db: {
        state: dbRow.state,
        stateName,
        agentAddress: dbRow.agentAddress,
        holderAddress: dbRow.holderAddress,
        startTime: dbRow.startTime.toISOString(),
        expiryTime: dbRow.expiryTime.toISOString(),
        updatedAt: dbRow.updatedAt.toISOString(),
        pdaAddress: dbRow.pdaAddress,
      },
      onChain: onChain
        ? {
            state: onChain.state,
            stateName: PolicyState[onChain.state] ?? `Unknown(${onChain.state})`,
            agentAddress: onChain.agentAddress,
            startTime: new Date(onChain.startTimeSec * 1000).toISOString(),
            expiryTime: new Date(onChain.expiryTimeSec * 1000).toISOString(),
            triggerType: onChain.triggerType,
            claimSubmittedAt:
              onChain.claimSubmittedAtSec > 0
                ? new Date(onChain.claimSubmittedAtSec * 1000).toISOString()
                : null,
          }
        : null,
      onChainError,
      onChainReason,
      readerAvailable: readerStatus.available,
      active: {
        dbSaysActive: dbRow.state === PolicyState.Active,
        chainSaysActive: onChain?.state === PolicyState.Active,
        withinCoverageWindow: withinStartWindow && !expired,
      },
      indexerLagSec,
      diagnosis,
    });
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
    // Underwrite the agent: what envelope it gets, and how much cover its own
    // balance can justify.
    const underwriting = await underwriteAgent(app, body.agentAddress);
    if (!underwriting.ok) {
      return reply.status(503).send({
        error:
          underwriting.reason === 'no_covered_mint'
            ? 'No covered mint is configured, so nothing can be underwritten'
            : 'Could not read the agent’s balance — try again shortly',
        code: 'UNDERWRITING_UNAVAILABLE',
        reason: underwriting.reason,
        agentAddress: body.agentAddress,
      });
    }
    const { coveredBalanceRaw } = underwriting;
    const backing = await readVaultBacking(app);

    const decision = decideQuote({
      coverageAmountRaw: body.coverageAmount,
      durationSeconds: body.durationSeconds,
      tier,
      coveredBalanceRaw,
      p95OutflowRaw: underwriting.p95OutflowRaw,
      transferCount: underwriting.transferCount,
      totalStakedRaw: backing?.totalStaked ?? 0,
      totalCoverageRaw: backing?.totalCoverage ?? 0,
    });

    if (decision?.kind === 'refused') {
      return reply.status(400).send({
        error:
          decision.bound === 'agent_balance'
            ? 'Cover above what the agent holds would pay for a loss it cannot suffer'
            : 'The vault’s stake does not support this much additional cover',
        code: decision.code,
        maxCoverage: decision.maxCoverageRaw,
        bound: decision.bound,
        agentCoveredBalance: coveredBalanceRaw,
        agentAddress: body.agentAddress,
      });
    }

    const premium = decision?.premiumRaw ?? null;
    const mandate = decision?.mandate;

    if (premiumBps == null || premium == null || decision == null || mandate == null) {
      // Defense-in-depth: EXTREME was already rejected above, but guard anyway.
      return reply.status(400).send({
        error: 'Risk tier is not insurable',
        code: 'AGENT_UNINSURABLE',
        agentAddress: body.agentAddress,
        riskTier: tier,
        assessmentId: latest.id,
      });
    }

    const mandateHash = agentMandateCommitment({
      maxSingleOutflowRaw: mandate.maxSingleOutflowRaw,
      maxWindowOutflowRaw: mandate.maxWindowOutflowRaw,
      windowSeconds: mandate.windowSeconds,
      minRetainedBalanceRaw: mandate.minRetainedBalanceRaw,
      allowedCounterparties: mandate.allowedCounterparties.map((k) => new PublicKey(k).toBytes()),
      allowedPrograms: mandate.allowedPrograms.map((k) => new PublicKey(k).toBytes()),
    });

    // Publish (or refresh) the on-chain attestation. The client needs the
    // PDA in the `create_policy` accounts list — without it, the program
    // will reject the transaction.
    let attestationPda: string | null = null;
    let attestationExpiresAt: string | null = null;
    try {
      const att = await app.attestationPublisher.ensureFresh(
        body.agentAddress,
        tier,
        mandateHash,
        // Zero: the envelope is derived, not chosen, so there is no extraction
        // capacity to charge for beyond what the payout cap already denies.
        0,
      );
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
      envelopeFlatPremium: decision.envelopeFlatPremiumRaw,
      // The ceiling the form validates against, and where it came from.
      maxCoverage: decision.maxCoverageRaw,
      maxCoverageBound: decision.maxCoverageBound,
      agentCoveredBalance: coveredBalanceRaw,
      // The envelope the purchase must declare. The oracle has committed to
      // this exact shape; `create_policy` refuses anything else.
      mandate,
      envelopeBasis: decision.envelopeBasis,
      ordinaryOutflow: decision.ordinaryOutflowRaw,
      backing,
    });
  });
}
