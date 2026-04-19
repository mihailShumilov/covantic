import { logger } from '../utils/logger.js';

/**
 * Client for the Helius Webhook management REST API.
 *
 * All requests authenticate via the `api-key` query parameter (Helius'
 * standard). `authHeader` carried on every stored webhook is the bearer
 * value Helius will send back to us on every delivery — we use it as a
 * shared secret because Helius does not (currently) HMAC-sign payloads.
 *
 * Docs: https://www.helius.dev/docs/api-reference/webhooks
 */

const WEBHOOKS_URL = 'https://api.helius.xyz/v0/webhooks';

/** Helius webhook types. We always use `enhanced` / `enhancedDevnet` so
 *  `tokenTransfers[]` is parsed for us before hitting our endpoint. */
export type HeliusWebhookType =
  | 'enhanced'
  | 'enhancedDevnet'
  | 'raw'
  | 'rawDevnet'
  | 'discord'
  | 'discordDevnet';

export interface HeliusWebhook {
  webhookID: string;
  wallet?: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: HeliusWebhookType;
  authHeader?: string;
  active?: boolean;
}

export interface WebhookSpec {
  webhookURL: string;
  webhookType: HeliusWebhookType;
  accountAddresses: string[];
  /** Value Helius sends as the `Authorization` header on every delivery.
   *  The webhook endpoint must validate this before acting on any payload. */
  authHeader: string;
  /** Defaults to `['ANY']` so we receive every kind of tx — the monitor
   *  filters by token-transfer content, not Helius' type taxonomy. */
  transactionTypes?: string[];
}

export class HeliusWebhookClient {
  constructor(private apiKey: string) {}

  private url(path = '', extraParams?: Record<string, string>): string {
    const params = new URLSearchParams({ 'api-key': this.apiKey, ...(extraParams ?? {}) });
    return `${WEBHOOKS_URL}${path}?${params}`;
  }

  /** List every webhook associated with this api-key. */
  async list(): Promise<HeliusWebhook[]> {
    const res = await fetch(this.url());
    if (!res.ok) {
      throw new Error(`Helius list webhooks failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HeliusWebhook[];
  }

  async get(webhookId: string): Promise<HeliusWebhook | null> {
    const res = await fetch(this.url(`/${encodeURIComponent(webhookId)}`));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Helius get webhook failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HeliusWebhook;
  }

  async create(spec: WebhookSpec): Promise<HeliusWebhook> {
    const body = {
      webhookURL: spec.webhookURL,
      webhookType: spec.webhookType,
      accountAddresses: spec.accountAddresses,
      transactionTypes: spec.transactionTypes ?? ['ANY'],
      authHeader: spec.authHeader,
    };
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Helius create webhook failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HeliusWebhook;
  }

  async edit(webhookId: string, spec: Partial<WebhookSpec>): Promise<HeliusWebhook> {
    const body: Record<string, unknown> = {};
    if (spec.webhookURL !== undefined) body.webhookURL = spec.webhookURL;
    if (spec.webhookType !== undefined) body.webhookType = spec.webhookType;
    if (spec.accountAddresses !== undefined) body.accountAddresses = spec.accountAddresses;
    if (spec.transactionTypes !== undefined) body.transactionTypes = spec.transactionTypes;
    if (spec.authHeader !== undefined) body.authHeader = spec.authHeader;
    const res = await fetch(this.url(`/${encodeURIComponent(webhookId)}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Helius edit webhook failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HeliusWebhook;
  }

  async delete(webhookId: string): Promise<void> {
    const res = await fetch(this.url(`/${encodeURIComponent(webhookId)}`), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Helius delete webhook failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}

/** Redis key where we cache the webhook ID so the sync CLI can update
 *  rather than re-create on every run. */
export const WEBHOOK_ID_CACHE_KEY = 'covantic:helius:webhook_id';

/** Authorization header value Helius will send us on every delivery.
 *  We prefix the shared secret with `Bearer ` so the monitoring endpoint
 *  can do a single constant-time compare against the full string. */
export function buildAuthHeader(secret: string): string {
  return `Bearer ${secret}`;
}

export interface SyncInput {
  heliusApiKey: string;
  webhookSecret: string;
  webhookPublicUrl: string;
  network: 'devnet' | 'mainnet-beta';
  agentAddresses: string[];
  cachedWebhookId?: string | null;
}

export interface SyncResult {
  action: 'created' | 'updated' | 'unchanged';
  webhookId: string;
  webhookUrl: string;
  addressCount: number;
  addressesAdded: string[];
  addressesRemoved: string[];
}

/**
 * Idempotently ensure a Helius webhook exists for our agents list.
 * Strategy:
 *   1. If we have a cached webhookId, try to load it.
 *   2. Else, list all webhooks and match by webhookURL (handles a CLI run
 *      on a machine that never cached the id).
 *   3. If found: diff addressAddresses; edit only if the set changed.
 *   4. If missing: create a fresh webhook.
 */
export async function syncWebhook(input: SyncInput): Promise<SyncResult> {
  if (!input.webhookPublicUrl) {
    throw new Error('syncWebhook: webhookPublicUrl is required');
  }

  const client = new HeliusWebhookClient(input.heliusApiKey);
  const webhookType: HeliusWebhookType =
    input.network === 'mainnet-beta' ? 'enhanced' : 'enhancedDevnet';
  const desiredAddresses = Array.from(new Set(input.agentAddresses)).sort();
  const authHeader = buildAuthHeader(input.webhookSecret);

  let existing: HeliusWebhook | null = null;
  if (input.cachedWebhookId) {
    existing = await client.get(input.cachedWebhookId);
    if (!existing) {
      logger.warn(
        { cachedWebhookId: input.cachedWebhookId },
        'helius-sync: cached webhook id not found; will search by URL',
      );
    }
  }
  if (!existing) {
    const all = await client.list();
    existing = all.find((w) => w.webhookURL === input.webhookPublicUrl) ?? null;
  }

  if (!existing) {
    if (desiredAddresses.length === 0) {
      logger.warn('helius-sync: no insured agents to watch; skipping webhook creation');
      return {
        action: 'unchanged',
        webhookId: '',
        webhookUrl: input.webhookPublicUrl,
        addressCount: 0,
        addressesAdded: [],
        addressesRemoved: [],
      };
    }
    const created = await client.create({
      webhookURL: input.webhookPublicUrl,
      webhookType,
      accountAddresses: desiredAddresses,
      authHeader,
    });
    return {
      action: 'created',
      webhookId: created.webhookID,
      webhookUrl: created.webhookURL,
      addressCount: created.accountAddresses.length,
      addressesAdded: desiredAddresses,
      addressesRemoved: [],
    };
  }

  const currentSet = new Set(existing.accountAddresses ?? []);
  const desiredSet = new Set(desiredAddresses);
  const added = desiredAddresses.filter((a) => !currentSet.has(a));
  const removed = (existing.accountAddresses ?? []).filter((a) => !desiredSet.has(a));

  const needsAddressUpdate = added.length > 0 || removed.length > 0;
  const needsAuthUpdate = existing.authHeader !== authHeader;
  const needsTypeUpdate = existing.webhookType !== webhookType;
  const needsUrlUpdate = existing.webhookURL !== input.webhookPublicUrl;

  if (!needsAddressUpdate && !needsAuthUpdate && !needsTypeUpdate && !needsUrlUpdate) {
    return {
      action: 'unchanged',
      webhookId: existing.webhookID,
      webhookUrl: existing.webhookURL,
      addressCount: existing.accountAddresses.length,
      addressesAdded: [],
      addressesRemoved: [],
    };
  }

  // Helius' PUT validator rejects the body when `transactionTypes` is
  // absent (even though the OpenAPI spec marks it optional). Send the
  // same `['ANY']` we use on create so it round-trips cleanly.
  const updated = await client.edit(existing.webhookID, {
    webhookURL: input.webhookPublicUrl,
    webhookType,
    accountAddresses: desiredAddresses,
    authHeader,
    transactionTypes: existing.transactionTypes?.length
      ? existing.transactionTypes
      : ['ANY'],
  });
  return {
    action: 'updated',
    webhookId: updated.webhookID,
    webhookUrl: updated.webhookURL,
    addressCount: updated.accountAddresses.length,
    addressesAdded: added,
    addressesRemoved: removed,
  };
}
