import type { ShadeClient } from '@neardefi/shade-agent-js';
import { PublicKey } from '@solana/web3.js';
import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { ED25519_DOMAIN_ID, MPC_CONTRACT_ID, requireEnv } from '../config.js';
import type { AgentConfig } from '../config.js';

const REQUEST_GAS_TGAS = 150;
const REGISTER_DEPOSIT_NEAR = '0.01';
const REFUSAL_PATTERN = /(G\d_[A-Z_]+|INTENT_MISMATCH|MESSAGE_MALFORMED)(?:: ?([^"\\]*))?/;

export interface SignIntent {
  trigger_type: number;
  /** sha256 of the canonical evidence bundle, hex. */
  evidence_hash: string;
}

interface SignatureResponse {
  scheme: string;
  signature: number[];
}

/** The contract refused to sign. `code` is one of the stable guardrail codes. */
export class GuardrailRefusal extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GuardrailRefusal';
  }
}

/** Turns a contract panic into a typed refusal, and rethrows anything else. */
export function toRefusal(error: unknown): unknown {
  const text = error instanceof Error ? error.message : String(error);
  const match = REFUSAL_PATTERN.exec(text);
  return match ? new GuardrailRefusal(match[1] as string, (match[2] ?? '').trim()) : error;
}

/** How a worker reaches the contract: a local key, or the Shade client in a TEE. */
export interface WorkerClient {
  accountId(): string;
  requestSignature(message: Buffer, intent: SignIntent): Promise<Buffer>;
}

function toSignature(response: SignatureResponse | undefined): Buffer {
  if (response?.scheme !== 'Ed25519' || response.signature.length !== 64) {
    throw new Error(`unexpected signature response: ${JSON.stringify(response)}`);
  }
  return Buffer.from(response.signature);
}

function requestArgs(message: Buffer, intent: SignIntent) {
  return { payload: message.toString('base64'), intent };
}

export class LocalWorker implements WorkerClient {
  private readonly account: Account;
  private readonly contractId: string;

  constructor(accountId: string, privateKey: string, config: AgentConfig) {
    const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
    this.account = new Account(accountId, provider, privateKey as KeyPairString);
    this.contractId = config.triggerContractId;
  }

  accountId(): string {
    return this.account.accountId;
  }

  async requestSignature(message: Buffer, intent: SignIntent): Promise<Buffer> {
    try {
      const response = await this.account.callFunction<SignatureResponse>({
        contractId: this.contractId,
        methodName: 'request_signature',
        args: requestArgs(message, intent),
        gas: teraToGas(REQUEST_GAS_TGAS),
      });
      return toSignature(response as SignatureResponse | undefined);
    } catch (error) {
      throw toRefusal(error);
    }
  }
}

export class ShadeWorker implements WorkerClient {
  private constructor(private readonly client: ShadeClient) {}

  static async create(config: AgentConfig): Promise<ShadeWorker> {
    // Imported here so local mode never loads the TEE dependency tree.
    const { ShadeClient: Client } = await import('@neardefi/shade-agent-js');
    const client = await Client.create({
      networkId: 'testnet',
      agentContractId: config.triggerContractId,
      sponsor: {
        accountId: requireEnv('SPONSOR_ACCOUNT_ID'),
        privateKey: requireEnv('SPONSOR_PRIVATE_KEY'),
      },
    });
    return new ShadeWorker(client);
  }

  accountId(): string {
    return this.client.accountId();
  }

  async register(): Promise<void> {
    await this.client.register({ deposit: REGISTER_DEPOSIT_NEAR });
  }

  async requestSignature(message: Buffer, intent: SignIntent): Promise<Buffer> {
    try {
      const response = await this.client.call({
        methodName: 'request_signature',
        args: requestArgs(message, intent),
        gas: teraToGas(REQUEST_GAS_TGAS),
      });
      return toSignature(response as SignatureResponse | undefined);
    } catch (error) {
      throw toRefusal(error);
    }
  }
}

export async function createWorker(config: AgentConfig): Promise<WorkerClient> {
  if (config.mode === 'tee') return ShadeWorker.create(config);
  return new LocalWorker(requireEnv('WORKER_ACCOUNT_ID'), requireEnv('WORKER_PRIVATE_KEY'), config);
}

/** Reads the Ed25519 key the MPC network holds for this contract and path. */
export async function deriveOracleAddress(
  rpcUrl: string,
  contractId: string,
  path: string,
): Promise<PublicKey> {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const derived = await provider.callFunction<string>({
    contractId: MPC_CONTRACT_ID,
    method: 'derived_public_key',
    args: { path, predecessor: contractId, domain_id: ED25519_DOMAIN_ID },
  });
  if (!derived?.startsWith('ed25519:')) {
    throw new Error(`unexpected derived key: ${String(derived)}`);
  }
  return new PublicKey(derived.slice('ed25519:'.length));
}
