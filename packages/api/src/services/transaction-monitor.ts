import { inArray } from 'drizzle-orm';
import { MonitoringEventType, PolicyState, canonicalMint } from '@covantic/shared';
import type { Database } from '../config/database.js';
import { policies, monitoringEvents } from '../db/schema.js';
import type { EnhancedTransaction } from '../utils/helius.js';
import { logger } from '../utils/logger.js';
import type Redis from 'ioredis';
import { publishAlert } from './alert-bus.js';
import { isKnownEventType } from './event-vocabulary.js';
import { loadOutflowBaseline, recordOutflow } from './agent-error/baseline.js';
import { screenForMandateBreach } from './agent-error/prefilter.js';
import type { MandateView, OutflowBaselineView } from './agent-error/types.js';
import { screenForOracleDeviation } from './oracle/prefilter.js';
import { screenEnhancedForExploit, type BalanceBaseline } from './exploit/prefilter.js';
import { loadBalanceBaseline } from './exploit/baseline.js';
import { positionFromEnhanced } from './exploit/position.js';
import type { PriceOracle } from './oracle/types.js';
import { incrementMetric } from '../utils/monitor-metrics.js';

/**
 * How specifically each anomaly type names what went wrong. The most specific
 * one wins the single open-claim slot a policy has.
 *
 * Complete over {@link MonitoringEventType} on purpose, even for the types
 * this monitor never raises. A rank that is merely *absent* silently becomes
 * zero — below `large_transfer` — which is how a governance takeover would
 * have been filed as an AgentError: the map had no governance entry, so the
 * most specific statement available about the incident lost to the least.
 * Making the record total means a new event type cannot be added without
 * deciding where it sits.
 */
const ANOMALY_SPECIFICITY: Record<MonitoringEventType, number> = {
  // Above `exploit`, and the ordering is load-bearing. A takeover that also
  // drains is a takeover: filing it as an Exploit routes it to a verifier
  // that can measure the drop but has nothing to say about who owns the
  // account now — and the seizure-without-drain shape, where the balance
  // never moves at all, would be rejected outright as `no_net_loss`.
  [MonitoringEventType.GovernanceAttack]: 5,
  // A policy holds one open claim (`claims_open_unique`), so the first
  // anomaly published decides the trigger type for the whole incident. A
  // drain that also looks like a bad fill is a drain, and filing it as
  // OracleManipulation would route it to a verifier with nothing to say
  // about authorization.
  [MonitoringEventType.Exploit]: 4,
  [MonitoringEventType.OracleDeviation]: 3,
  // Raised by this monitor now, where it previously never was: the mandate
  // screen names a movement that fell outside what the holder declared, which
  // is a statement about a covered event rather than about a size.
  [MonitoringEventType.AgentError]: 2,
  // Both of these are recorded and alerted on, but neither opens a claim any
  // more (`EVENT_TO_TRIGGER` maps them to `undefined`). Their ranks matter
  // only for ordering the alerts that reach a human.
  [MonitoringEventType.FailedTx]: 1,
  [MonitoringEventType.LargeTransfer]: 1,
  [MonitoringEventType.BalanceDropUnexplained]: 0,
};

function specificity(type: string): number {
  return isKnownEventType(type) ? ANOMALY_SPECIFICITY[type] : 0;
}

/**
 * Helius enhanced transaction envelope.
 *
 * Widened from the three fields the size/failure checks needed once price
 * screening arrived: deciding whether a swap was filled badly requires the
 * balance deltas and the invoked programs, not just the transfer amounts.
 *
 * `tokenTransfers[].mint` is declared because its *absence* was a bug. The old
 * size threshold summed `tokenAmount` across every transfer with no reference
 * to which asset it was, so a number reasoned about as dollars was compared
 * against a count of tokens: 1,001 units of a worthless airdrop tripped it and
 * 0.4 WBTC did not.
 */
interface WebhookTransaction {
  signature?: string;
  transactionError?: unknown;
  /** Block time, unix seconds — the instant every price lookup anchors to. */
  timestamp?: number;
  slot?: number;
  fee?: number;
  feePayer?: string;
  instructions?: unknown;
  accountData?: unknown;
  nativeTransfers?: unknown;
  tokenTransfers?: Array<{ fromUserAccount?: string; tokenAmount?: number; mint?: string }>;
}

interface PolicyLookupRow {
  agentAddress: string;
  holderAddress: string;
  policyId: number;
  state: number;
}

/**
 * Reads the operating envelope a holder declared for their agent.
 *
 * Injected rather than imported so the monitor stays free of Anchor-program
 * coupling and a test can drive it without an RPC.
 *
 * The three-way return is the whole contract. `null` means the lookup ran and
 * found no declaration — a policy that predates the mechanism, and there is
 * nothing to claim against. A **throw** means the lookup could not run, which
 * is an outage: the screen must then fail open and let the verifier, which has
 * retries, decide. Collapsing those two would make an RPC hiccup look exactly
 * like a holder who never declared.
 */
export type MandateLookup = (
  holderAddress: string,
  policyId: number,
) => Promise<MandateView | null>;

/** What the screens for one agent are given, gathered once per transaction. */
interface AgentContext {
  policyId: number;
  holderAddress: string;
  balanceBaseline: BalanceBaseline | undefined;
  /** `undefined` when the lookup could not run — an outage, not an absence. */
  mandate: MandateView | null | undefined;
  outflowBaseline: OutflowBaselineView | null;
}

/**
 * Transaction monitor service.
 * Processes Helius webhooks for real-time agent transaction monitoring.
 *
 * Alerts are fanned out on the internal signed alert bus
 * ({@link publishAlert}) so the claim-keeper (and only processes holding
 * ALERT_HMAC_SECRET) can act on them.
 *
 * Observability: every decision (match, skip-uninsured, skip-inactive) is
 * counted via {@link incrementMetric} and the inactive-policy case is logged
 * at `info` — it's the single most useful breadcrumb when debugging
 * "webhook fired but nothing happened".
 */
export class TransactionMonitor {
  constructor(
    private db: Database,
    private redis: Redis,
    private alertSecret: string,
    /** Multi-source pricer used to screen swaps. Optional so the monitor
     *  still runs without it — but with it absent, oracle manipulation is
     *  invisible to the pipeline. */
    private priceOracle?: PriceOracle,
    /** Reads the declared operating envelope. Optional for the same reason:
     *  without it, mandate breaches are invisible and agent-error claims are
     *  never opened. */
    private mandateLookup?: MandateLookup,
    /** Mint the mandate's amounts are denominated in. */
    private coveredMint?: string,
  ) {}

  async processWebhook(payload: WebhookTransaction[]): Promise<void> {
    for (const tx of payload) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        await incrementMetric(this.redis, 'error:tx');
        logger.error({ error, tx: tx?.signature }, 'Failed to process transaction');
      }
    }
  }

  private async processTransaction(tx: WebhookTransaction): Promise<void> {
    const signature = tx.signature;
    const tokenTransfers = tx.tokenTransfers ?? [];

    // Collect distinct agent addresses so we hit the DB once, not N times.
    const addresses = Array.from(
      new Set(
        tokenTransfers
          .map((t) => t.fromUserAccount)
          .filter((a): a is string => typeof a === 'string' && a.length > 0),
      ),
    );
    if (addresses.length === 0) {
      await incrementMetric(this.redis, 'skipped:no_addresses');
      return;
    }

    // Fetch ALL policies for these addresses (not just Active) so we can
    // tell "no policy at all" apart from "policy exists but state != Active".
    // The latter is the interesting signal when debugging why a tx didn't
    // produce an alert — it's the difference between "agent uninsured" and
    // "coverage expired / claim already filed".
    const insuredRows: PolicyLookupRow[] = await this.db
      .select({
        agentAddress: policies.agentAddress,
        holderAddress: policies.holderAddress,
        policyId: policies.policyId,
        state: policies.state,
      })
      .from(policies)
      .where(inArray(policies.agentAddress, addresses));

    const byAddress = new Map<string, PolicyLookupRow[]>();
    for (const row of insuredRows) {
      const list = byAddress.get(row.agentAddress) ?? [];
      list.push(row);
      byAddress.set(row.agentAddress, list);
    }

    const active = new Map<string, PolicyLookupRow>();
    for (const addr of addresses) {
      const list = byAddress.get(addr) ?? [];
      if (list.length === 0) {
        await incrementMetric(this.redis, 'skipped:uninsured');
        continue;
      }
      const activePolicy = list.find((p) => p.state === PolicyState.Active);
      if (activePolicy) {
        active.set(addr, activePolicy);
        await incrementMetric(this.redis, 'matched:active');
      } else {
        await incrementMetric(this.redis, 'skipped:inactive_policy');
        logger.info(
          {
            agentAddress: addr,
            txSignature: signature,
            policies: list.map((p) => ({ policyId: p.policyId, state: p.state })),
          },
          'monitor: tx from agent with no Active policy — skipped',
        );
      }
    }

    if (active.size === 0) return;

    // One context read per agent, not per transfer. Detection used to run
    // inside the transfer loop, which meant N database round-trips and — worse
    // — N copies of every anomaly for a transaction with several outgoing
    // legs, each one a separate row and a separate alert for the same event.
    const contexts = new Map<string, AgentContext>();
    for (const [agentAddress, policy] of active) {
      contexts.set(agentAddress, await this.loadContext(agentAddress, policy, tx));
    }

    for (const [agentAddress, context] of contexts) {
      const anomalies = await this.detectAnomalies(tx, agentAddress, context);

      for (const anomaly of anomalies) {
        await this.db.insert(monitoringEvents).values({
          agentAddress,
          eventType: anomaly.type,
          severity: anomaly.severity,
          txSignature: signature,
          details: anomaly.details,
        });

        await publishAlert(this.redis, this.alertSecret, {
          channel: 'monitoring:alerts',
          event: anomaly.type,
          data: {
            agentAddress,
            ...anomaly,
            txSignature: signature,
          },
          timestamp: Date.now(),
        });

        await incrementMetric(
          this.redis,
          anomaly.severity === 'critical' ? 'anomaly:critical' : 'anomaly:warning',
        );

        logger.warn(
          { agentAddress, type: anomaly.type, severity: anomaly.severity, txSignature: signature },
          'Anomaly detected',
        );
      }

      // Recorded regardless of whether anything was flagged. The history is
      // what makes "100x this agent's own average" computable at all, and an
      // agent whose ordinary payments were never recorded has no average.
      await this.recordOutflows(tx, agentAddress);
    }
  }

  /**
   * Gather everything the screens need for one agent, once.
   *
   * Every lookup here is allowed to fail. Detection is the half of the
   * pipeline that fails open: a baseline that cannot be read weakens a ratio
   * test, and a mandate that cannot be read is reported as *unknown* rather
   * than as *absent*, which is what lets the size screen still raise a
   * candidate for the verifier to resolve.
   */
  private async loadContext(
    agentAddress: string,
    policy: PolicyLookupRow,
    tx: WebhookTransaction,
  ): Promise<AgentContext> {
    let balanceBaseline: BalanceBaseline | undefined;
    try {
      balanceBaseline = await loadBalanceBaseline(this.db, agentAddress);
    } catch (error) {
      logger.warn({ error, agentAddress }, 'monitor: balance baseline unavailable');
    }

    let mandate: MandateView | null | undefined;
    if (this.mandateLookup) {
      try {
        mandate = await this.mandateLookup(policy.holderAddress, policy.policyId);
      } catch (error) {
        // Left `undefined` on purpose — see {@link MandateLookup}. An outage
        // must not read as "this holder declared nothing".
        logger.warn(
          { error, agentAddress, policyId: policy.policyId },
          'monitor: mandate unreadable; screening will fail open',
        );
      }
    }

    let outflowBaseline: OutflowBaselineView | null = null;
    if (this.coveredMint && mandate) {
      try {
        outflowBaseline = await loadOutflowBaseline(
          this.db,
          agentAddress,
          canonicalMint(this.coveredMint),
          blockTimeOf(tx),
          mandate.windowSeconds,
        );
      } catch (error) {
        logger.warn({ error, agentAddress }, 'monitor: outflow baseline unavailable');
      }
    }

    return {
      policyId: policy.policyId,
      holderAddress: policy.holderAddress,
      balanceBaseline,
      mandate,
      outflowBaseline,
    };
  }

  /** Persist what left the agent, one row per mint, idempotent per signature. */
  private async recordOutflows(tx: WebhookTransaction, agentAddress: string): Promise<void> {
    if (!tx.signature) return;
    const position = positionFromEnhanced(tx as unknown as EnhancedTransaction, agentAddress);
    const blockTime = blockTimeOf(tx);
    for (const leg of position.legs) {
      if (leg.deltaRaw >= 0) continue;
      await recordOutflow(this.db, {
        agentAddress,
        txSignature: tx.signature,
        mint: canonicalMint(leg.mint),
        amountRaw: Math.abs(leg.deltaRaw),
        decimals: leg.decimals,
        blockTime,
      });
    }
  }

  private async detectAnomalies(
    tx: WebhookTransaction,
    agentAddress: string,
    context: AgentContext,
  ): Promise<Array<{ type: string; severity: string; details: Record<string, unknown> }>> {
    const anomalies: Array<{ type: string; severity: string; details: Record<string, unknown> }> =
      [];

    // Mandate screening. This is the only branch that opens an agent-error
    // claim, and that is the design rather than an omission: the covered event
    // *is* a movement outside the envelope the holder declared, so a signal
    // that cannot reference a declaration cannot describe one.
    //
    // The fail-open case is the `undefined` mandate — an outage. There the
    // screen still raises `agent_error` on a large movement, because a real
    // breach must not become invisible for as long as an RPC is unhappy; the
    // verifier re-reads the mandate and resolves it.
    const enhanced = tx as unknown as EnhancedTransaction;
    const screen = screenForMandateBreach(enhanced, agentAddress, {
      mandate: context.mandate,
      outflowBaseline: context.outflowBaseline,
      coveredMint: this.coveredMint,
    });
    if (screen.flagged) {
      const opensClaim =
        screen.reason === 'mandate_envelope_exceeded' ||
        (context.mandate === undefined && screen.severity === 'critical');
      anomalies.push({
        type: opensClaim ? MonitoringEventType.AgentError : MonitoringEventType.LargeTransfer,
        severity: screen.severity,
        details: {
          screenReason: screen.reason,
          mandateReadable: context.mandate !== undefined,
          ...screen.detail,
        },
      });
    }

    // Fee burn. Recorded and alerted on, never a claim: a reverted transaction
    // moved no funds, and `EVENT_TO_TRIGGER` maps this to `undefined` so it
    // cannot occupy the policy's single open-claim slot.
    if (tx.transactionError) {
      anomalies.push({
        type: MonitoringEventType.FailedTx,
        severity: 'warning',
        details: { error: tx.transactionError },
      });
    }

    // Exploit screening. Until this existed, `exploit` was emitted by nothing
    // in production — the only producer was the demo endpoint — so an insured
    // agent could be drained to zero and no claim would ever open.
    //
    // The indexer payload cannot answer authorization, so this screen leans on
    // relative magnitude and control instructions and lets the verifier do the
    // real work from the chain's own record. Detection fails open.
    const exploitScreen = screenEnhancedForExploit(enhanced, agentAddress, {
      baseline: context.balanceBaseline,
    });
    if (exploitScreen.flagged) {
      anomalies.push({
        type: MonitoringEventType.Exploit,
        severity: exploitScreen.severity,
        details: { screenReason: exploitScreen.reason, ...exploitScreen.detail },
      });
    }

    // Price screening. Without this the protocol sells cover against oracle
    // manipulation and has no way to notice it happening.
    if (this.priceOracle && !tx.transactionError) {
      // Helius sends the full enhanced transaction; the schema above keeps
      // unknown fields via passthrough, so the extra structure the screen
      // needs is present at runtime even though the validated type is loose.
      // Both `reconstructExecution` and `classifyPrograms` tolerate every
      // field being absent, so a thin payload degrades to "not a swap"
      // rather than throwing.
      const priceScreen = await screenForOracleDeviation(enhanced, agentAddress, this.priceOracle);
      if (priceScreen.flagged) {
        anomalies.push({
          type: MonitoringEventType.OracleDeviation,
          severity: priceScreen.severity,
          details: { screenReason: priceScreen.reason, ...priceScreen.detail },
        });
      }
    }

    // Order matters more than it looks. A policy may hold only one open claim
    // (`claims_open_unique`), so whichever anomaly is published first decides
    // the trigger type for the whole incident. A large swap raises both
    // `agent_error` and `oracle_deviation`; filing it as AgentError would send
    // it to a verifier that measures movements against a spending envelope,
    // and the manipulation evidence would never be looked at.
    return anomalies.sort((a, b) => specificity(b.type) - specificity(a.type));
  }
}

/**
 * When the transaction executed.
 *
 * Falls back to now when the payload carries no timestamp, and the fallback is
 * the reason this is a named function rather than an inline expression: a
 * history summed against the wrong instant is worse than no history, so the
 * substitution should be visible to anyone reading the call sites.
 */
function blockTimeOf(tx: WebhookTransaction): Date {
  return typeof tx.timestamp === 'number' && tx.timestamp > 0
    ? new Date(tx.timestamp * 1000)
    : new Date();
}
