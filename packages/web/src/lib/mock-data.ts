/** Mock data for the Covantic landing page. In production, fetch from /api/protocol/overview */

export const HERO_STATS = [
  { label: 'Total Value Protected', value: '$2.4M' },
  { label: 'Active Agents', value: '847' },
  { label: 'Claims Paid', value: '23' },
  { label: 'Solvency Ratio', value: '312%' },
] as const;

export const LOSS_EVENTS = [
  { name: 'Drift Protocol', loss: '$286M', date: 'Apr 2026', cause: 'Governance exploit' },
  { name: 'Wormhole Bridge', loss: '$325M', date: 'Feb 2022', cause: 'Missing signer check' },
  { name: 'KiloEx', loss: '$117M', date: 'Apr 2025', cause: 'Oracle manipulation' },
  { name: 'Mango Markets', loss: '$115M', date: 'Oct 2022', cause: 'Oracle manipulation' },
  { name: 'Lobstar Wilde', loss: '$250K', date: 'Feb 2026', cause: 'Decimal parsing error' },
] as const;

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: 'Assess',
    description: 'AI Risk Scorer analyzes 15 on-chain signals — account age, transaction patterns, DeFi exposure — to assign a risk tier.',
    icon: 'search',
  },
  {
    step: 2,
    title: 'Insure',
    description: 'Agent buys a policy on-chain. Premium is calculated automatically based on risk tier and coverage amount.',
    icon: 'shield',
  },
  {
    step: 3,
    title: 'Monitor',
    description: 'Helius webhooks and Pyth oracles watch agent transactions 24/7. Anomaly detection runs continuously.',
    icon: 'eye',
  },
  {
    step: 4,
    title: 'Payout',
    description: 'When a trigger fires, the claim is verified on-chain and USDC is transferred instantly. No human review.',
    icon: 'zap',
  },
] as const;

export const COVERAGE_TRIGGERS = [
  {
    name: 'Smart Contract Exploit',
    condition: 'Balance drop >50% in a single slot',
    lock: '0 hours',
    color: 'var(--color-danger)',
    bg: 'oklch(0.63 0.24 25 / 0.08)',
  },
  {
    name: 'Oracle Manipulation',
    condition: 'Price deviation >5% from 5-min TWAP',
    lock: '1 hour',
    color: 'var(--color-warning)',
    bg: 'oklch(0.79 0.17 75 / 0.08)',
  },
  {
    name: 'Critical Agent Error',
    condition: 'Transfer amount >100x agent average',
    lock: '6 hours',
    color: 'oklch(0.79 0.17 75)',
    bg: 'oklch(0.79 0.17 75 / 0.06)',
  },
  {
    name: 'Governance Attack',
    condition: 'Admin key change + drain within 30 min',
    lock: '2 hours',
    color: 'var(--color-secondary-light)',
    bg: 'oklch(0.55 0.22 280 / 0.08)',
  },
] as const;

export const RISK_TIERS = [
  { name: 'LOW', rate: '1.0%', range: '0 — 0.30', color: 'var(--color-accent)', fill: 30 },
  { name: 'MEDIUM', rate: '2.5%', range: '0.30 — 0.60', color: 'var(--color-warning)', fill: 60 },
  { name: 'HIGH', rate: '5.0%', range: '0.60 — 0.85', color: 'var(--color-danger)', fill: 85 },
  { name: 'EXTREME', rate: 'Declined', range: '0.85+', color: 'var(--color-text-muted)', fill: 100 },
] as const;

export const SDK_CODE = `import { Connection } from '@solana/web3.js';
import { CovanticClient, RiskTier, usdcToLamports } from '@covantic/solana-sdk';

const client = new CovanticClient({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet,
});

// Auto-insure before every trade
const { instruction } = await client.createPolicyIx({
  coverageLamports: usdcToLamports(1000),
  durationSeconds: 24 * 3600,
  riskTier: RiskTier.MEDIUM,
  agentAddress: wallet.publicKey,
  usdcMint: USDC_MINT,
});
await client.sendTransaction([instruction]);`;

export const STAKER_STATS = [
  { label: 'Pool Size', value: '$340K USDC' },
  { label: 'Solvency', value: '312%' },
  { label: 'APY', value: '~12.4%' },
] as const;

export const TECH_STACK = [
  'Solana',
  'Anchor',
  'Helius',
  'Pyth',
  'Solana Agent Kit',
] as const;
