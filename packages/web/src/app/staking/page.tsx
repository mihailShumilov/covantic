'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useCovanticContext } from '@/providers/CovanticProvider';
import {
  formatUsdc,
  solvencyStatus,
  SolvencyStatus,
  type StakerPositionResponse,
} from '@covantic/shared';
import {
  useCovanticProgram,
  deriveConfigPda,
  deriveVaultPda,
  deriveStakerPda,
} from '@/hooks/useCovanticProgram';
import { apiGet } from '@/lib/api-client';

const solvencyColors: Record<SolvencyStatus, string> = {
  [SolvencyStatus.Healthy]: 'success',
  [SolvencyStatus.Caution]: 'warning',
  [SolvencyStatus.Critical]: 'danger',
  [SolvencyStatus.Emergency]: 'danger',
};

export default function StakingPage() {
  const { vaultStats, refreshVault } = useCovanticContext();
  const { publicKey } = useWallet();
  const { program } = useCovanticProgram();

  const [stakeAmount, setStakeAmount] = useState('');
  const [position, setPosition] = useState<StakerPositionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cache config fetch so stake/unstake/claim don't each hit the RPC for usdcMint.
  const contextCacheRef = useRef<{
    configPda: PublicKey;
    vaultPda: PublicKey;
    usdcMint: PublicKey;
  } | null>(null);

  const status = vaultStats
    ? solvencyStatus(vaultStats.solvencyRatio * 10000)
    : SolvencyStatus.Healthy;

  const refreshPosition = useCallback(async () => {
    if (!publicKey) {
      setPosition(null);
      return;
    }
    try {
      const data = await apiGet<StakerPositionResponse>(
        `/api/staking/${publicKey.toBase58()}`,
      );
      setPosition(data);
    } catch {
      setPosition(null);
    }
  }, [publicKey]);

  useEffect(() => {
    refreshPosition();
  }, [refreshPosition]);

  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<void> {
    setError(null);
    setMessage(null);
    if (!program || !publicKey) {
      setError('Connect wallet first');
      return;
    }
    setBusy(true);
    try {
      const sig = await fn();
      setMessage(`${label} sent: ${String(sig)}`);
      await Promise.all([refreshPosition(), refreshVault()]);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      // Wallet adapter + Anchor can both submit the signed tx; the second
      // submit returns "already been processed" even though the first one
      // confirmed. Treat as success and refresh.
      if (msg.includes('already been processed')) {
        setMessage(`${label} confirmed`);
        await Promise.all([refreshPosition(), refreshVault()]);
      } else {
        setError(msg || 'Transaction failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadContext() {
    if (!program) throw new Error('Program not ready');
    if (contextCacheRef.current) return contextCacheRef.current;
    const configPda = deriveConfigPda();
    const vaultPda = deriveVaultPda();
    const cfg: any = await (program.account as any).protocolConfig.fetch(configPda);
    const ctx = { configPda, vaultPda, usdcMint: cfg.usdcMint as PublicKey };
    contextCacheRef.current = ctx;
    return ctx;
  }

  const onStake = () =>
    withBusy('Stake', async () => {
      if (!program || !publicKey) throw new Error('no wallet');
      const amountNum = Math.round(parseFloat(stakeAmount) * 1_000_000);
      if (!amountNum) throw new Error('Invalid amount');
      const { configPda, vaultPda, usdcMint } = await loadContext();
      const stakerPosition = deriveStakerPda(publicKey);
      const stakerAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
      const createStakerAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        publicKey,
        stakerAta,
        publicKey,
        usdcMint,
      );
      return program.methods
        .stake(new BN(amountNum))
        .accounts({
          staker: publicKey,
          config: configPda,
          vault: vaultPda,
          stakerPosition,
          stakerTokenAccount: stakerAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .preInstructions([createStakerAtaIx])
        .rpc();
    });

  const onRequestUnstake = () =>
    withBusy('Request unstake', async () => {
      if (!program || !publicKey) throw new Error('no wallet');
      const stakerPosition = deriveStakerPda(publicKey);
      return program.methods
        .requestUnstake()
        .accounts({ staker: publicKey, stakerPosition } as any)
        .rpc();
    });

  const onExecuteUnstake = () =>
    withBusy('Execute unstake', async () => {
      if (!program || !publicKey) throw new Error('no wallet');
      const { vaultPda, usdcMint } = await loadContext();
      const stakerPosition = deriveStakerPda(publicKey);
      const stakerAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
      return program.methods
        .executeUnstake()
        .accounts({
          staker: publicKey,
          stakerPosition,
          vault: vaultPda,
          vaultTokenAccount: vaultAta,
          stakerTokenAccount: stakerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
    });

  const onClaimRewards = () =>
    withBusy('Claim rewards', async () => {
      if (!program || !publicKey) throw new Error('no wallet');
      const { vaultPda, usdcMint } = await loadContext();
      const stakerPosition = deriveStakerPda(publicKey);
      const stakerAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
      return program.methods
        .claimRewards()
        .accounts({
          staker: publicKey,
          stakerPosition,
          vault: vaultPda,
          vaultTokenAccount: vaultAta,
          stakerTokenAccount: stakerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
    });

  const hasStake = (position?.amountStaked ?? 0) > 0;
  const cooldownActive = Boolean(position?.unstakeRequestedAt);

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 'var(--space-xl)' }}>
        Staking Pool
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
        <Card title="Pool Health">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Total Staked
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                ${vaultStats ? formatUsdc(vaultStats.totalStaked) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Total Coverage
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                ${vaultStats ? formatUsdc(vaultStats.totalCoverage) : '0.00'}
              </p>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                Solvency Ratio
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                  {vaultStats?.solvencyRatio?.toFixed(2) ?? '0'}x
                </p>
                <Badge variant={solvencyColors[status] as any}>{status.toUpperCase()}</Badge>
              </div>
            </div>
            <div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Stakers</p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>{vaultStats?.stakerCount ?? 0}</p>
            </div>
          </div>
        </Card>

        <Card title="Stake USDC">
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
                Amount (USDC)
              </label>
              <input
                type="number"
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                placeholder="Enter amount..."
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
            <Button size="lg" onClick={onStake} disabled={busy || !publicKey}>
              {busy ? 'Pending...' : 'Stake'}
            </Button>
            <p
              style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center' }}
            >
              48-hour cooldown for unstaking. Rewards from 70% of premiums collected.
            </p>
          </div>
        </Card>
      </div>

      <Card title="My Position" style={{ marginTop: 'var(--space-lg)' }}>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-lg)' }}
        >
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Staked</p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              ${position ? formatUsdc(position.amountStaked) : '0.00'}
            </p>
          </div>
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Pool Share</p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {position ? (position.shareBps / 100).toFixed(2) : '0'}%
            </p>
          </div>
          <div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
              Pending Rewards
            </p>
            <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-primary)' }}>
              ${position ? formatUsdc(position.rewardsPending) : '0.00'}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <Button
              variant="secondary"
              onClick={onClaimRewards}
              disabled={busy || !publicKey || (position?.rewardsPending ?? 0) === 0}
            >
              Claim Rewards
            </Button>
            {hasStake && !cooldownActive && (
              <Button variant="secondary" onClick={onRequestUnstake} disabled={busy}>
                Request Unstake
              </Button>
            )}
            {cooldownActive && (
              <Button variant="secondary" onClick={onExecuteUnstake} disabled={busy}>
                Execute Unstake
              </Button>
            )}
          </div>
        </div>
        {cooldownActive && (
          <p
            style={{
              fontSize: '0.8125rem',
              color: 'var(--color-text-muted)',
              marginTop: 'var(--space-md)',
            }}
          >
            Cooldown started at {position?.unstakeRequestedAt}. Wait 48h before executing.
          </p>
        )}
        {error && (
          <p style={{ fontSize: '0.8125rem', color: 'var(--color-danger)', marginTop: 'var(--space-md)' }}>
            {error}
          </p>
        )}
        {message && (
          <p
            style={{
              fontSize: '0.8125rem',
              color: 'var(--color-primary)',
              marginTop: 'var(--space-md)',
              wordBreak: 'break-all',
            }}
          >
            {message}
          </p>
        )}
      </Card>
    </div>
  );
}
