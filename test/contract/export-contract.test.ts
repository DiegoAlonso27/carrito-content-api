import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import type { ContentCache, ContentMetaDoc } from '../../src/modules/content/content.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * TEST DE CONTRATO — gate central del proyecto (plan F2).
 *
 * Golden file congelado en test/contract/golden/. Si este test falla, el
 * cambio rompe la compatibilidad con carrito-front y está mal salvo decisión
 * explícita de contrato (AGENTS.md).
 */
const goldenPath = fileURLToPath(new URL('./golden/content-cache.json', import.meta.url));
const EXPORT_URL = '/v1/export/content-cache';
const KEY_A = 'test-key-a-0123456789abcdef';
const KEY_B = 'test-key-b-fedcba9876543210';

let mongod: MongoMemoryServer;
let app: FastifyInstance;
let golden: ContentCache;
let goldenRaw: string;

beforeAll(async () => {
  goldenRaw = await readFile(goldenPath, 'utf8');
  const validated = validateCache(JSON.parse(goldenRaw));
  expect(validated.errors).toEqual([]);
  golden = validated.cache as ContentCache;

  mongod = await MongoMemoryServer.create();
  app = buildApp(
    makeTestConfig({
      MONGO_URI: mongod.getUri(),
      EXPORT_API_KEYS: `${KEY_A}, ${KEY_B}`,
    }),
  );
  await importCache(app.mongo.contentDb, golden);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('autenticación del export', () => {
  it('401 sin clave, con envolvente estándar', async () => {
    const res = await app.inject({ method: 'GET', url: EXPORT_URL });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('401 con clave incorrecta', async () => {
    const res = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': 'clave-invalida' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ambas claves configuradas funcionan (rotación sin corte)', async () => {
    for (const key of [KEY_A, KEY_B]) {
      const res = await app.inject({
        method: 'GET',
        url: EXPORT_URL,
        headers: { 'x-export-key': key },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('sin claves configuradas el endpoint queda deshabilitado (401 siempre)', async () => {
    const disabled = buildApp(makeTestConfig({ MONGO_URI: mongod.getUri(), EXPORT_API_KEYS: '' }));
    try {
      const res = await disabled.inject({
        method: 'GET',
        url: EXPORT_URL,
        headers: { 'x-export-key': KEY_A },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await disabled.close();
    }
  });
});

describe('contrato byte-compatible con el golden file', () => {
  it('el export reproduce el golden EXACTO — claves, orden y tokens — salvo generatedAtUtc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const exported = JSON.parse(res.body) as ContentCache;
    // generatedAtUtc es el sello de esta generación: ISO 8601 UTC.
    expect(exported.generatedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Comparación BYTE a BYTE de strings JSON (verifica también orden de
    // claves y de arrays), normalizando solo el timestamp de generación.
    const goldenParsed = JSON.parse(goldenRaw) as ContentCache;
    goldenParsed.generatedAtUtc = exported.generatedAtUtc;
    expect(res.body).toBe(JSON.stringify(goldenParsed));
  });

  it('los rowVersionToken exportados son EXACTOS a los originales (revision sembrada)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    const exported = JSON.parse(res.body) as ContentCache;
    expect(exported.versionTokens).toEqual(golden.versionTokens);
  });
});

describe('ETag y caché', () => {
  it('ETag estable entre requests y 304 con If-None-Match', async () => {
    const first = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    expect(second.headers['etag']).toBe(etag);
    // generatedAtUtc estable mientras no cambie el contenido (caché en memoria).
    expect(second.body).toBe(first.body);

    const conditional = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A, 'if-none-match': etag },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.body).toBe('');
  });

  it('el 304 también exige autenticación', async () => {
    const first = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    const res = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'if-none-match': first.headers['etag'] as string },
    });
    expect(res.statusCode).toBe(401);
  });

  it('al subir contentVersion cambia el ETag y se reconstruye el export', async () => {
    const before = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });

    await app.mongo.contentDb
      .collection<ContentMetaDoc>(contentCollections.meta)
      .updateOne({ _id: 'content' }, { $inc: { contentVersion: 1 } });

    const after = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    expect(after.headers['etag']).not.toBe(before.headers['etag']);

    // El contenido no cambió (solo la versión): mismo cuerpo salvo el sello.
    const a = JSON.parse(before.body) as ContentCache;
    const b = JSON.parse(after.body) as ContentCache;
    a.generatedAtUtc = b.generatedAtUtc;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('un item draft NO aparece en el export (ni en items ni en versionTokens)', async () => {
    await app.mongo.contentDb.collection(contentCollections.items).insertOne({
      collectionSlug: 'faqs',
      localeCode: 'es-PE',
      slug: 'faq-borrador-test',
      sortOrder: 999,
      isActive: true,
      data: { question: '¿Borrador?', answerHtml: '<p>No debe salir.</p>' },
      status: 'draft',
      revision: 99999,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await app.mongo.contentDb
      .collection<ContentMetaDoc>(contentCollections.meta)
      .updateOne({ _id: 'content' }, { $inc: { contentVersion: 1 } });

    const res = await app.inject({
      method: 'GET',
      url: EXPORT_URL,
      headers: { 'x-export-key': KEY_A },
    });
    const exported = JSON.parse(res.body) as ContentCache;

    expect(exported.items.some((i) => i.slug === 'faq-borrador-test')).toBe(false);
    expect(exported.versionTokens.some((t) => t.sourceKey.includes('faq-borrador-test'))).toBe(
      false,
    );
    expect(exported.items).toHaveLength(83);
  });
});
