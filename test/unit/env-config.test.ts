import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/shared/config/env.js';
import { makeTestConfig } from '../helpers/test-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig — validación transversal F7', () => {
  it('falla si CARRITO_ENV_FILE fue indicado pero no existe', () => {
    vi.stubEnv('CARRITO_ENV_FILE', 'Z:\\ruta-inexistente-f7\\.env');
    expect(() => loadConfig()).toThrow(/CARRITO_ENV_FILE no existe/);
  });

  it.each([
    '*',
    'https://front.example.test/ruta',
    'https://user:password@front.example.test',
    'not-an-origin',
  ])('rechaza CORS_ORIGINS inseguro o inválido: %s', (origin) => {
    expect(() => makeTestConfig({ CORS_ORIGINS: origin })).toThrow(/CORS_ORIGINS/);
  });

  it('acepta orígenes http(s) exactos separados por coma', () => {
    const config = makeTestConfig({
      CORS_ORIGINS: 'https://front.example.test,http://127.0.0.1:3000',
    });
    expect(config.CORS_ORIGINS_LIST).toEqual([
      'https://front.example.test',
      'http://127.0.0.1:3000',
    ]);
  });

  it('rechaza nombres de bases iguales durante loadConfig', () => {
    expect(() => makeTestConfig({ MONGO_DB_CONTENT: 'misma', MONGO_DB_FORMS: 'misma' })).toThrow(
      /no pueden ser la misma base/,
    );
  });

  it('rechaza una URI de forms con esquema no MongoDB', () => {
    expect(() => makeTestConfig({ MONGO_URI_FORMS: 'https://db.example.test' })).toThrow(
      /MONGO_URI_FORMS debe ser una URI/,
    );
  });

  it('valida las claves de export dentro de loadConfig', () => {
    expect(() => makeTestConfig({ EXPORT_API_KEYS: 'demasiado-corta' })).toThrow(
      /al menos 32 caracteres/,
    );
  });

  it('rechaza límites de adjuntos incoherentes', () => {
    expect(() =>
      makeTestConfig({
        COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES: '200',
        COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES: '100',
      }),
    ).toThrow(/MAX_FILE_BYTES no puede superar/);
  });

  it('reserva espacio BSON para la hoja y los metadatos', () => {
    expect(() =>
      makeTestConfig({
        COMPLAINTS_SIGNATURE_MAX_BYTES: String(2 * 1024 * 1024),
        COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES: String(14 * 1024 * 1024),
      }),
    ).toThrow(/como máximo 15 MiB/);
  });

  it('rechaza tipos de adjunto que el detector por firma mágica no soporta', () => {
    expect(() =>
      makeTestConfig({ COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES: 'application/zip' }),
    ).toThrow(/tipos no soportados/);
  });

  it('exige pares SMTP completos sin obligar a configurar SMTP', () => {
    expect(() => makeTestConfig({ COMPLAINTS_SMTP_HOST: 'smtp.example.test' })).toThrow(
      /SMTP_HOST y COMPLAINTS_SMTP_FROM deben configurarse juntos/,
    );
    expect(() => makeTestConfig()).not.toThrow();
  });
});
