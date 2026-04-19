import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { riskRoutes } from './risk.js';
import { policyRoutes } from './policies.js';
import { claimRoutes } from './claims.js';
import { vaultRoutes } from './vault.js';
import { stakingRoutes } from './staking.js';
import { monitoringRoutes } from './monitoring.js';
import { fleetRoutes } from './fleet.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(riskRoutes);
  await app.register(policyRoutes);
  await app.register(claimRoutes);
  await app.register(vaultRoutes);
  await app.register(stakingRoutes);
  await app.register(monitoringRoutes);
  await app.register(fleetRoutes);
}
