import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * Gate de fase F6: con `FEATURE_COMPLAINTS_ENABLED=false` (default) el endpoint
 * de reclamos NO está disponible. Debe responder 503 sin tocar Mongo, el repo
 * ni el parser multipart.
 *
 * La app apunta a un Mongo INALCANZABLE a propósito: si el camino del 503
 * tocara la base, la petición fallaría o colgaría. Que devuelva 503 igualmente
 * prueba que el gate no ejerce ninguna dependencia.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(makeTestConfig({ MONGO_URI: 'mongodb://127.0.0.1:1' }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('POST /v1/complaints — gate deshabilitado (flag false)', () => {
  it('responde 503 con la envolvente estándar y código COMPLAINTS_DISABLED, sin tocar Mongo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/complaints',
      payload: { anything: 'x' },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('COMPLAINTS_DISABLED');
    expect(body.error.requestId).toBeTruthy();
    expect(typeof body.error.message).toBe('string');
  });

  it('un cuerpo multipart también queda bloqueado (el parser multipart no se registra con el gate off)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/complaints',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
      payload: '------x--\r\n',
    });
    // Sin el gate no hay parser multipart: Fastify rechaza el media type (415)
    // antes de cualquier lógica. Sigue siendo «no procesado», nunca un alta.
    expect(res.statusCode).toBe(415);
    expect(res.statusCode).not.toBe(201);
  });

  it('el flag por defecto es false (no se activa por error)', () => {
    expect(app.config.FEATURE_COMPLAINTS_ENABLED).toBe(false);
  });
});

describe('loadConfig — asserts de activación del gate', () => {
  const legalConfig = {
    COMPLAINTS_PROVIDER_LEGAL_NAME: 'Empresa Test SAC',
    COMPLAINTS_PROVIDER_RUC: '20123456789',
    COMPLAINTS_PROVIDER_ADDRESS: 'Av. Legal 100, Chiclayo',
    COMPLAINTS_CONFIRMATION_TEXT_VERSION: 'v1',
    COMPLAINTS_RESPONSE_DAYS: '30',
  };

  it('habilitar el flag sin el acuse COMPLAINTS_LEGAL_GATE_CLEARED detiene el arranque', () => {
    expect(() => makeTestConfig({ FEATURE_COMPLAINTS_ENABLED: 'true', ...legalConfig })).toThrow(
      /COMPLAINTS_LEGAL_GATE_CLEARED=true/,
    );
  });

  it('habilitar el flag con acuse pero sin proveedor/plazo/texto detiene el arranque', () => {
    expect(() =>
      makeTestConfig({
        FEATURE_COMPLAINTS_ENABLED: 'true',
        COMPLAINTS_LEGAL_GATE_CLEARED: 'true',
      }),
    ).toThrow(/requiere cerrar el gate legal/);
  });

  it('con acuse + gate legal configurado, el flag true es aceptado (fuera de producción)', () => {
    expect(() =>
      makeTestConfig({
        FEATURE_COMPLAINTS_ENABLED: 'true',
        COMPLAINTS_LEGAL_GATE_CLEARED: 'true',
        ...legalConfig,
      }),
    ).not.toThrow();
  });

  it('en producción exige además correo (P2) y credenciales propias de forms', () => {
    expect(() =>
      makeTestConfig({
        NODE_ENV: 'production',
        FEATURE_COMPLAINTS_ENABLED: 'true',
        COMPLAINTS_LEGAL_GATE_CLEARED: 'true',
        MONGO_URI_FORMS: 'mongodb://user:pass@127.0.0.1:27017/forms',
        ...legalConfig,
      }),
    ).toThrow(/COMPLAINTS_SMTP_HOST/);
  });
});
