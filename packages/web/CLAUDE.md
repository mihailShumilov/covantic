# Frontend — Covantic

## Structure

```
src/
  app/
    page.tsx            — Landing (hero, how-it-works, live stats)
    layout.tsx          — Root layout with providers
    dashboard/page.tsx  — Risk assessment, policies list, buy policy modal
    staking/page.tsx    — Pool stats, stake form, position display
    claims/page.tsx     — Claims list, verification pipeline sidebar
    protocol/page.tsx   — Protocol stats, premium distribution chart
    demo/page.tsx       — KEY: 4 exploit simulations, event log, auto-play pipeline
  components/
    ui/                 — Button, Card, Badge, Spinner, Modal
    layout/Header.tsx   — Nav + WalletButton
    claims/ClaimVerificationPipeline.tsx — 5-step animated pipeline (key demo component)
  providers/
    WalletProvider.tsx  — Solana wallet adapter (Phantom, Solflare)
    CovanticProvider.tsx — Context: vaultStats, auto-refresh 30s
  styles/
    globals.css         — Dark theme, oklch colors, animations
```

## Key Patterns

- Next.js 16 App Router with `"use client"` for interactive components
- Tailwind CSS with CSS custom properties for theming
- Solana Wallet Adapter for wallet connection
- API calls to `http://localhost:4000/api/`
- `@covantic/shared` for all types and constants

## Commands

```bash
pnpm --filter web dev     # Dev server on port 3099
pnpm --filter web build   # Production build
```

## Port: 3099
