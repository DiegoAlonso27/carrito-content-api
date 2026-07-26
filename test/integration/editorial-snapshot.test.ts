import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import type { ContentCache } from '../../src/modules/content/content.types.js';
import { parseAnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import type { AnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import {
  applyMigrationPlan,
  buildMigrationPlan,
  loadMigrationInput,
} from '../../src/modules/editorial/editorial-migrate.js';
import { editorialCollections } from '../../src/modules/editorial/editorial.collections.js';
import {
  EditorialSnapshotService,
  SnapshotPublishError,
  listEditorialSnapshots,
  publishEditorialSnapshot,
  rollbackEditorialSnapshot,
} from '../../src/modules/editorial/editorial-snapshot.service.js';
import { EDITORIAL_SNAPSHOTS_COLLECTION } from '../../src/modules/editorial/editorial-snapshot.repo.js';
import type { EditorialSnapshotBody } from '../../src/modules/editorial/editorial-snapshot.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * Export v2 completo sobre los 32 destinos migrados, incluida la comprobación
 * central de esta fase: `/v1/export/content-cache` sigue byte a byte igual al
 * golden después de publicar snapshots editoriales.
 */
const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));
const catalogPath = fileURLToPath(
  new URL('../fixtures/catalogo-localidades.anotado.json', import.meta.url),
);
const KEY = 'test-key-editorial-0123456789abcdef0123';
const SNAPSHOT_URL = '/v1/export/editorial/es-PE';
const audit = { operator: 'pruebas', reason: 'suite de integración' };

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;
let goldenRaw: string;

beforeAll(async () => {
  goldenRaw = await readFile(goldenPath, 'utf8');
  const golden = validateCache(JSON.parse(goldenRaw)).cache as ContentCache;
  const parsed = parseAnnotatedCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  const catalog = parsed.catalog as AnnotatedCatalog;

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  app = buildApp(makeTestConfig({ MONGO_URI: replSet.getUri(), EXPORT_API_KEYS: KEY }));
  await app.ready();

  const db = app.mongo.contentDb;
  await importCache(db, golden);
  await applyMigrationPlan(db, buildMigrationPlan(await loadMigrationInput(db, catalog)));

  // Publicación en bloque del grafo migrado: es el estado que tendría staging
  // tras el ensayo de la Fase 5.
  for (const collection of [
    editorialCollections.amenities,
    editorialCollections.services,
    editorialCollections.localities,
    editorialCollections.destinations,
  ]) {
    await db.collection(collection).updateMany({}, { $set: { status: 'published' } });
  }
}, 180_000);

afterAll(async () => {
  await app.close();
  await replSet.stop();
});

describe('publicación del snapshot', () => {
  it('publica v1 con manifest y checksum sobre los 32 destinos', async () => {
    const result = await publishEditorialSnapshot(app.mongo.contentDb, { locale: 'es-PE', ...audit });
    expect(result.version).toBe('v1');
    expect(result.destinationCount).toBe(32);
    // 32 destinos + 32 localidades + 3 servicios + 5 comodidades.
    expect(result.documentCount).toBe(72);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.etag).toBe('"editorial-es-PE-v1"');
  });

  it('--dry-run valida sin escribir', async () => {
    const before = await listEditorialSnapshots(app.mongo.contentDb, 'es-PE');
    const result = await publishEditorialSnapshot(app.mongo.contentDb, {
      locale: 'es-PE',
      ...audit,
      dryRun: true,
    });
    const after = await listEditorialSnapshots(app.mongo.contentDb, 'es-PE');
    expect(result.dryRun).toBe(true);
    expect(after).toHaveLength(before.length);
  });

  it('registra responsable y motivo de la activación', async () => {
    const [active] = await listEditorialSnapshots(app.mongo.contentDb, 'es-PE');
    expect(active?.state).toBe('active');
    expect(active?.activatedBy).toBe('pruebas');
    expect(active?.activationReason).toBe('suite de integración');
  });
});

describe('GET /v1/export/editorial/:locale', () => {
  it('exige la clave de export', async () => {
    const res = await app.inject({ method: 'GET', url: SNAPSHOT_URL });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('sirve el snapshot activo con su checksum verificable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    expect(body.schemaVersion).toBe(2);
    expect(body.locale).toBe('es-PE');
    expect(body.destinations).toHaveLength(32);
    expect(body.manifest).toHaveLength(72);
    expect(body.services.map((s) => s['id']).sort()).toEqual([
      'bus-cama',
      'bus-cama-vip',
      'bus-normal',
    ]);
  });

  it('expone las URL canónicas decididas en la Fase 1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    const byId = new Map(body.destinations.map((d) => [d['id'] as string, d]));
    expect(byId.get('moyobamba')?.['canonicalUrl']).toBe('/destinos/moyobamba');
    expect(byId.get('naranjos')?.['canonicalUrl']).toBe('/destinos/tarapoto/naranjos');
    expect(byId.get('chiclayo')?.['canonicalUrl']).toBe('/destinos/chiclayo');
    expect(body.redirects).toContainEqual({
      from: '/destinos/tarapoto/moyobamba',
      to: '/destinos/moyobamba',
    });
  });

  it('responde 304 con If-None-Match', async () => {
    const first = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    const etag = first.headers['etag'] as string;
    const second = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY, 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('404 si el locale no tiene snapshot activo (no construye al vuelo)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/export/editorial/en',
      headers: { 'x-export-key': KEY },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('no regresión del export vigente', () => {
  it('/v1/export/content-cache sigue siendo byte-idéntico al golden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/export/content-cache',
      headers: { 'x-export-key': KEY },
    });
    expect(res.statusCode).toBe(200);

    const exported = JSON.parse(res.body) as ContentCache;
    const goldenParsed = JSON.parse(goldenRaw) as ContentCache;
    goldenParsed.generatedAtUtc = exported.generatedAtUtc;
    expect(res.body).toBe(JSON.stringify(goldenParsed));
  });

  it('publicar un snapshot editorial no cambia el ETag del export vigente', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/export/content-cache',
      headers: { 'x-export-key': KEY },
    });
    await publishEditorialSnapshot(app.mongo.contentDb, { locale: 'es-PE', ...audit });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/export/content-cache',
      headers: { 'x-export-key': KEY },
    });
    expect(after.headers['etag']).toBe(before.headers['etag']);
  });
});

describe('versionado, rollback y retención', () => {
  it('cada publicación crea una versión nueva y desplaza la anterior', async () => {
    const snapshots = await listEditorialSnapshots(app.mongo.contentDb, 'es-PE');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.filter((s) => s.state === 'active')).toHaveLength(1);
    expect(snapshots[0]?.version).toBe('v2');
    expect(snapshots[0]?.state).toBe('active');
  });

  it('el ETag del snapshot cambia con la versión activa', async () => {
    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.headers['etag']).toBe('"editorial-es-PE-v2"');
  });

  it('revierte a la versión anterior conservando su checksum', async () => {
    const result = await rollbackEditorialSnapshot(app.mongo.contentDb, {
      locale: 'es-PE',
      version: 'v1',
      operator: 'operaciones',
      reason: 'ensayo de rollback',
    });
    expect(result.previousVersion).toBe('v2');
    expect(result.version).toBe('v1');

    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.headers['etag']).toBe('"editorial-es-PE-v1"');
    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    expect(body.version).toBe('v1');
    expect(body.checksum).toBe(result.checksum);
  });

  it('el rollback deja registrado quién y por qué', async () => {
    const snapshots = await listEditorialSnapshots(app.mongo.contentDb, 'es-PE');
    const active = snapshots.find((s) => s.state === 'active');
    expect(active?.version).toBe('v1');
    expect(active?.activatedBy).toBe('operaciones');
    expect(active?.activationReason).toBe('ensayo de rollback');
  });

  it('revertir a una versión inexistente falla sin tocar el activo', async () => {
    await expect(
      rollbackEditorialSnapshot(app.mongo.contentDb, {
        locale: 'es-PE',
        version: 'v99',
        ...audit,
      }),
    ).rejects.toThrow(SnapshotPublishError);

    const active = (await listEditorialSnapshots(app.mongo.contentDb, 'es-PE')).find(
      (s) => s.state === 'active',
    );
    expect(active?.version).toBe('v1');
  });
});

describe('integridad ante manipulación', () => {
  it('no sirve ni activa un snapshot manipulado en la base', async () => {
    const db = app.mongo.contentDb;
    const stored = await db
      .collection<{ version: string; body: string }>(EDITORIAL_SNAPSHOTS_COLLECTION)
      .findOne({ locale: 'es-PE', version: 'v2' });
    const body = JSON.parse(stored?.body ?? '{}') as EditorialSnapshotBody;
    (body.destinations[0] as Record<string, unknown>)['name'] = 'Nombre inyectado';
    await db
      .collection(EDITORIAL_SNAPSHOTS_COLLECTION)
      .updateOne({ locale: 'es-PE', version: 'v2' }, { $set: { body: JSON.stringify(body) } });

    await expect(
      rollbackEditorialSnapshot(db, { locale: 'es-PE', version: 'v2', ...audit }),
    ).rejects.toThrow(/integridad/);

    // El activo sigue siendo el sano.
    const service = new EditorialSnapshotService(db);
    const served = await service.getActive('es-PE');
    expect(served?.version).toBe('v1');
  });
});
