import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

let mongod: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  app = buildApp(makeTestConfig({ MONGO_URI: mongod.getUri() }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('humo con MongoDB real (memoria)', () => {
  it('readiness responde 200 cuando ambas bases responden al ping', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('liveness responde 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('con FEATURE_CONTACT_ENABLED=false el endpoint de contacto no está registrado (kill-switch)', async () => {
    const disabled = buildApp(
      makeTestConfig({ MONGO_URI: mongod.getUri(), FEATURE_CONTACT_ENABLED: 'false' }),
    );
    try {
      await disabled.ready();
      expect(disabled.config.FEATURE_CONTACT_ENABLED).toBe(false);
      const res = await disabled.inject({
        method: 'POST',
        url: '/v1/contact',
        payload: { submissionId: '00000000-0000-4000-8000-000000000001' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    } finally {
      await disabled.close();
    }
  });

  it('por defecto el contacto está registrado (F5 cerrado)', async () => {
    expect(app.config.FEATURE_CONTACT_ENABLED).toBe(true);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: { submissionId: 'not-a-uuid' },
    });
    // Ruta presente: falla validación, no 404.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });
});
