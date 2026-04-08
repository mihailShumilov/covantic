import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function stakingRoutes(app: FastifyInstance) {
  /** GET /api/staking/:address — Get staker position */
  app.get('/api/staking/:address', async (request, reply) => {
    const { address } = z.object({ address: z.string().min(32) }).parse(request.params);

    // In production, read from on-chain StakerPosition PDA
    // For now, return mock data
    return reply.send({
      staker: address,
      amountStaked: 0,
      shareBps: 0,
      rewardsClaimed: 0,
      rewardsPending: 0,
      depositedAt: null,
      unstakeRequestedAt: null,
    });
  });
}
