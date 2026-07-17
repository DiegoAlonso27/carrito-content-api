import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './shared/config/env.js';
import type { MongoContext } from './shared/db/mongo.js';
import { createMongoContext, closeMongo } from './shared/db/mongo.js';
import { buildLoggerOptions } from './shared/logging/logger.js';
import { registerErrorHandling } from './shared/errors/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { exportRoutes } from './modules/export/export.routes.js';
import { contentRoutes } from './modules/content/content.routes.js';
import { contactRoutes } from './modules/contact/contact.routes.js';

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

  // CORS cerrado por defecto: solo los dominios configurados del front.
  const corsOrigins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  void app.register(cors, { origin: corsOrigins.length > 0 ? corsOrigins : false });

  void app.register(helmet);

  // Rate limit por ruta (global: false): las rutas públicas declaran su
  // límite en config.rateLimit; health y export no comparten ese presupuesto.
  // El 429 sale con la envolvente estándar vía el error handler central
  // (FST_ERR_RATE_LIMITED); el plugin agrega el header Retry-After.
  void app.register(rateLimit, {
    global: false,
    keyGenerator: (req: FastifyRequest) => req.ip,
  });

  registerErrorHandling(app);
  app.register(healthRoutes);
  app.register(exportRoutes);
  app.register(contentRoutes);
  // F5 cerrado: contacto registrado por defecto. FEATURE_CONTACT_ENABLED=false
  // es kill-switch operativo (ADR-006), no aislamiento de fase.
  if (config.FEATURE_CONTACT_ENABLED) {
    app.register(contactRoutes);
  }

  return app;
}
