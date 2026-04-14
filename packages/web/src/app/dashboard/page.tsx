'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { RiskAssessmentPipeline } from '@/components/risk/RiskAssessmentPipeline';
import { apiGet, apiPost } from '@/lib/api-client';
import Link from 'next/link';
import {
  formatUsdc,
  PolicyState,
  type Policy,
  type StakerPositionResponse,
} from '@covantic/shared';
import {
  TIER_LABELS,
  TIER_BADGE_VARIANTS,
  STATE_LABELS,
  STATE_BADGE_VARIANTS,
} from '@/lib/risk-labels';
import {
  useCovanticProgram,
  deriveConfigPda,
  deriveVaultPda,
  derivePolicyPda,
} from '@/hooks/useCovanticProgram';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Anchor returns BN for u64/i64 fields. Guard for both BN and raw number.
function bnToNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

function mapOnChainPolicy(account: any, pda: PublicKey): Policy {
  const claimSubmittedAtSec = bnToNumber(account.claimSubmittedAt);
  const triggerTxBytes: Uint8Array | number[] | undefined = account.triggerTxSignature;
  return {
    policyId: bnToNumber(account.policyId),
    holder: (account.holder as PublicKey).toBase58(),
    agentAddress: (account.agentAddress as PublicKey).toBase58(),
    coverageAmount: bnToNumber(account.coverageAmount),
    premiumPaid: bnToNumber(account.premiumPaid),
    riskTier: account.riskTier as number,
    startTime: new Date(bnToNumber(account.startTime) * 1000),
    expiryTime: new Date(bnToNumber(account.expiryTime) * 1000),
    claimSubmittedAt:
      claimSubmittedAtSec > 0 ? new Date(claimSubmittedAtSec * 1000) : null,
    state: account.state as PolicyState,
    triggerType: account.triggerType as number,
    triggerTxSignature:
      triggerTxBytes && triggerTxBytes.length > 0
        ? Buffer.from(triggerTxBytes).toString('utf8')
        : null,
    payoutAmount: bnToNumber(account.payoutAmount),
    pdaAddress: pda.toBase58(),
    createTxSignature: null,
  };
}

interface RiskApiResponse {
  assessmentId: string;
  agentAddress: string;
  score: number;
  tier: number;
  premiumBps: number | null;
  isInsurable?: boolean;
  factors: Record<string, number>;
  factorDetails: any[];
  categoryRisks: any[];
  weightInfo: any[];
  dataAvailability: any;
  overallConfidence: number;
  summary: string;
  recommendation: string;
  assessedAt: string;
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const { program } = useCovanticProgram();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [riskResult, setRiskResult] = useState<RiskApiResponse | null>(null);
  const [isAssessing, setIsAssessing] = useState(false);
  const [pipelineKey, setPipelineKey] = useState(0);
  const [agentAddress, setAgentAddress] = useState('');
  const [stakerPosition, setStakerPosition] = useState<StakerPositionResponse | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setStakerPosition(null);
      return;
    }
    apiGet<StakerPositionResponse>(`/api/staking/${publicKey.toBase58()}`)
      .then(setStakerPosition)
      .catch(() => setStakerPosition(null));
  }, [publicKey]);

  // Read policies from chain rather than the API — the backend doesn't index
  // on-chain createPolicy events, so the DB is empty for fresh policies.
  const refreshPolicies = useCallback(async () => {
    if (!program || !publicKey) {
      setPolicies([]);
      return;
    }
    try {
      // offset = 8 (discriminator) + 8 (policy_id u64) — holder pubkey starts here.
      // memcmp.bytes is base58, which PublicKey.toBase58() already gives us.
      const accounts = await (program.account as any).insurancePolicy.all([
        { memcmp: { offset: 16, bytes: publicKey.toBase58() } },
      ]);
      const mapped: Policy[] = accounts
        .map(({ account, publicKey: pda }: any) => mapOnChainPolicy(account, pda))
        .sort((a: Policy, b: Policy) => Number(b.startTime) - Number(a.startTime));
      setPolicies(mapped);
    } catch (err) {
      console.warn('Failed to load on-chain policies', err);
      setPolicies([]);
    }
  }, [program, publicKey]);

  useEffect(() => {
    refreshPolicies();
  }, [refreshPolicies]);

  const handleGetRisk = async () => {
    if (!agentAddress || isAssessing) return;
    if (!SOLANA_ADDRESS_RE.test(agentAddress)) return;

    // 1. Clear previous results and start pipeline animation (fetching phase)
    setRiskResult(null);
    setIsAssessing(true);
    setPipelineKey((k) => k + 1);

    // 2. Fire API call — pipeline shows "fetching" animation until result arrives
    try {
      const result = await apiGet<RiskApiResponse>(`/api/risk/${agentAddress}`);
      setRiskResult(result);
      // Update URL to shareable assessment link without navigating away
      if (result.assessmentId && UUID_RE.test(result.assessmentId)) {
        window.history.replaceState(null, '', `/assessment/${result.assessmentId}`);
      }
    } catch {
      setRiskResult(null);
    }
  };

  const handlePipelineComplete = () => {
    setIsAssessing(false);
  };

  return (
    <div style={{ padding: 'var(--space-lg) var(--space-md)', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-xl)',
          flexWrap: 'wrap',
          gap: 'var(--space-sm)',
        }}
      >
        <h1 style={{ fontSize: 'clamp(1.25rem, 3vw, 1.5rem)', fontWeight: 700 }}>Agent Dashboard</h1>
        <Button onClick={() => setShowBuyModal(true)}>Buy Policy</Button>
      </div>

      {/* Risk Assessment */}
      <Card title="Risk Assessment" style={{ marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <label
              style={{
                fontSize: '0.8125rem',
                color: 'var(--color-text-muted)',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Agent Wallet Address
            </label>
            <input
              value={agentAddress}
              onChange={(e) => setAgentAddress(e.target.value)}
              placeholder="Enter agent wallet address..."
              disabled={isAssessing}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.875rem',
                opacity: isAssessing ? 0.6 : 1,
              }}
            />
          </div>
          <Button onClick={handleGetRisk} size="md" disabled={isAssessing} style={{ flexShrink: 0, width: 'auto' }}>
            {isAssessing ? 'Scanning...' : 'Assess Risk'}
          </Button>
        </div>

        {/* Animated pipeline — stays visible after completion */}
        {pipelineKey > 0 && (
          <RiskAssessmentPipeline
            key={pipelineKey}
            result={riskResult as any}
            onComplete={handlePipelineComplete}
          />
        )}
      </Card>

      {/* My Stake */}
      <Card title="My Stake" style={{ marginBottom: 'var(--space-lg)' }}>
        {!publicKey ? (
          <p
            style={{
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              padding: 'var(--space-lg)',
            }}
          >
            Connect wallet to view your stake.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 'var(--space-md)',
              alignItems: 'center',
            }}
          >
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Staked</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                ${stakerPosition ? formatUsdc(stakerPosition.amountStaked) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Pool Share
              </p>
              <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                {stakerPosition ? (stakerPosition.shareBps / 100).toFixed(2) : '0'}%
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Pending Rewards
              </p>
              <p
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: 'var(--color-primary)',
                }}
              >
                ${stakerPosition ? formatUsdc(stakerPosition.rewardsPending) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Rewards Claimed
              </p>
              <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                ${stakerPosition ? formatUsdc(stakerPosition.rewardsClaimed) : '0.00'}
              </p>
            </div>
            <div style={{ justifySelf: 'end' }}>
              <Link href="/staking" style={{ textDecoration: 'none' }}>
                <Button variant="secondary">Manage Stake</Button>
              </Link>
            </div>
          </div>
        )}
      </Card>

      {/* Policies List */}
      <Card title="Your Policies">
        {policies.length === 0 ? (
          <p
            style={{
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              padding: 'var(--space-xl)',
            }}
          >
            {publicKey
              ? 'No policies yet. Buy your first policy!'
              : 'Connect wallet to view policies.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            {policies.map((policy) => (
              <div
                key={policy.policyId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 'var(--space-md)',
                  background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-md)',
                  flexWrap: 'wrap',
                  gap: 'var(--space-sm)',
                }}
              >
                <div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-sm)',
                      alignItems: 'center',
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>Policy #{policy.policyId}</span>
                    <Badge variant={STATE_BADGE_VARIANTS[policy.state]}>
                      {STATE_LABELS[policy.state]}
                    </Badge>
                    <Badge variant={TIER_BADGE_VARIANTS[policy.riskTier]}>
                      {TIER_LABELS[policy.riskTier]}
                    </Badge>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                    Coverage: ${formatUsdc(policy.coverageAmount)} &middot; Premium: $
                    {formatUsdc(policy.premiumPaid)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                    Expires: {new Date(policy.expiryTime).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Buy Policy Modal */}
      <Modal
        open={showBuyModal}
        onClose={() => setShowBuyModal(false)}
        title="Buy Insurance Policy"
      >
        <BuyPolicyForm
          onClose={() => setShowBuyModal(false)}
          onPolicyCreated={refreshPolicies}
        />
      </Modal>
    </div>
  );
}

function BuyPolicyForm({
  onClose,
  onPolicyCreated,
}: {
  onClose: () => void;
  onPolicyCreated?: () => void;
}) {
  const { publicKey } = useWallet();
  const { program } = useCovanticProgram();
  const [coverage, setCoverage] = useState('100');
  const [duration, setDuration] = useState('24');
  const [tier, setTier] = useState(0);
  const [agentAddr, setAgentAddr] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Debounce: wait 400ms after the last change before hitting the API.
    // This prevents hammering /api/policies/quote on every keystroke.
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const coverageNum = parseFloat(coverage);
      const durationNum = parseFloat(duration);
      if (!isFinite(coverageNum) || coverageNum <= 0 || !isFinite(durationNum) || durationNum <= 0) {
        return;
      }
      if (!SOLANA_ADDRESS_RE.test(agentAddr)) {
        setQuote(null);
        return;
      }
      try {
        const q = await apiPost('/api/policies/quote', {
          coverageAmount: coverageNum * 1_000_000,
          durationSeconds: durationNum * 3600,
          riskTier: tier,
          agentAddress: agentAddr,
        });
        setQuote(q);
      } catch {
        // Handle error
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [coverage, duration, tier, agentAddr]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Coverage (USDC)
        </label>
        <input
          type="number"
          value={coverage}
          onChange={(e) => setCoverage(e.target.value)}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text)',
          }}
        />
      </div>
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Duration (hours)
        </label>
        <input
          type="number"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text)',
          }}
        />
      </div>
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Risk Tier
        </label>
        <select
          value={tier}
          onChange={(e) => setTier(Number(e.target.value))}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text)',
          }}
        >
          <option value={0}>LOW (1%)</option>
          <option value={1}>MEDIUM (2.5%)</option>
          <option value={2}>HIGH (5%)</option>
        </select>
      </div>
      {quote && (
        <div
          style={{
            background: 'var(--color-bg)',
            padding: 'var(--space-md)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            Estimated Premium
          </p>
          <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-primary)' }}>
            ${formatUsdc(quote.premiumAmount)} USDC
          </p>
        </div>
      )}
      <div>
        <label
          style={{
            fontSize: '0.8125rem',
            color: 'var(--color-text-muted)',
            display: 'block',
            marginBottom: 4,
          }}
        >
          Agent Wallet Address
        </label>
        <input
          value={agentAddr}
          onChange={(e) => setAgentAddr(e.target.value)}
          placeholder="Agent pubkey..."
          style={{
            width: '100%',
            padding: '0.5rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.875rem',
          }}
        />
      </div>
      {error && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-danger)' }}>{error}</p>
      )}
      {txSig && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-primary)' }}>
          Sent!{' '}
          <a
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            View on Explorer
          </a>
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
        <Button variant="secondary" onClick={onClose} style={{ flex: 1 }} disabled={submitting}>
          Cancel
        </Button>
        <Button
          style={{ flex: 1 }}
          disabled={submitting || !program || !publicKey}
          onClick={async () => {
            setError(null);
            setTxSig(null);
            if (!program || !publicKey) {
              setError('Connect wallet first');
              return;
            }
            let agentPk: PublicKey;
            try {
              agentPk = new PublicKey(agentAddr);
            } catch {
              setError('Invalid agent address');
              return;
            }
            const coverageNum = Math.round(parseFloat(coverage) * 1_000_000);
            const durationNum = Math.round(parseFloat(duration) * 3600);
            if (!coverageNum || !durationNum) {
              setError('Invalid coverage or duration');
              return;
            }

            setSubmitting(true);
            try {
              const configPda = deriveConfigPda();
              const vaultPda = deriveVaultPda();
              const cfg: any = await (program.account as any).protocolConfig.fetch(configPda);
              const policyId: BN = cfg.policyCounter;
              const policyPda = derivePolicyPda(
                publicKey,
                BigInt(policyId.toString()),
              );
              const usdcMint = cfg.usdcMint as PublicKey;
              const holderAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
              const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

              const sig = await program.methods
                .createPolicy(
                  new BN(coverageNum),
                  new BN(durationNum),
                  tier,
                  agentPk,
                )
                .accounts({
                  holder: publicKey,
                  config: configPda,
                  vault: vaultPda,
                  policy: policyPda,
                  holderTokenAccount: holderAta,
                  vaultTokenAccount: vaultAta,
                  tokenProgram: TOKEN_PROGRAM_ID,
                } as any)
                .rpc();
              setTxSig(sig);
              onPolicyCreated?.();
            } catch (e: any) {
              setError(e?.message ?? 'Transaction failed');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? 'Sending...' : 'Buy Policy'}
        </Button>
      </div>
    </div>
  );
}
