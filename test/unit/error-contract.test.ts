import { describe, expect, it, afterAll } from 'vitest';
import { Type } from '@sinclair/typebox';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

// Sin MongoDB: estas pruebas cubren el contrato de error, que no toca la BD.
const app = buildApp(makeTestConfig({ MONGO_URI: 'mongodb://127.0.0.1:1' }));

app.post(
  '/test/validation',
  { schema: { body: Type.Object({ cantidad: Type.Number() }) } },
  () => ({ ok: true }),
);

afterAll(async () => {
  await app.close();
});

describe('contrato de error estándar', () => {
  it('404 devuelve la envolvente { error: { code, message, requestId } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeTruthy();
    expect(body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('error de validación devuelve 400 con detalles agrupados por campo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      payload: { cantidad: 'no-numero' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{
      error: { code: string; requestId: string; details: Record<string, string[]> };
    }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details['cantidad']).toBeDefined();
  });

  it('la respuesta de error nunca incluye stack trace', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' });
    expect(res.body).not.toContain('at ');
    expect(res.body).not.toContain('stack');
  });
});

describe('health sin MongoDB disponible', () => {
  it('liveness responde 200 aunque la BD esté caída', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness responde 503 con envolvente estándar si MongoDB no responde', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SERVICE_NOT_READY');
  });
});
