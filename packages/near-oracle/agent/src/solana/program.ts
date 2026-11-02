import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import anchor from '@coral-xyz/anchor';
import type { Idl, Program as AnchorProgram, Provider } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import type { Connection, TransactionInstruction } from '@solana/web3.js';
import { PDA_SEEDS } from '@covantic/shared';
import type { PolicySnapshot } from '../predicate/types.js';

// The package is CommonJS and Node cannot see its named exports from ESM.
const { BN, Program } = anchor;
type BN = InstanceType<typeof BN>;

const IDL_PATH = fileURLToPath(new URL('../../../idl/covantic.json', import.meta.url));

/** Fixed-size accounts are read through this, so nothing here needs a wallet. */
type AnyMethods = Record<
  string,
  (...args: unknown[]) => {
    accountsStrict: (accounts: Record<string, PublicKey>) => {
      instruction: () => Promise<TransactionInstruction>;
    };
  }
>;
type AnyAccounts = Record<string, { fetch: (address: PublicKey) => Promise<never> }>;

export interface ProtocolConfig {
  oracleAuthority: PublicKey;
  usdcMint: PublicKey;
  policyCounter: bigint;
  paused: boolean;
}

export interface PayoutArgs {
  oracle: PublicKey;
  policy: PublicKey;
  holder: PublicKey;
  usdcMint: PublicKey;
  priceUpdate: PublicKey;
  payoutAmount: bigint;
  feedIdHex: string;
  triggerBlockTime: number;
  executedPriceScaled: number;
  subjectQuantity: bigint;
  subjectDecimals: number;
  bundleHashHex: string;
}

export interface AttestationArgs {
  oracle: PublicKey;
  agent: PublicKey;
  tier: number;
  validForSeconds: number;
  mandateHash: Uint8Array;
  envelopeFlatPremium: bigint;
  feedIdHex: string;
  subjectMint: PublicKey;
  subjectDecimals: number;
  maxSubjectQuantity: bigint;
}

function seed(value: string): Buffer {
  return Buffer.from(value);
}

function bn(value: bigint | number): BN {
  return new BN(value.toString());
}

function bytes32(hex: string): number[] {
  return Array.from(Buffer.from(hex, 'hex'));
}

/** Read-only view of the deployed Covantic program, plus its instruction builders. */
export class CovanticProgram {
  readonly program: AnchorProgram;
  readonly programId: PublicKey;

  constructor(readonly connection: Connection) {
    const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8')) as Idl;
    this.program = new Program(idl, { connection } as Provider);
    this.programId = this.program.programId;
  }

  private pda(seeds: Array<Buffer | Uint8Array>): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }

  get configAddress(): PublicKey {
    return this.pda([seed(PDA_SEEDS.CONFIG)]);
  }

  get vaultAddress(): PublicKey {
    return this.pda([seed(PDA_SEEDS.VAULT)]);
  }

  attestationAddress(agent: PublicKey): PublicKey {
    return this.pda([seed(PDA_SEEDS.ATTESTATION), agent.toBuffer()]);
  }

  policyAddress(holder: PublicKey, policyId: bigint): PublicKey {
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(policyId);
    return this.pda([seed(PDA_SEEDS.POLICY), holder.toBuffer(), id]);
  }

  policyChildAddress(prefix: string, policy: PublicKey): PublicKey {
    return this.pda([seed(prefix), policy.toBuffer()]);
  }

  private get accounts(): AnyAccounts {
    return this.program.account as unknown as AnyAccounts;
  }

  private get methods(): AnyMethods {
    return this.program.methods as unknown as AnyMethods;
  }

  async readConfig(): Promise<ProtocolConfig> {
    const config = (await this.accounts.protocolConfig!.fetch(this.configAddress)) as unknown as {
      oracleAuthority: PublicKey;
      usdcMint: PublicKey;
      policyCounter: BN;
      paused: boolean;
    };
    return {
      oracleAuthority: config.oracleAuthority,
      usdcMint: config.usdcMint,
      policyCounter: BigInt(config.policyCounter.toString()),
      paused: config.paused,
    };
  }

  async readPolicy(address: PublicKey): Promise<PolicySnapshot> {
    const policy = (await this.accounts.insurancePolicy!.fetch(address)) as unknown as {
      policyId: BN;
      holder: PublicKey;
      agentAddress: PublicKey;
      coverageAmount: BN;
      state: number;
      startTime: BN;
      expiryTime: BN;
    };
    const terms = await this.readPriceTerms(address);
    return {
      address: address.toBase58(),
      policyId: policy.policyId.toString(),
      holder: policy.holder.toBase58(),
      agent: policy.agentAddress.toBase58(),
      coverageRaw: policy.coverageAmount.toNumber(),
      state: policy.state,
      startTime: policy.startTime.toNumber(),
      expiryTime: policy.expiryTime.toNumber(),
      terms,
    };
  }

  private async readPriceTerms(policy: PublicKey): Promise<PolicySnapshot['terms']> {
    const address = this.policyChildAddress(PDA_SEEDS.POLICY_PRICE_TERMS, policy);
    if (!(await this.connection.getAccountInfo(address))) return null;
    const terms = (await this.accounts.policyPriceTerms!.fetch(address)) as unknown as {
      feedId: number[];
      subjectMint: PublicKey;
      subjectDecimals: number;
      maxSubjectQuantity: BN;
    };
    return {
      feedIdHex: Buffer.from(terms.feedId).toString('hex'),
      subjectMint: terms.subjectMint.toBase58(),
      subjectDecimals: terms.subjectDecimals,
      maxSubjectQuantity: BigInt(terms.maxSubjectQuantity.toString()),
    };
  }

  submitClaim(oracle: PublicKey, policy: PublicKey, triggerType: number, triggerTx: string) {
    return this.methods
      .oracleSubmitClaim!(triggerType, Buffer.from(triggerTx, 'utf8'))
      .accountsStrict({ oracle, config: this.configAddress, policy })
      .instruction();
  }

  payout(args: PayoutArgs) {
    const vault = this.vaultAddress;
    return this.methods
      .verifyAndPayoutV2!(bn(args.payoutAmount), {
        feedId: bytes32(args.feedIdHex),
        triggerBlockTime: bn(args.triggerBlockTime),
        executedPrice: bn(args.executedPriceScaled),
        subjectQuantity: bn(args.subjectQuantity),
        subjectDecimals: args.subjectDecimals,
        bundleHash: bytes32(args.bundleHashHex),
      })
      .accountsStrict({
        oracle: args.oracle,
        config: this.configAddress,
        policy: args.policy,
        vault,
        vaultTokenAccount: getAssociatedTokenAddressSync(args.usdcMint, vault, true),
        holderTokenAccount: getAssociatedTokenAddressSync(args.usdcMint, args.holder),
        priceUpdate: args.priceUpdate,
        priceTerms: this.policyChildAddress(PDA_SEEDS.POLICY_PRICE_TERMS, args.policy),
        evidenceRecord: this.policyChildAddress(PDA_SEEDS.CLAIM_EVIDENCE, args.policy),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  attestation(args: AttestationArgs) {
    return this.methods
      .upsertAttestation!(
        args.agent,
        args.tier,
        bn(args.validForSeconds),
        Array.from(args.mandateHash),
        bn(args.envelopeFlatPremium),
        {
          feedId: bytes32(args.feedIdHex),
          subjectMint: args.subjectMint,
          subjectDecimals: args.subjectDecimals,
          maxSubjectQuantity: bn(args.maxSubjectQuantity),
        },
      )
      .accountsStrict({
        oracle: args.oracle,
        config: this.configAddress,
        attestation: this.attestationAddress(args.agent),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }
}
