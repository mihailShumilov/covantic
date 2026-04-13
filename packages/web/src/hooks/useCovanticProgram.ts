'use client';

import { useMemo } from 'react';
import { useConnection, useAnchorWallet } from '@solana/wallet-adapter-react';
import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { PDA_SEEDS, policyIdToBytes } from '@covantic/shared';
import { COVANTIC_IDL } from '@/idl/covantic';
import { PROGRAM_ID as PROGRAM_ID_STR } from '@/lib/constants';

// Known devnet program ID — used as a fallback during Next.js SSR/prerender
// when NEXT_PUBLIC_PROGRAM_ID isn't available at build time. Any real user
// action goes through an RPC, so a missing env var will surface as a failed
// transaction rather than a silently-wrong PDA derivation.
const DEVNET_FALLBACK_PROGRAM_ID = '52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D';

let warnedAboutMissingProgramId = false;
function resolveProgramIdString(): string {
  if (PROGRAM_ID_STR && PROGRAM_ID_STR.length > 0) return PROGRAM_ID_STR;
  if (!warnedAboutMissingProgramId && typeof window !== 'undefined') {
    warnedAboutMissingProgramId = true;
    console.warn(
      'NEXT_PUBLIC_PROGRAM_ID is not set; falling back to the devnet program ID. ' +
        'Set it explicitly in the deployment environment.',
    );
  }
  return DEVNET_FALLBACK_PROGRAM_ID;
}

let cachedProgramId: PublicKey | null = null;
function getProgramId(): PublicKey {
  if (!cachedProgramId) cachedProgramId = new PublicKey(resolveProgramIdString());
  return cachedProgramId;
}

export const PROGRAM_ID = new Proxy({} as PublicKey, {
  get(_, prop, receiver) {
    return Reflect.get(getProgramId(), prop, receiver);
  },
});

export const CONFIG_SEED = Buffer.from(PDA_SEEDS.CONFIG);
export const VAULT_SEED = Buffer.from(PDA_SEEDS.VAULT);
export const POLICY_SEED = Buffer.from(PDA_SEEDS.POLICY);
export const STAKER_SEED = Buffer.from(PDA_SEEDS.STAKER);

export function useCovanticProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  }, [connection, wallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new Program(COVANTIC_IDL as unknown as Idl, provider);
  }, [provider]);

  return { program, provider, programId: getProgramId(), wallet };
}

export function deriveConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], getProgramId())[0];
}

export function deriveVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED], getProgramId())[0];
}

export function deriveStakerPda(staker: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [STAKER_SEED, staker.toBuffer()],
    getProgramId(),
  )[0];
}

export function derivePolicyPda(holder: PublicKey, policyId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POLICY_SEED, holder.toBuffer(), Buffer.from(policyIdToBytes(policyId))],
    getProgramId(),
  )[0];
}
