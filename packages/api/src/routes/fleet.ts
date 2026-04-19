import type { FastifyInstance } from 'fastify';
import { loadManifest } from '../services/fleet/manifest.js';
import {
  FLEET_ACTIVITY_KEY,
  type FleetActivityEntry,
} from '../services/fleet/types.js';

/**
 * GET /api/fleet
 *
 * Returns the static fleet manifest (agents, coverage, policy ids)
 * plus the most recent N activity entries from Redis so the dashboard
 * can render a live feed without maintaining its own state.
 *
 * The manifest is read from `keys/fleet.json` on every request — cheap
 * and guarantees a fresh view when a new agent was just bootstrapped.
 */
export async function fleetRoutes(app: FastifyInstance) {
  app.get('/api/fleet', async (_request, reply) => {
    let manifest;
    try {
      manifest = loadManifest();
    } catch (err) {
      app.log.warn({ err }, 'fleet: failed to load manifest');
      return reply.send({
        agents: [],
        activity: [],
        note: 'Fleet manifest not present. Run `pnpm fleet:bootstrap` to populate.',
      });
    }

    const rawEntries = await app.redis.lrange(FLEET_ACTIVITY_KEY, 0, 99);
    const activity: FleetActivityEntry[] = rawEntries
      .map((r) => {
        try {
          return JSON.parse(r) as FleetActivityEntry;
        } catch {
          return null;
        }
      })
      .filter((r): r is FleetActivityEntry => r !== null);

    return reply.send({
      agents: manifest.agents.map((a) => ({
        name: a.name,
        pubkey: a.pubkey,
        holderPubkey: a.holderPubkey,
        policyId: a.policyId,
        riskTier: a.riskTier,
        coverageAmountRaw: a.coverageAmountRaw,
        durationSeconds: a.durationSeconds,
        createdAt: a.createdAt,
      })),
      activity,
      updatedAt: manifest.updatedAt,
    });
  });
}
