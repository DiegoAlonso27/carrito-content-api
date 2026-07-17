import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import type { ContentBundle } from '../../src/modules/content/content-read.js';
import type { ContentCache, ContentMetaDoc } from '../../src/modules/content/content.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));
const FRONT_ORIGIN = 'https://front.example.test';

let mongod: MongoMemoryServer;
let app: FastifyInstance;
let golden: ContentCache;

async function bumpVersion(): Promise<void> {
  await app.mongo.contentDb
    .collection<ContentMetaDoc>(contentCollections.meta)
    .updateOne({ _id: 'content' }, { $inc: { contentVersion: 1 } });
}

beforeAll(async () => {
  const validated = validateCache(JSON.parse(await readFile(goldenPath, 'utf8')));
  golden = validated.cache as ContentCache;

  mongod = await MongoMemoryServer.create();
  app = buildApp(
    makeTestConfig({
      MONGO_URI: mongod.getUri(),
      CORS_ORIGINS: `${FRONT_ORIGIN}, https://otro.example.test`,
    }),
  );
  await importCache(app.mongo.contentDb, golden);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('GET /v1/locales', () => {
  it('devuelve los locales publicados activos con la forma del contrato', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locales' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      locales: [
        { code: 'es-PE', name: 'Español (Perú)', isDefault: true, isActive: true, sortOrder: 1 },
      ],
    });
  });
});

describe('GET /v1/content/:locale', () => {
  it('el bundle es-PE contiene el mismo contenido que el export (misma fuente)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/content/es-PE' });
    expect(res.statusCode).toBe(200);

    const bundle = res.json<ContentBundle>();
    expect(bundle.locale).toBe('es-PE');
    expect(bundle.settings).toEqual(golden.settings);
    expect(bundle.assets).toEqual(golden.assets);
    expect(bundle.collections).toEqual(golden.collections);
    expect(bundle.pages).toEqual(golden.pages);
    expect(bundle.texts).toEqual(golden.texts);
    // Items: misma data y orden, sin rowVersionToken (artefacto build-time).
    expect(bundle.items).toEqual(
      golden.items.map(({ rowVersionToken, ...item }) => {
        void rowVersionToken;
        return item;
      }),
    );
    expect(res.body).not.toContain('rowVersionToken');
    expect(res.body).not.toContain('_id');
    expect(res.body).not.toContain('"status"');
  });

  it('404 con envolvente estándar para un idioma inexistente', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/content/fr' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('ETag por contentVersion y 304 con If-None-Match', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/content/es-PE' });
    const etag = first.headers['etag'] as string;
    expect(etag).toMatch(/^"content-v\d+"$/);
    expect(first.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=3600');

    const conditional = await app.inject({
      method: 'GET',
      url: '/v1/content/es-PE',
      headers: { 'if-none-match': etag },
    });
    expect(conditional.statusCode).toBe(304);
  });

  it('un item draft no aparece en el bundle', async () => {
    await app.mongo.contentDb.collection(contentCollections.items).insertOne({
      collectionSlug: 'faqs',
      localeCode: 'es-PE',
      slug: 'faq-draft-runtime',
      sortOrder: 998,
      isActive: true,
      data: { question: 'draft', answerHtml: '<p>no</p>' },
      status: 'draft',
      revision: 90000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await bumpVersion();

    const res = await app.inject({ method: 'GET', url: '/v1/content/es-PE' });
    const bundle = res.json<ContentBundle>();
    expect(bundle.items.some((i) => i.slug === 'faq-draft-runtime')).toBe(false);
    expect(bundle.items).toHaveLength(83);
  });
});

describe('fallback de idioma (en → es-PE)', () => {
  beforeAll(async () => {
    const now = new Date();
    const envelope = { status: 'published', revision: 91000, createdAt: now, updatedAt: now };
    await app.mongo.contentDb.collection(contentCollections.locales).insertOne({
      code: 'en',
      name: 'English',
      isDefault: false,
      isActive: true,
      sortOrder: 2,
      ...envelope,
    });
    // Una traducción real: solo este text existe en inglés.
    await app.mongo.contentDb.collection(contentCollections.texts).insertOne({
      localeCode: 'en',
      key: 'complaints.heading.preTitle',
      value: 'Book of',
      isActive: true,
      sortOrder: 490,
      ...envelope,
    });
    await bumpVersion();
  });

  it('el bundle en une la traducción inglesa con el fallback es-PE', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/content/en' });
    expect(res.statusCode).toBe(200);

    const bundle = res.json<ContentBundle>();
    expect(bundle.locale).toBe('en');
    // Mismo número de texts que el default: cada clave existe una sola vez.
    expect(bundle.texts).toHaveLength(golden.texts.length);

    const translated = bundle.texts.find((t) => t.key === 'complaints.heading.preTitle');
    expect(translated).toMatchObject({ localeCode: 'en', value: 'Book of' });

    // El resto viene del default y conserva su localeCode real (es-PE).
    const fallback = bundle.texts.find((t) => t.key === 'complaints.heading.title');
    expect(fallback?.localeCode).toBe('es-PE');

    // Items y pages sin traducción: 100% fallback.
    expect(bundle.items).toHaveLength(83);
    expect(bundle.pages).toHaveLength(13);
    expect(bundle.items.every((i) => i.localeCode === 'es-PE')).toBe(true);
  });

  it('/v1/locales ahora lista ambos idiomas en orden', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locales' });
    const { locales } = res.json<{ locales: { code: string }[] }>();
    expect(locales.map((l) => l.code)).toEqual(['es-PE', 'en']);
  });
});

describe('GET /v1/content/:locale/collections/:slug/items', () => {
  it('devuelve los items publicados de la colección', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/content/es-PE/collections/faqs/items',
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: { collectionSlug: string }[] }>();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.collectionSlug === 'faqs')).toBe(true);
  });

  it('404 para colección inexistente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/content/es-PE/collections/no-existe/items',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('CORS', () => {
  it('origen permitido recibe Access-Control-Allow-Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locales',
      headers: { origin: FRONT_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(FRONT_ORIGIN);
  });

  it('origen NO permitido no recibe cabeceras CORS', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locales',
      headers: { origin: 'https://malicioso.example.test' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('helmet agrega cabeceras de seguridad', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locales' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('rate limiting de lectura', () => {
  it('supera el límite → 429 con envolvente estándar y Retry-After', async () => {
    const limited = buildApp(
      makeTestConfig({ MONGO_URI: mongod.getUri(), RATE_LIMIT_READ_PER_MINUTE: '3' }),
    );
    try {
      await limited.ready();
      for (let i = 0; i < 3; i++) {
        const ok = await limited.inject({ method: 'GET', url: '/v1/locales' });
        expect(ok.statusCode).toBe(200);
      }
      const blocked = await limited.inject({ method: 'GET', url: '/v1/locales' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');

      // El export no comparte el presupuesto de lectura pública.
      const exportRes = await limited.inject({ method: 'GET', url: '/v1/export/content-cache' });
      expect(exportRes.statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });
});
