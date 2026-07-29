import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import { ExportService } from '../../src/modules/export/export.service.js';
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
  EditorialWriteError,
  setEditorialRecords,
  setEditorialStatus,
  validateEditorialGraph,
} from '../../src/modules/editorial/editorial-write.js';
import { EditorialRepo } from '../../src/modules/editorial/editorial.repo.js';
import type { DestinationDoc } from '../../src/modules/editorial/editorial.types.js';

/**
 * Migración completa con los 32 destinos del catálogo aprobado.
 *
 * El catálogo canónico vive en
 * `web-tc-docs/plan-editorial-web-tc/catalogo-localidades.anotado.json`; aquí
 * se usa una copia como fixture para que el repo se pueda probar aislado.
 */
const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));
const catalogPath = fileURLToPath(
  new URL('../fixtures/catalogo-localidades.anotado.json', import.meta.url),
);

let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let catalog: AnnotatedCatalog;
let flatItemsBefore: number;

beforeAll(async () => {
  const golden = validateCache(JSON.parse(await readFile(goldenPath, 'utf8')))
    .cache as ContentCache;
  const parsed = parseAnnotatedCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  expect(parsed.errors).toEqual([]);
  catalog = parsed.catalog as AnnotatedCatalog;

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(replSet.getUri());
  await client.connect();
  db = client.db('carrito_content_editorial_test');
  await importCache(db, golden);
  flatItemsBefore = await db.collection(contentCollections.items).countDocuments();

  const input = await loadMigrationInput(db, catalog);
  await applyMigrationPlan(db, buildMigrationPlan(input));
}, 180_000);

afterAll(async () => {
  await client.close();
  await replSet.stop();
});

describe('migración flat → modelo editorial', () => {
  it('carga los 32 destinos del catálogo con su localidad', async () => {
    const destinations = await db.collection(editorialCollections.destinations).countDocuments();
    const localities = await db.collection(editorialCollections.localities).countDocuments();
    expect(destinations).toBe(32);
    expect(localities).toBe(32);
  });

  it('respeta la composición full/short del catálogo', async () => {
    const docs = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .find({})
      .toArray();
    expect(docs.filter((d) => d.pageType === 'full')).toHaveLength(15);
    expect(docs.filter((d) => d.pageType === 'short')).toHaveLength(17);
  });

  it('NO borra ni modifica el origen flat', async () => {
    const after = await db.collection(contentCollections.items).countDocuments();
    expect(after).toBe(flatItemsBefore);
    const guides = await db
      .collection(contentCollections.items)
      .countDocuments({ collectionSlug: 'destination-guides' });
    expect(guides).toBe(3);
  });

  it('NO publica nada automáticamente', async () => {
    const published = await db
      .collection(editorialCollections.destinations)
      .countDocuments({ status: 'published' });
    expect(published).toBe(0);
  });

  it('el export flat sigue intacto tras la migración (contrato del lunes)', async () => {
    const cache = JSON.parse((await new ExportService(db).get()).body) as ContentCache;
    expect(cache.items).toHaveLength(84);
    expect(cache.collections.map((c) => c.slug)).toContain('destination-guides');
  });

  it('crea los 3 servicios aprobados y las 5 comodidades', async () => {
    const services = await db
      .collection<{ id: string }>(editorialCollections.services)
      .find({})
      .sort({ id: 1 })
      .toArray();
    expect(services.map((s) => s.id)).toEqual(['bus-cama', 'bus-cama-vip', 'bus-normal']);
    expect(await db.collection(editorialCollections.amenities).countDocuments()).toBe(5);
  });

  it('registra los puntos de embarque sin convertirlos en destinos', async () => {
    const points = await db
      .collection<{ id: string; isDestination: boolean; status: string }>(
        editorialCollections.boardingPoints,
      )
      .find({})
      .toArray();
    expect(points.map((p) => p.id).sort()).toEqual([
      'agencia-chiclayo',
      'plaza-norte',
      'terminal-nor-oriente',
    ]);
    expect(points.every((p) => p.isDestination === false)).toBe(true);
    expect(points.every((p) => p.status === 'draft')).toBe(true);

    const asDestination = await db
      .collection(editorialCollections.destinations)
      .countDocuments({ id: { $in: ['plaza-norte', 'terminal-nor-oriente'] } });
    expect(asDestination).toBe(0);
  });

  it('deja la cola de revisión con lo no clasificable', async () => {
    const queue = await new EditorialRepo(db).listReviewQueue('open');
    const ids = queue.map((q) => q.id);
    expect(ids).toContain('unclassified-service:panoramico');
    expect(ids).toContain('unclassified-service:economico');
    expect(ids).toContain('orphan-media:gallery-01');
    expect(ids).toContain('destination-needs-copy:naranjos');
    expect(ids).not.toContain('destination-needs-copy:chiclayo');
  });

  it('es idempotente: reejecutarla no duplica ni cambia identidades de bloque', async () => {
    const before = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'chiclayo' });
    const input = await loadMigrationInput(db, catalog);
    await applyMigrationPlan(db, buildMigrationPlan(input));
    const after = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'chiclayo' });

    expect(await db.collection(editorialCollections.destinations).countDocuments()).toBe(32);
    expect(after?.blocks.map((b) => b.id)).toEqual(before?.blocks.map((b) => b.id));
    expect(after?.createdAt).toEqual(before?.createdAt);
  });
});

describe('validación del grafo migrado', () => {
  it('los destinos con guía solo fallan por localidad aún no publicada', async () => {
    const report = await validateEditorialGraph(db);
    const byId = new Map(report.destinations.map((d) => [d.id, d]));
    for (const id of ['chiclayo', 'trujillo', 'lima']) {
      const errors = byId.get(id)?.errors ?? [];
      expect(errors.length, `errores en ${id}`).toBeGreaterThan(0);
      expect(
        errors.every((e) => e.startsWith('locality-unpublished')),
        `errores inesperados en ${id}: ${errors.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('la URL canónica de Moyobamba es plana y conserva el redirect jerárquico', async () => {
    const report = await validateEditorialGraph(db);
    const moyobamba = report.destinations.find((d) => d.id === 'moyobamba');
    expect(moyobamba?.canonicalUrl).toBe('/destinos/moyobamba');

    const doc = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'moyobamba' });
    expect(doc?.redirectsFrom).toContain('/destinos/tarapoto/moyobamba');
  });

  it('los short agrupados conservan la URL de dos niveles', async () => {
    const report = await validateEditorialGraph(db);
    const naranjos = report.destinations.find((d) => d.id === 'naranjos');
    expect(naranjos?.canonicalUrl).toBe('/destinos/tarapoto/naranjos');
  });

  it('avisa de la galería con derechos sin verificar sin bloquear la página', async () => {
    const report = await validateEditorialGraph(db);
    const chiclayo = report.destinations.find((d) => d.id === 'chiclayo');
    expect(chiclayo?.warnings.some((w) => w.startsWith('media-rights-unverified'))).toBe(true);
    // La localidad aún no publicada es el único error estructural esperado aquí.
    expect(
      (chiclayo?.errors ?? []).filter((e) => !e.startsWith('locality-unpublished')),
    ).toEqual([]);
  });

  it('ningún punto de embarque es publicable todavía (P-04/P-13)', async () => {
    const report = await validateEditorialGraph(db);
    expect(report.boardingPoints.every((p) => p.errors.length > 0)).toBe(true);
  });
});

describe('publicación del modelo editorial', () => {
  it('no publica un destino cuya localidad sigue en review', async () => {
    await expect(
      setEditorialStatus(db, 'destinations', 'trujillo', 'published'),
    ).rejects.toThrow(/locality-unpublished|no se puede publicar/);
  });

  it('publica una localidad y un destino con guía', async () => {
    await setEditorialStatus(db, 'localities', 'chiclayo', 'published');
    const { result } = await setEditorialStatus(db, 'destinations', 'chiclayo', 'published');
    expect(result.current).toBe('published');

    const doc = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'chiclayo' });
    expect(doc?.status).toBe('published');
  });

  it('no publica un punto de embarque con dirección sin verificar', async () => {
    await expect(
      setEditorialStatus(db, 'boarding-points', 'plaza-norte', 'published'),
    ).rejects.toThrow(EditorialWriteError);
  });

  it('no publica un destino con un bloque inválido', async () => {
    await setEditorialStatus(db, 'localities', 'trujillo', 'published');
    const doc = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'trujillo' });
    const { _id, status, revision, createdAt, updatedAt, ...content } = doc as DestinationDoc & {
      _id: unknown;
    };
    void _id;
    void status;
    void revision;
    void createdAt;
    void updatedAt;

    const broken = {
      ...content,
      blocks: [
        ...content.blocks,
        {
          id: 'trujillo:desconocido:99',
          type: 'video',
          order: 999,
          status: 'review',
          enabled: true,
          responsive: { desktop: true, tablet: true, mobile: true },
          config: {},
          content: { 'es-PE': { src: 'https://example.test/v.mp4' } },
        },
      ],
    };

    await expect(
      setEditorialRecords(db, 'destinations', [broken], { publish: true }),
    ).rejects.toThrow(/validación completa/);

    const stored = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'trujillo' });
    expect(stored?.status).not.toBe('published');
    expect(stored?.blocks.some((b) => b.type === 'video')).toBe(false);
  });

  it('re-migración no pisa un destino publicado ni reabre la cola resuelta', async () => {
    await db
      .collection(editorialCollections.destinations)
      .updateOne({ id: 'chiclayo' }, { $set: { name: 'Chiclayo editado' } });
    await db
      .collection(editorialCollections.reviewQueue)
      .updateOne(
        { id: 'unclassified-service:economico' },
        { $set: { state: 'resolved', updatedAt: new Date() } },
      );

    const openBefore = (await new EditorialRepo(db).listReviewQueue('open')).length;
    await applyMigrationPlan(db, buildMigrationPlan(await loadMigrationInput(db, catalog)));

    const doc = await db
      .collection<DestinationDoc>(editorialCollections.destinations)
      .findOne({ id: 'chiclayo' });
    expect(doc?.name).toBe('Chiclayo editado');
    expect(doc?.status).toBe('published');

    const resolved = await db
      .collection<{ state: string }>(editorialCollections.reviewQueue)
      .findOne({ id: 'unclassified-service:economico' });
    expect(resolved?.state).toBe('resolved');
    expect((await new EditorialRepo(db).listReviewQueue('open')).length).toBe(openBefore);
  });

  it('el validador de MongoDB impide un punto de embarque con isDestination true', async () => {
    await expect(
      db.collection(editorialCollections.boardingPoints).insertOne({
        id: 'punto-falso',
        name: 'Punto falso',
        slug: 'punto-falso',
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
});
