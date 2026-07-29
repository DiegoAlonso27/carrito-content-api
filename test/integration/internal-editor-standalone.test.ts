import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * Editor interno contra MongoDB **standalone** (sin replica set).
 *
 * Las escrituras editoriales exigen transacciones multi-documento y por tanto
 * replica set (ADR-001). `content-write-standalone.test.ts` ya cubre que
 * `setRecords` falle ahí; esta suite cierra el tramo HTTP que el runbook promete:
 * el guardado responde `503 SERVICE_NOT_READY` —una topología mal desplegada no
 * es culpa del cuerpo enviado— y el mensaje público NO describe la
 * infraestructura (AGENTS.md: ese detalle vive solo en el log).
 *
 * Archivo propio a propósito: `MongoMemoryServer` standalone y
 * `MongoMemoryReplSet` en el mismo archivo compartirían binario y ciclo de vida
 * sin necesidad, y la topología es justo la variable bajo prueba.
 */

const SECTION_PATH = '/internal/api/settings';

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, string[]> };
}

interface ListBody {
  section: string;
  contentVersion: number;
  records: Record<string, unknown>[];
}

/**
 * `settings` es la única sección editable sin referencias externas (ni locale ni
 * assets): así el PUT atraviesa el preflight de `setRecords` y llega hasta la
 * transacción, que es lo que aquí se quiere ejercitar.
 */
const NEW_SETTING = {
  key: 'editor.standalone.prohibido',
  value: 'no debe llegar a Mongo',
  valueType: 'string',
  description: 'alta imposible sin replica set',
  isActive: true,
  sortOrder: 995,
};

let mongod: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  app = buildApp(
    makeTestConfig({
      INTERNAL_EDITOR_ENABLED: 'true',
      MONGO_URI: mongod.getUri(),
      MONGO_DB_CONTENT: 'carrito_content_editor_standalone_test',
    }),
  );
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('guardado del editor interno en Mongo standalone (ADR-001)', () => {
  it('la base vacía reporta contentVersion 0, que es el valor a enviar en el PUT', async () => {
    // Verificado, no asumido: el control optimista compara contra este número y
    // un valor distinto daría 409 antes de llegar a la transacción.
    const res = await app.inject({ method: 'GET', url: SECTION_PATH });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListBody>();
    expect(body.contentVersion).toBe(0);
    expect(body.records).toEqual([]);
  });

  it('responde 503 SERVICE_NOT_READY al guardar, sin escribir nada', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: SECTION_PATH,
      payload: { expectedContentVersion: 0, records: [NEW_SETTING] },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('SERVICE_NOT_READY');
    expect(body.error.requestId).toBeTruthy();

    // La transacción aborta entera: ni el registro ni el bump de versión.
    const after = (await app.inject({ method: 'GET', url: SECTION_PATH })).json<ListBody>();
    expect(after.records).toEqual([]);
    expect(after.contentVersion).toBe(0);
  });

  it('el mensaje público no filtra el detalle de infraestructura', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: SECTION_PATH,
      payload: { expectedContentVersion: 0, records: [NEW_SETTING] },
    });

    expect(res.statusCode).toBe(503);
    // El texto de `ContentTopologyWriteError` («…requieren MongoDB en replica
    // set… (ADR-001)») describe el despliegue: útil en el log, nunca en la
    // envolvente pública.
    const serialized = res.body.toLowerCase();
    for (const leak of ['replica set', 'mongodb', 'mongo', 'adr-001', 'transacc', 'standalone']) {
      expect(serialized, leak).not.toContain(leak);
    }
    expect(res.json<ErrorBody>().error.details).toBeUndefined();
  });
});
