import { describe, expect, it } from 'vitest';
import { createMongoContext, closeMongo } from '../../src/shared/db/mongo.js';
import { makeTestConfig } from '../helpers/test-config.js';

describe('separación dura de credenciales/bases (AGENTS.md)', () => {
  it('falla rápido si MONGO_DB_CONTENT y MONGO_DB_FORMS son la misma base', () => {
    expect(() =>
      createMongoContext(
        makeTestConfig({ MONGO_DB_CONTENT: 'una_sola_base', MONGO_DB_FORMS: 'una_sola_base' }),
      ),
    ).toThrow(/no pueden ser la misma base/);
  });

  it('crea clientes Mongo independientes para contenido y formularios', async () => {
    const ctx = createMongoContext(makeTestConfig());
    expect(ctx.contentClient).not.toBe(ctx.formsClient);
    await closeMongo(ctx);
  });

  it('en producción exige MONGO_URI_FORMS no vacío si el contacto está habilitado', () => {
    expect(() =>
      makeTestConfig({
        NODE_ENV: 'production',
        FEATURE_CONTACT_ENABLED: 'true',
        MONGO_URI: 'mongodb://content-user@127.0.0.1:27017',
        MONGO_URI_FORMS: '',
      }),
    ).toThrow(/MONGO_URI_FORMS es obligatorio en producción/);
  });

  it('en producción sin contacto no exige MONGO_URI_FORMS (línea base F0–F4)', () => {
    const config = makeTestConfig({
      NODE_ENV: 'production',
      FEATURE_CONTACT_ENABLED: 'false',
      MONGO_URI: 'mongodb://content-user@127.0.0.1:27017',
      MONGO_URI_FORMS: '',
    });
    expect(config.FEATURE_CONTACT_ENABLED).toBe(false);
  });

  it('en producción rechaza MONGO_URI_FORMS igual a MONGO_URI si el contacto está habilitado', () => {
    const uri = 'mongodb://shared-user@127.0.0.1:27017';
    expect(() =>
      makeTestConfig({
        NODE_ENV: 'production',
        FEATURE_CONTACT_ENABLED: 'true',
        MONGO_URI: uri,
        MONGO_URI_FORMS: uri,
      }),
    ).toThrow(/no puede coincidir con MONGO_URI/);
  });

  it('en producción acepta URIs distintas para forms con contacto habilitado', () => {
    const config = makeTestConfig({
      NODE_ENV: 'production',
      FEATURE_CONTACT_ENABLED: 'true',
      MONGO_URI: 'mongodb://content-user@127.0.0.1:27017',
      MONGO_URI_FORMS: 'mongodb://forms-user@127.0.0.1:27017',
    });
    expect(config.MONGO_URI_FORMS).toContain('forms-user');
  });
});
