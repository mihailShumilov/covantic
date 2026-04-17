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
import { Spinner } from '@/components/ui/Spinner';
import { RiskAssessmentPipeline } from '@/components/risk/RiskAssessmentPipeline';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import Link from 'next/link';
import {
  formatUsdc,
  PolicyState,
  RiskTier,
  SOLANA_ADDRESS_REGEX,
  type Policy,
  type PremiumQuote,
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
  deriveAttestationPda,
} from '@/hooks/useCovanticProgram';

const SOLANA_ADDRESS_RE = SOLANA_ADDRESS_REGEX;
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

/** Narrow assessment slice handed to the Buy Policy modal. */
interface AssessmentForBuy {
  agentAddress: string;
  tier: number;
  score: number;
  assessmentId: string;
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const { program } = useCovanticProgram();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [riskResult, setRiskResult] = useState<RiskApiResponse | null>(null);
  const [isAssessing, setIsAssessing] = useState(false);
  const [pipelineShown, setPipelineShown] = useState(false);
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
      // offset = 8 (discriminator) + 1 (version u8) + 8 (policy_id u64) — holder pubkey starts here.
      // memcmp.bytes is base58, which PublicKey.toBase58() already gives us.
      const accounts = await (program.account as any).insurancePolicy.all([
        { memcmp: { offset: 17, bytes: publicKey.toBase58() } },
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

  const runAssessment = useCallback(async (address: string) => {
    if (!SOLANA_ADDRESS_RE.test(address)) return;

    setAgentAddress(address);
    setRiskResult(null);
    setIsAssessing(true);
    setPipelineShown(true);
    setPipelineKey((k) => k + 1);

    try {
      const result = await apiGet<RiskApiResponse>(`/api/risk/${address}`);
      setRiskResult(result);
      if (result.assessmentId && UUID_RE.test(result.assessmentId)) {
        window.history.replaceState(null, '', `/assessment/${result.assessmentId}`);
      }
    } catch {
      setRiskResult(null);
    }
  }, []);

  const handleGetRisk = () => {
    if (!agentAddress || isAssessing) return;
    void runAssessment(agentAddress);
  };

  const handleReassess = useCallback(() => {
    if (!riskResult) return;
    setShowBuyModal(false);
    void runAssessment(riskResult.agentAddress);
  }, [riskResult, runAssessment]);

  const handlePipelineComplete = () => {
    setIsAssessing(false);
  };

  const isInsurable = !!riskResult && riskResult.tier !== RiskTier.EXTREME;
  const showBuyCta = !isAssessing && isInsurable;

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
        {pipelineShown && (
          <RiskAssessmentPipeline
            key={pipelineKey}
            result={riskResult as any}
            onComplete={handlePipelineComplete}
          />
        )}

        {/* Buy policy CTA — only after a successful, insurable assessment */}
        {showBuyCta && riskResult && (
          <div
            style={{
              marginTop: 'var(--space-md)',
              padding: 'var(--space-md)',
              background: 'var(--color-bg)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'var(--space-md)',
              flexWrap: 'wrap',
            }}
          >
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', margin: 0 }}>
              Agent is insurable. Buy a policy using the assessed risk tier.
            </p>
            <Button onClick={() => setShowBuyModal(true)} size="md" style={{ width: 'auto' }}>
              Buy Policy
            </Button>
          </div>
        )}

        {/* Uninsurable banner — EXTREME-tier agents cannot buy coverage */}
        {!isAssessing && riskResult && !isInsurable && (
          <div
            style={{
              marginTop: 'var(--space-md)',
              padding: 'var(--space-md)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-danger)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <p style={{ fontSize: '0.875rem', color: 'var(--color-danger)', margin: 0 }}>
              Agent is assessed as EXTREME risk and is not insurable.
            </p>
          </div>
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
              ? 'No policies yet. Analyze an agent above to buy your first policy.'
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
                  {policy.payoutAmount > 0 && (
                    <p
                      style={{
                        fontSize: '0.8125rem',
                        color: 'var(--color-primary)',
                        marginTop: 4,
                      }}
                    >
                      Paid out: ${formatUsdc(policy.payoutAmount)} USDC
                    </p>
                  )}
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

      {/* Buy Policy Modal — only renders when we have a live assessment */}
      <Modal
        open={showBuyModal && !!riskResult}
        onClose={() => setShowBuyModal(false)}
        title="Buy Insurance Policy"
      >
        {riskResult && (
          <BuyPolicyForm
            assessment={{
              agentAddress: riskResult.agentAddress,
              tier: riskResult.tier,
              score: riskResult.score,
              assessmentId: riskResult.assessmentId,
            }}
            onClose={() => setShowBuyModal(false)}
            onRequestReassess={handleReassess}
            onPolicyCreated={refreshPolicies}
          />
        )}
      </Modal>
    </div>
  );
}

/**
 * Buy Policy form — consumes the assessment handed in by the parent.
 *
 * `agentAddress` and `tier` are read-only because the server derives the tier
 * from the latest stored assessment. The form shows a live countdown until
 * the underlying assessment is too stale to quote against; once expired, the
 * submit button is replaced with a prompt to re-analyze.
 */
type TxPhase = 'idle' | 'approving' | 'sending' | 'confirming' | 'success' | 'error';

function BuyPolicyForm({
  assessment,
  onClose,
  onRequestReassess,
  onPolicyCreated,
}: {
  assessment: AssessmentForBuy;
  onClose: () => void;
  onRequestReassess: () => void;
  onPolicyCreated?: () => void;
}) {
  const { publicKey } = useWallet();
  const { program, provider } = useCovanticProgram();
  const [coverage, setCoverage] = useState('100');
  const [duration, setDuration] = useState('24');
  const [quote, setQuote] = useState<PremiumQuote | null>(null);
  const [txPhase, setTxPhase] = useState<TxPhase>('idle');
  const [txSig, setTxSig] = useState<string | null>(null);
  const [confirmedCoverage, setConfirmedCoverage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteErrorCode, setQuoteErrorCode] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitting =
    txPhase === 'approving' || txPhase === 'sending' || txPhase === 'confirming';

  // Tick every second so the "Quote valid for MM:SS" countdown updates live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Debounce quote refresh — avoid hammering the endpoint on every keystroke.
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const coverageNum = parseFloat(coverage);
      const durationNum = parseFloat(duration);
      if (
        !isFinite(coverageNum) ||
        coverageNum <= 0 ||
        !isFinite(durationNum) ||
        durationNum <= 0
      ) {
        setQuote(null);
        return;
      }
      try {
        const q = await apiPost<PremiumQuote>('/api/policies/quote', {
          coverageAmount: Math.round(coverageNum * 1_000_000),
          durationSeconds: Math.round(durationNum * 3600),
          agentAddress: assessment.agentAddress,
        });
        setQuote(q);
        setQuoteErrorCode(null);
        setError(null);
      } catch (e) {
        setQuote(null);
        if (e instanceof ApiError) {
          setQuoteErrorCode(e.code ?? null);
          setError(e.message);
        } else {
          setQuoteErrorCode(null);
          setError(e instanceof Error ? e.message : 'Failed to fetch quote');
        }
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [coverage, duration, assessment.agentAddress]);

  const validUntilMs = quote ? new Date(quote.validUntil).getTime() : 0;
  const msLeft = validUntilMs ? validUntilMs - now : 0;
  const quoteExpired = quote != null && msLeft <= 0;
  const staleFromServer = quoteErrorCode === 'ASSESSMENT_STALE';
  const needsReassess = quoteExpired || staleFromServer;

  const countdown = (() => {
    if (!quote || msLeft <= 0) return null;
    const totalSec = Math.floor(msLeft / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  })();

  const tierLabel = TIER_LABELS[assessment.tier] ?? 'UNKNOWN';
  const tierBadgeVariant = TIER_BADGE_VARIANTS[assessment.tier] ?? 'neutral';

  const handleBuy = async () => {
    setError(null);
    setTxSig(null);
    if (!program || !provider || !publicKey) {
      setError('Connect wallet first');
      return;
    }
    if (!quote) {
      setError('Waiting for premium quote');
      return;
    }
    let agentPk: PublicKey;
    try {
      agentPk = new PublicKey(assessment.agentAddress);
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

    try {
      setTxPhase('approving');
      const configPda = deriveConfigPda();
      const vaultPda = deriveVaultPda();
      const attestationPda = deriveAttestationPda(agentPk);
      const cfg: any = await (program.account as any).protocolConfig.fetch(configPda);
      const policyId: BN = cfg.policyCounter;
      const policyPda = derivePolicyPda(publicKey, BigInt(policyId.toString()));
      const usdcMint = cfg.usdcMint as PublicKey;
      const holderAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

      const tx = await program.methods
        .createPolicy(new BN(coverageNum), new BN(durationNum), agentPk)
        .accounts({
          holder: publicKey,
          config: configPda,
          vault: vaultPda,
          attestation: attestationPda,
          policy: policyPda,
          holderTokenAccount: holderAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .transaction();

      const { blockhash, lastValidBlockHeight } =
        await provider.connection.getLatestBlockhash('confirmed');
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;

      // Phase 1 — wait for the user to approve the tx in Phantom.
      const signed = await provider.wallet.signTransaction(tx);

      // Phase 2 — broadcast the signed tx to the cluster.
      setTxPhase('sending');
      const sig = await provider.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });

      // Phase 3 — wait for the cluster to confirm inclusion.
      setTxPhase('confirming');
      const conf = await provider.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (conf.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
      }

      setTxSig(sig);
      setConfirmedCoverage(coverageNum);
      setTxPhase('success');
      onPolicyCreated?.();
    } catch (e: any) {
      const msg = e?.message ?? 'Transaction failed';
      const userRejected = /reject|denied|cancel/i.test(msg);
      setError(userRejected ? 'Transaction rejected in wallet.' : msg);
      setTxPhase('error');
    }
  };

  if (txPhase === 'success') {
    return (
      <TxResultSuccess
        txSig={txSig}
        coverageAmount={confirmedCoverage ?? 0}
        onDone={onClose}
      />
    );
  }

  if (submitting) {
    return <TxProcessing phase={txPhase} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      {/* Locked assessment summary — agent + tier come from the scan, not user input */}
      <div
        style={{
          padding: 'var(--space-md)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
        }}
      >
        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--color-text-muted)',
              margin: 0,
              marginBottom: 2,
            }}
          >
            Agent wallet
          </p>
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
              wordBreak: 'break-all',
            }}
          >
            {assessment.agentAddress}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            Assessed tier
          </span>
          <Badge variant={tierBadgeVariant}>{tierLabel}</Badge>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            Score {(assessment.score * 100).toFixed(0)}/100
          </span>
        </div>
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

      {quote && !quoteExpired && (
        <div
          style={{
            background: 'var(--color-bg)',
            padding: 'var(--space-md)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', margin: 0 }}>
            Estimated Premium
          </p>
          <p
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              color: 'var(--color-primary)',
              margin: 0,
            }}
          >
            ${formatUsdc(quote.premiumAmount)} USDC
          </p>
          {countdown && (
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
                marginTop: 4,
                marginBottom: 0,
              }}
            >
              Quote valid for {countdown}
            </p>
          )}
        </div>
      )}

      {needsReassess && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-danger)', margin: 0 }}>
          Risk assessment expired — re-analyze the agent to refresh the quote.
        </p>
      )}

      {error && !needsReassess && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--color-danger)', margin: 0 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
        <Button variant="secondary" onClick={onClose} style={{ flex: 1 }} disabled={submitting}>
          Cancel
        </Button>
        {needsReassess ? (
          <Button style={{ flex: 1 }} onClick={onRequestReassess}>
            Re-analyze Agent
          </Button>
        ) : (
          <Button
            style={{ flex: 1 }}
            disabled={submitting || !program || !publicKey || !quote}
            onClick={handleBuy}
          >
            Buy Policy
          </Button>
        )}
      </div>
    </div>
  );
}

/** Full-modal view shown while the transaction is in flight. */
function TxProcessing({ phase }: { phase: TxPhase }) {
  const steps: { key: TxPhase; label: string; hint: string }[] = [
    {
      key: 'approving',
      label: 'Approve in wallet',
      hint: 'Confirm the transaction in your wallet to continue.',
    },
    {
      key: 'sending',
      label: 'Broadcasting',
      hint: 'Sending the signed transaction to the Solana cluster.',
    },
    {
      key: 'confirming',
      label: 'Confirming on-chain',
      hint: 'Waiting for the network to confirm the policy.',
    },
  ];
  const order: TxPhase[] = ['approving', 'sending', 'confirming'];
  const currentIdx = order.indexOf(phase);
  const active = steps.find((s) => s.key === phase);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-md)',
          background: 'var(--color-bg)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
        }}
      >
        <Spinner size={20} />
        <div>
          <p style={{ margin: 0, fontWeight: 600 }}>{active?.label ?? 'Processing...'}</p>
          <p
            style={{
              margin: 0,
              fontSize: '0.8125rem',
              color: 'var(--color-text-muted)',
            }}
          >
            {active?.hint ?? 'Please wait...'}
          </p>
        </div>
      </div>
      <ol
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
        }}
      >
        {steps.map((step, idx) => {
          const isDone = idx < currentIdx;
          const isActive = idx === currentIdx;
          const color = isDone
            ? 'var(--color-primary)'
            : isActive
              ? 'var(--color-text)'
              : 'var(--color-text-muted)';
          return (
            <li
              key={step.key}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  border: `1px solid ${isDone ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  background: isDone ? 'var(--color-primary)' : 'transparent',
                  color: isDone ? 'var(--color-bg)' : color,
                  fontSize: '0.75rem',
                  fontWeight: 700,
                }}
              >
                {isDone ? '✓' : idx + 1}
              </span>
              <span style={{ color, fontSize: '0.875rem' }}>{step.label}</span>
              {isActive && <Spinner size={14} />}
            </li>
          );
        })}
      </ol>
      <p
        style={{
          fontSize: '0.75rem',
          color: 'var(--color-text-muted)',
          margin: 0,
          textAlign: 'center',
        }}
      >
        Do not close this window until the transaction is confirmed.
      </p>
    </div>
  );
}

/** Full-modal view shown after a successful policy creation. */
function TxResultSuccess({
  txSig,
  coverageAmount,
  onDone,
}: {
  txSig: string | null;
  coverageAmount: number;
  onDone: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-lg) var(--space-md)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-primary)',
          borderRadius: 'var(--radius-md)',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'var(--color-primary)',
            color: 'var(--color-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.5rem',
            fontWeight: 700,
          }}
        >
          ✓
        </div>
        <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>Policy created</h3>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
          Your coverage of ${formatUsdc(coverageAmount)} USDC is now active.
        </p>
      </div>

      {txSig && (
        <div
          style={{
            padding: 'var(--space-md)',
            background: 'var(--color-bg)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '0.75rem',
              color: 'var(--color-text-muted)',
            }}
          >
            Transaction signature
          </p>
          <a
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
              wordBreak: 'break-all',
              color: 'var(--color-primary)',
            }}
          >
            {txSig}
          </a>
        </div>
      )}

      <Button onClick={onDone} style={{ width: '100%' }}>
        View my policies
      </Button>
    </div>
  );
}
