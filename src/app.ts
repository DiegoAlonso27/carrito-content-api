import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from './shared/config/env.js';
import type { MongoContext } from './shared/db/mongo.js';
import { createMongoContext, closeMongo } from './shared/db/mongo.js';
import { buildLoggerOptions } from './shared/logging/logger.js';
import { registerErrorHandling } from './shared/errors/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    mongo: MongoContext;
  }
}

/**
 * Construye la aplicación completa sin escuchar en ningún puerto
 * (inyectable en pruebas con app.inject()).
 */
export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    // Detrás de IIS/ARR solo se confía en el loopback para X-Forwarded-For (plan F7).
    trustProxy: '127.0.0.1',
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);
  app.decorate('mongo', createMongoContext(config));
  app.addHook('onClose', async () => {
    await closeMongo(app.mongo);
  });

  // El requestId viaja en la respuesta para correlacionar con los logs.
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    done();
  });

  registerErrorHandling(app);
  app.register(healthRoutes);

  return app;
}
