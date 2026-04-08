import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { claims } from '../db/schema.js';

const claimsQuerySchema = z.object({
  status: z.string().optional(),
  holder: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function claimRoutes(app: FastifyInstance) {
  /** GET /api/claims — List claims with filters */
  app.get('/api/claims', async (request, reply) => {
    const query = claimsQuerySchema.parse(request.query);
    const conditions = [];

    if (query.status) conditions.push(eq(claims.status, query.status));
    if (query.holder) conditions.push(eq(claims.holderAddress, query.holder));

    const result = await app.db
      .select()
      .from(claims)
      .orderBy(desc(claims.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    return reply.send({ claims: result, total: result.length });
  });

  /** GET /api/claims/:id — Get claim details */
  app.get('/api/claims/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const result = await app.db
      .select()
      .from(claims)
      .where(eq(claims.id, id))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Claim not found' });
    }

    return reply.send(result[0]);
  });
}
