import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import type { ContentCache } from '../../src/modules/content/content.types.js';
import { parseAnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import type { AnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import {
  applyMigrationPlan,
  buildMigrationPlan,
  loadMigrationInput,
} from '../../src/modules/editorial/editorial-migrate.js';
import type { MigrationOutcome } from '../../src/modules/editorial/editorial-migrate.js';
import { editorialCollections } from '../../src/modules/editorial/editorial.collections.js';
import { EditorialRepo } from '../../src/modules/editorial/editorial.repo.js';
import {
  setEditorialStatus,
  validateEditorialGraph,
} from '../../src/modules/editorial/editorial-write.js';
import type { EditorialSectionName } from '../../src/modules/editorial/editorial.schemas.js';
import {
  SnapshotPublishError,
  listEditorialSnapshots,
  publishEditorialSnapshot,
  rollbackEditorialSnapshot,
} from '../../src/modules/editorial/editorial-snapshot.service.js';
import { EDITORIAL_SNAPSHOTS_COLLECTION } from '../../src/modules/editorial/editorial-snapshot.repo.js';
import {
  checksumOf,
  verifySnapshotIntegrity,
} from '../../src/modules/editorial/editorial-snapshot.js';
import type { EditorialSnapshotBody } from '../../src/modules/editorial/editorial-snapshot.js';
import type { BoardingPointDoc, DestinationDoc } from '../../src/modules/editorial/editorial.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * ENSAYO DE CORTE DE TRACK B (Fase 5) sobre `MongoMemoryReplSet`.
 *
 * Ejecuta la secuencia completa que el runbook manda ejecutar en staging antes
 * de tocar producción, en este orden y sin saltos:
 *
 *   golden → migración de los 32 destinos → publicación del grafo →
 *   validateEditorialGraph → publicación del snapshot → verificación de
 *   checksum/manifest → rollback ensayado → export flat byte-idéntico.
 *
 * Cada bloque afirma explícitamente uno de los gates P0 del doc 11
 * (integridad, separación destino/punto, publicación correcta y rollback).
 * Los `it` de este archivo son PASOS: dependen del estado que dejó el anterior,
 * igual que el ensayo real. No reordenarlos.
 *
 * No hay MongoDB en la máquina de desarrollo: este archivo es el ensayo
 * reproducible, y `npm run editorial:cutover-check` es el mismo juego de gates
 * contra la base real.
 */

const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));
const catalogPath = fileURLToPath(
  new URL('../fixtures/catalogo-localidades.anotado.json', import.meta.url),
);
const KEY = 'test-key-cutover-0123456789abcdef01234567';
const LOCALE = 'es-PE';
const SNAPSHOT_URL = `/v1/export/editorial/${LOCALE}`;
const CACHE_URL = '/v1/export/content-cache';

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;
let catalog: AnnotatedCatalog;
let goldenRaw: string;

/** Fotografía del export vigente ANTES de tocar nada editorial. */
let cacheBefore: { body: string; etag: string };
/** Conteos del origen flat antes de migrar: la migración no puede moverlos. */
let flatCountsBefore: Record<string, number>;
let migration: MigrationOutcome;
/** Checksum del snapshot del corte (v1), el que hay que poder recuperar. */
let cutoverChecksum: string;

const audit = { operator: 'ensayo-fase-5', reason: 'ensayo de corte Track B' };

const flatCollectionsToWatch = [
  contentCollections.items,
  contentCollections.assets,
  contentCollections.texts,
  contentCollections.pages,
  contentCollections.settings,
  contentCollections.collections,
];

async function countFlat(): Promise<Record<string, number>> {
  const db = app.mongo.contentDb;
  const entries = await Promise.all(
    flatCollectionsToWatch.map(
      async (name): Promise<[string, number]> => [name, await db.collection(name).countDocuments()],
    ),
  );
  return Object.fromEntries(entries);
}

async function idsOf(collection: string): Promise<string[]> {
  const docs = await app.mongo.contentDb
    .collection<{ id: string }>(collection)
    .find({}, { projection: { id: 1 } })
    .sort({ id: 1 })
    .toArray();
  return docs.map((d) => d.id);
}

/** Publica una sección entera por la MISMA vía que el operador (`content:publish`). */
async function publishSection(section: EditorialSectionName, collection: string): Promise<number> {
  let ids = await idsOf(collection);
  // Destinos: padres antes que hijos; si no, parent-unpublished tumba el lote.
  if (section === 'destinations') {
    const docs = await app.mongo.contentDb
      .collection<{ id: string; parentId: string | null }>(collection)
      .find({}, { projection: { id: 1, parentId: 1 } })
      .toArray();
    const roots = docs.filter((d) => d.parentId === null).map((d) => d.id).sort();
    const children = docs.filter((d) => d.parentId !== null).map((d) => d.id).sort();
    ids = [...roots, ...children];
  }
  for (const id of ids) {
    await setEditorialStatus(app.mongo.contentDb, section, id, 'published');
  }
  return ids.length;
}

beforeAll(async () => {
  goldenRaw = await readFile(goldenPath, 'utf8');
  const golden = validateCache(JSON.parse(goldenRaw)).cache as ContentCache;
  const parsed = parseAnnotatedCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  expect(parsed.errors).toEqual([]);
  catalog = parsed.catalog as AnnotatedCatalog;

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  app = buildApp(makeTestConfig({ MONGO_URI: replSet.getUri(), EXPORT_API_KEYS: KEY }));
  await app.ready();

  await importCache(app.mongo.contentDb, golden);
  flatCountsBefore = await countFlat();

  const res = await app.inject({ method: 'GET', url: CACHE_URL, headers: { 'x-export-key': KEY } });
  cacheBefore = { body: res.body, etag: res.headers['etag'] as string };
}, 240_000);

afterAll(async () => {
  await app.close();
  await replSet.stop();
});

// ── Gate P0 · integridad de datos ───────────────────────────────────────────

describe('paso 1 · migración (gate P0: integridad de datos)', () => {
  it('migra los 32 destinos y sus 32 localidades desde el catálogo anotado', async () => {
    migration = await applyMigrationPlan(
      app.mongo.contentDb,
      buildMigrationPlan(await loadMigrationInput(app.mongo.contentDb, catalog)),
    );

    expect(migration.written['destinations']).toBe(32);
    expect(migration.written['localities']).toBe(32);
    expect(await app.mongo.contentDb.collection(editorialCollections.destinations).countDocuments())
      .toBe(32);
  }, 120_000);

  it('no borra ni modifica el origen flat', async () => {
    expect(await countFlat()).toEqual(flatCountsBefore);
    const guides = await app.mongo.contentDb
      .collection(contentCollections.items)
      .countDocuments({ collectionSlug: 'destination-guides' });
    expect(guides).toBe(3);
  });

  it('no infiere: lo no clasificable queda en la cola de revisión con motivo', async () => {
    const queue = await new EditorialRepo(app.mongo.contentDb).listReviewQueue('open');
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((q) => q.reason.trim().length > 0)).toBe(true);
    expect(queue.map((q) => q.id)).toContain('unclassified-service:economico');
  });

  it('no publica nada por sí misma: publicar es un acto explícito', async () => {
    const published = await app.mongo.contentDb
      .collection(editorialCollections.destinations)
      .countDocuments({ status: 'published' });
    expect(published).toBe(0);
  });

  it('el reporte de deriva catálogo ⇄ base queda disponible para el acta', () => {
    expect(migration.report.drift).toBeDefined();
    expect(Array.isArray(migration.report.drift.onlyInCatalog)).toBe(true);
    expect(Array.isArray(migration.report.drift.onlyInDatabase)).toBe(true);
  });
});

// ── Gate P0 · separación destino/punto ──────────────────────────────────────

describe('paso 2 · separación destino/punto (gate P0)', () => {
  it('los 3 registros solo-punto existen y ninguno es destino', async () => {
    const points = await app.mongo.contentDb
      .collection<BoardingPointDoc>(editorialCollections.boardingPoints)
      .find({})
      .toArray();

    expect(points.map((p) => p.id).sort()).toEqual([
      'agencia-chiclayo',
      'plaza-norte',
      'terminal-nor-oriente',
    ]);
    expect(points.every((p) => p.isDestination === false)).toBe(true);

    const asDestination = await app.mongo.contentDb
      .collection(editorialCollections.destinations)
      .countDocuments({ id: { $in: points.map((p) => p.id) } });
    expect(asDestination).toBe(0);
  });

  it('el invariante es estructural: MongoDB rechaza isDestination true', async () => {
    await expect(
      app.mongo.contentDb.collection(editorialCollections.boardingPoints).insertOne({
        id: 'punto-que-quiere-ser-destino',
        name: 'Punto',
        slug: 'punto-que-quiere-ser-destino',
        localityId: 'lima',
        isDestination: true,
        capabilities: ['boarding'],
        address: null,
        addressVerified: true,
        notes: [],
        status: 'draft',
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('ningún punto es publicable al corte: sin dirección o sin localidad (P-04/P-13)', async () => {
    const report = await validateEditorialGraph(app.mongo.contentDb);
    expect(report.boardingPoints).toHaveLength(3);
    expect(report.boardingPoints.every((p) => p.errors.length > 0)).toBe(true);
  });
});

// ── Gate P0 · publicación correcta ──────────────────────────────────────────

describe('paso 3 · publicación del grafo (gate P0: publicación correcta)', () => {
  it('antes de publicar, el snapshot saldría vacío: solo entra lo publicado', async () => {
    const dry = await publishEditorialSnapshot(app.mongo.contentDb, {
      locale: LOCALE,
      ...audit,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.destinationCount).toBe(0);
    expect(await listEditorialSnapshots(app.mongo.contentDb, LOCALE)).toHaveLength(0);
  });

  it('publica el grafo por la vía real (content:publish), documento a documento', async () => {
    const localities = await publishSection('localities', editorialCollections.localities);
    const amenities = await publishSection('amenities', editorialCollections.amenities);
    const services = await publishSection('services', editorialCollections.services);
    const destinations = await publishSection('destinations', editorialCollections.destinations);

    expect(localities).toBe(32);
    expect(amenities).toBe(5);
    expect(services).toBe(3);
    expect(destinations).toBe(32);

    const published = await app.mongo.contentDb
      .collection(editorialCollections.destinations)
      .countDocuments({ status: 'published' });
    expect(published).toBe(32);
  }, 180_000);

  it('validateEditorialGraph: ningún destino ni servicio publicado tiene errores', async () => {
    const report = await validateEditorialGraph(app.mongo.contentDb);
    const withErrors = report.destinations.filter((d) => d.errors.length > 0);
    expect(withErrors.map((d) => `${d.id}: ${d.errors.join(' | ')}`)).toEqual([]);
    expect(report.services.filter((s) => s.errors.length > 0)).toEqual([]);
    // Los únicos errores admisibles del grafo son los de los puntos sin
    // dirección verificada: son su gate de publicación, no un fallo del corte.
    expect(report.totalErrors).toBe(
      report.boardingPoints.reduce((n, p) => n + p.errors.length, 0),
    );
  });

  it('publica el snapshot v1 con manifest y checksum sobre los 32 destinos', async () => {
    const result = await publishEditorialSnapshot(app.mongo.contentDb, {
      locale: LOCALE,
      ...audit,
    });
    cutoverChecksum = result.checksum;

    expect(result.version).toBe('v1');
    expect(result.destinationCount).toBe(32);
    // 32 destinos + 32 localidades + 3 servicios + 5 comodidades.
    expect(result.documentCount).toBe(72);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.etag).toBe(`"editorial-${LOCALE}-v1"`);
  });

  it('el snapshot almacenado supera la verificación de checksum y manifest', async () => {
    const stored = await app.mongo.contentDb
      .collection<{ version: string; body: string; checksum: string }>(
        EDITORIAL_SNAPSHOTS_COLLECTION,
      )
      .findOne({ locale: LOCALE, version: 'v1' });
    expect(stored).not.toBeNull();

    const body = JSON.parse(stored?.body ?? '{}') as EditorialSnapshotBody;
    expect(verifySnapshotIntegrity(body)).toEqual([]);
    expect(checksumOf(body)).toBe(stored?.checksum);
    expect(body.manifest).toHaveLength(72);
    expect(body.manifest.every((m) => /^[a-f0-9]{64}$/.test(m.hash) && m.size > 0)).toBe(true);
  });

  it('ningún punto de embarque llega al snapshot publicado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    expect(body.boardingPoints).toEqual([]);
    const destinationIds = new Set(body.destinations.map((d) => d['id']));
    for (const id of ['plaza-norte', 'terminal-nor-oriente', 'agencia-chiclayo']) {
      expect(destinationIds.has(id)).toBe(false);
    }
  });

  it('el endpoint sirve exactamente el artefacto que pasó el gate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    expect(res.headers['etag']).toBe(`"editorial-${LOCALE}-v1"`);
    expect(body.checksum).toBe(cutoverChecksum);
    expect(body.destinations).toHaveLength(32);
    // URLs canónicas decididas en la Fase 1 (P-09/P-10).
    const byId = new Map(body.destinations.map((d) => [d['id'] as string, d]));
    expect(byId.get('moyobamba')?.['canonicalUrl']).toBe('/destinos/moyobamba');
    expect(byId.get('naranjos')?.['canonicalUrl']).toBe('/destinos/tarapoto/naranjos');
    expect(body.redirects).toContainEqual({
      from: '/destinos/tarapoto/moyobamba',
      to: '/destinos/moyobamba',
    });
  });

  it('el corte queda auditado: responsable y motivo del snapshot activo', async () => {
    const [active] = await listEditorialSnapshots(app.mongo.contentDb, LOCALE);
    expect(active?.state).toBe('active');
    expect(active?.activatedBy).toBe(audit.operator);
    expect(active?.activationReason).toBe(audit.reason);
  });
});

// ── Gate P0 · rollback ──────────────────────────────────────────────────────

describe('paso 4 · rollback ensayado (gate P0)', () => {
  it('una publicación posterior con una regresión crea v2 y desplaza a v1', async () => {
    // Regresión simulada: alguien archiva un destino publicado y publica.
    await setEditorialStatus(app.mongo.contentDb, 'destinations', 'lima', 'archived');
    const result = await publishEditorialSnapshot(app.mongo.contentDb, {
      locale: LOCALE,
      operator: 'operaciones',
      reason: 'publicación con regresión',
    });

    expect(result.version).toBe('v2');
    expect(result.destinationCount).toBe(31);

    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    expect((JSON.parse(res.body) as EditorialSnapshotBody).destinations).toHaveLength(31);
  }, 60_000);

  it('el rollback devuelve el contenido del corte sin reconstruir nada', async () => {
    const result = await rollbackEditorialSnapshot(app.mongo.contentDb, {
      locale: LOCALE,
      version: 'v1',
      operator: 'operaciones',
      reason: 'ensayo de rollback del corte',
    });
    expect(result.previousVersion).toBe('v2');
    expect(result.checksum).toBe(cutoverChecksum);

    const res = await app.inject({
      method: 'GET',
      url: SNAPSHOT_URL,
      headers: { 'x-export-key': KEY },
    });
    const body = JSON.parse(res.body) as EditorialSnapshotBody;
    expect(res.headers['etag']).toBe(`"editorial-${LOCALE}-v1"`);
    expect(body.version).toBe('v1');
    expect(body.destinations).toHaveLength(32);
    expect(body.checksum).toBe(cutoverChecksum);
  });

  it('el rollback deja registrado quién y por qué, y conserva la versión revertida', async () => {
    const snapshots = await listEditorialSnapshots(app.mongo.contentDb, LOCALE);
    expect(snapshots.map((s) => s.version).sort()).toEqual(['v1', 'v2']);
    expect(snapshots.filter((s) => s.state === 'active')).toHaveLength(1);

    const active = snapshots.find((s) => s.state === 'active');
    expect(active?.version).toBe('v1');
    expect(active?.activatedBy).toBe('operaciones');
    expect(active?.activationReason).toBe('ensayo de rollback del corte');
  });

  it('no se puede revertir a una versión inexistente ni a una manipulada', async () => {
    await expect(
      rollbackEditorialSnapshot(app.mongo.contentDb, {
        locale: LOCALE,
        version: 'v99',
        ...audit,
      }),
    ).rejects.toThrow(SnapshotPublishError);

    const stored = await app.mongo.contentDb
      .collection<{ version: string; body: string }>(EDITORIAL_SNAPSHOTS_COLLECTION)
      .findOne({ locale: LOCALE, version: 'v2' });
    const tampered = JSON.parse(stored?.body ?? '{}') as EditorialSnapshotBody;
    const first = tampered.destinations[0];
    if (first !== undefined) first['name'] = 'Nombre inyectado';
    await app.mongo.contentDb
      .collection(EDITORIAL_SNAPSHOTS_COLLECTION)
      .updateOne({ locale: LOCALE, version: 'v2' }, { $set: { body: JSON.stringify(tampered) } });

    await expect(
      rollbackEditorialSnapshot(app.mongo.contentDb, {
        locale: LOCALE,
        version: 'v2',
        ...audit,
      }),
    ).rejects.toThrow(/integridad/);

    const active = (await listEditorialSnapshots(app.mongo.contentDb, LOCALE)).find(
      (s) => s.state === 'active',
    );
    expect(active?.version).toBe('v1');
  });

  it('el estado editorial se puede restaurar tras el rollback del snapshot', async () => {
    await setEditorialStatus(app.mongo.contentDb, 'destinations', 'lima', 'published');
    const lima = await app.mongo.contentDb
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'lima' });
    expect(lima?.status).toBe('published');
  }, 60_000);
});

// ── Cierre del ensayo: el contrato del soft-launch sigue en pie ─────────────

describe('paso 5 · cierre del ensayo: el export vigente no se movió', () => {
  it('/v1/export/content-cache sigue byte-idéntico al golden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: CACHE_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.statusCode).toBe(200);

    const exported = JSON.parse(res.body) as ContentCache;
    const goldenParsed = JSON.parse(goldenRaw) as ContentCache;
    goldenParsed.generatedAtUtc = exported.generatedAtUtc;
    expect(res.body).toBe(JSON.stringify(goldenParsed));
  });

  it('su ETag es el mismo que antes de empezar el ensayo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: CACHE_URL,
      headers: { 'x-export-key': KEY },
    });
    expect(res.headers['etag']).toBe(cacheBefore.etag);
    const before = JSON.parse(cacheBefore.body) as ContentCache;
    const after = JSON.parse(res.body) as ContentCache;
    before.generatedAtUtc = after.generatedAtUtc;
    expect(res.body).toBe(JSON.stringify(before));
  });

  it('el origen flat sigue completo tras todo el ensayo', async () => {
    expect(await countFlat()).toEqual(flatCountsBefore);
  });
});
