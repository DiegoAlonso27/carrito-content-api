import { describe, expect, it } from 'vitest';
import { createMongoContext, closeMongo } from '../../src/shared/db/mongo.js';
import { makeTestConfig } from '../helpers/test-config.js';

describe('separación dura de credenciales/bases (AGENTS.md)', () => {
  it('falla rápido si MONGO_DB_CONTENT y MONGO_DB_FORMS son la misma base', () => {
    expect(() =>
      createMongoContext(makeTestConfig({ MONGO_DB_CONTENT: 'una_sola_base', MONGO_DB_FORMS: 'una_sola_base' })),
    ).toThrow(/no pueden ser la misma base/);
  });

  it('crea clientes Mongo independientes para contenido y formularios', async () => {
    const ctx = createMongoContext(makeTestConfig());
    expect(ctx.contentClient).not.toBe(ctx.formsClient);
    await closeMongo(ctx);
  });
});
