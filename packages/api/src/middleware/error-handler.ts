import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Validation error',
        details: error.errors,
      });
    }

    // Log unexpected errors
    logger.error(
      {
        error,
        method: request.method,
        url: request.url,
      },
      'Unhandled error',
    );

    // Generic error response
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });
}
