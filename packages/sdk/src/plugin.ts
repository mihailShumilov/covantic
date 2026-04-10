import { type RiskAssessment, type Policy, RiskTier } from '@covantic/shared';
import type { CovanticConfig } from './types.js';

/**
 * Covantic Plugin for Solana Agent Kit.
 * Provides insurance actions for AI agents performing DeFi operations.
 */
export class CovanticPlugin {
  name = 'covantic';
  description = 'AI Agent Insurance Protocol — buy coverage, submit claims, check risk';

  private apiUrl: string;
  private defaultCoverage: number;
  private defaultDuration: number;

  constructor(config: CovanticConfig) {
    this.apiUrl = config.apiUrl ?? 'https://api.covantic.xyz';
    this.defaultCoverage = config.defaultCoverage ?? 100_000_000; // 100 USDC
    this.defaultDuration = config.defaultDuration ?? 86400; // 24h
  }

  /** Register all actions with the Agent Kit */
  register(agent: { registerAction: (name: string, handler: (...args: any[]) => any) => void }) {
    agent.registerAction('getRiskScore', this.getRiskScore.bind(this));
    agent.registerAction('buyInsurance', this.buyInsurance.bind(this));
    agent.registerAction('getActivePolicy', this.getActivePolicy.bind(this));
    agent.registerAction('submitClaim', this.submitClaim.bind(this));
    agent.registerAction('cancelPolicy', this.cancelPolicy.bind(this));
  }

  /** Get LangChain tool definitions for the AI agent */
  getTools() {
    return [
      {
        name: 'covantic_get_risk_score',
        description:
          'Get the risk score and insurance premium quote for an AI agent wallet address',
        parameters: {
          type: 'object',
          properties: {
            agentAddress: { type: 'string', description: 'Solana wallet address of the agent' },
          },
          required: ['agentAddress'],
        },
        handler: this.getRiskScore.bind(this),
      },
      {
        name: 'covantic_buy_insurance',
        description:
          'Purchase an insurance policy to protect against DeFi losses. Pays premium in USDC.',
        parameters: {
          type: 'object',
          properties: {
            agentAddress: { type: 'string', description: 'Agent wallet to insure' },
            coverageAmount: { type: 'number', description: 'Coverage in USDC lamports' },
            durationSeconds: { type: 'number', description: 'Duration in seconds' },
          },
          required: ['agentAddress'],
        },
        handler: this.buyInsurance.bind(this),
      },
      {
        name: 'covantic_get_active_policy',
        description: 'Check if the agent has an active insurance policy',
        parameters: {
          type: 'object',
          properties: {
            agentAddress: { type: 'string', description: 'Agent wallet address' },
          },
          required: ['agentAddress'],
        },
        handler: this.getActivePolicy.bind(this),
      },
      {
        name: 'covantic_submit_claim',
        description: 'Submit an insurance claim after a covered incident',
        parameters: {
          type: 'object',
          properties: {
            policyId: { type: 'number', description: 'Policy ID' },
            triggerType: {
              type: 'number',
              description: '1=Exploit, 2=Oracle, 3=AgentError, 4=Governance',
            },
            txSignature: { type: 'string', description: 'Transaction signature of the incident' },
          },
          required: ['policyId', 'triggerType', 'txSignature'],
        },
        handler: this.submitClaim.bind(this),
      },
      {
        name: 'covantic_cancel_policy',
        description: 'Cancel an active insurance policy with partial refund',
        parameters: {
          type: 'object',
          properties: {
            policyId: { type: 'number', description: 'Policy ID to cancel' },
          },
          required: ['policyId'],
        },
        handler: this.cancelPolicy.bind(this),
      },
    ];
  }

  /** Get risk score for an agent address */
  async getRiskScore(params: { agentAddress: string }): Promise<RiskAssessment> {
    const res = await fetch(`${this.apiUrl}/api/risk/${params.agentAddress}`);
    if (!res.ok) throw new Error(`Failed to get risk score: ${res.statusText}`);
    return res.json();
  }

  /** Buy insurance for an agent. Fetches agent's actual risk tier for accurate quoting. */
  async buyInsurance(params: {
    agentAddress: string;
    coverageAmount?: number;
    durationSeconds?: number;
  }): Promise<{ quote: any; message: string }> {
    const coverage = params.coverageAmount ?? this.defaultCoverage;
    const duration = params.durationSeconds ?? this.defaultDuration;

    // Fetch agent's actual risk tier instead of hardcoding
    const riskAssessment = await this.getRiskScore({ agentAddress: params.agentAddress });
    const riskTier = riskAssessment.tier;

    if (riskTier === RiskTier.EXTREME) {
      return {
        quote: null,
        message: `Agent ${params.agentAddress} has EXTREME risk (score: ${riskAssessment.score}) and is not eligible for insurance.`,
      };
    }

    const quoteRes = await fetch(`${this.apiUrl}/api/policies/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coverageAmount: coverage,
        durationSeconds: duration,
        riskTier,
      }),
    });

    if (!quoteRes.ok) throw new Error(`Failed to get quote: ${quoteRes.statusText}`);
    const quote = await quoteRes.json();

    return {
      quote,
      message: `Insurance quote: ${quote.premiumAmount} USDC premium for ${coverage / 1_000_000} USDC coverage. Use on-chain transaction to complete purchase.`,
    };
  }

  /** Get active policy for an agent */
  async getActivePolicy(params: { agentAddress: string }): Promise<Policy | null> {
    const res = await fetch(`${this.apiUrl}/api/policies?agent=${params.agentAddress}&state=0`);
    if (!res.ok) throw new Error(`Failed to get policies: ${res.statusText}`);
    const data = await res.json();
    return data.policies?.[0] ?? null;
  }

  /** Submit an insurance claim (requires on-chain transaction) */
  async submitClaim(params: {
    policyId: number;
    triggerType: number;
    txSignature: string;
  }): Promise<{ message: string }> {
    throw new Error(
      `Claim submission requires an on-chain transaction. ` +
        `Policy: ${params.policyId}, Trigger: ${params.triggerType}, TX: ${params.txSignature}. ` +
        `Use the Anchor SDK to call submit_claim instruction directly.`,
    );
  }

  /** Cancel an active policy (requires on-chain transaction) */
  async cancelPolicy(params: { policyId: number }): Promise<{ message: string }> {
    throw new Error(
      `Policy cancellation requires an on-chain transaction. ` +
        `Policy: ${params.policyId}. Refund = remaining time * premium * 80%. ` +
        `Use the Anchor SDK to call cancel_policy instruction directly.`,
    );
  }
}
