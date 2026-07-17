import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import {
  ContentWriteError,
  setRecords,
  setStatus,
  statusSummary,
} from '../../src/modules/content/content-write.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import { ExportService } from '../../src/modules/export/export.service.js';
import type { ContentCache, ContentMetaDoc } from '../../src/modules/content/content.types.js';

const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));

/** Mutaciones editoriales exigen replica set (ADR-001). */
let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let golden: ContentCache;

/** Export fresco (instancia nueva: sin caché en memoria entre asserts). */
const exportNow = async (): Promise<ContentCache> =>
  JSON.parse((await new ExportService(db).get()).body) as ContentCache;

beforeAll(async () => {
  golden = validateCache(JSON.parse(await readFile(goldenPath, 'utf8'))).cache as ContentCache;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(replSet.getUri());
  await client.connect();
  db = client.db('carrito_content_write_test');
  await importCache(db, golden);
}, 120_000);

afterAll(async () => {
  await client.close();
  await replSet.stop();
});

describe('ciclo editorial completo (crear → draft → publicar → export)', () => {
  const newFaq = {
    collectionSlug: 'faqs',
    localeCode: 'es-PE',
    slug: 'faq-nueva-editorial',
    sortOrder: 900,
    isActive: true,
    data: { question: '¿Pregunta nueva?', answerHtml: '<p>Respuesta nueva.</p>' },
  };

  it('un registro nuevo nace draft y NO aparece en el export', async () => {
    const { results, contentVersion } = await setRecords(db, 'items', [newFaq]);

    expect(results[0]).toMatchObject({ action: 'created', status: 'draft' });
    expect(results[0]?.token).toMatch(/^0x[0-9A-F]{16}$/);
    expect(contentVersion).not.toBeNull();

    const exported = await exportNow();
    expect(exported.items.some((i) => i.slug === 'faq-nueva-editorial')).toBe(false);
    expect(exported.items).toHaveLength(83);
  });

  it('al publicarlo aparece en el export con token nuevo, y versionTokens lo incluye', async () => {
    const { result, contentVersion } = await setStatus(
      db,
      'items',
      'faqs/es-PE/faq-nueva-editorial',
      'published',
    );
    expect(result.previous).toBe('draft');
    expect(result.current).toBe('published');
    expect(contentVersion).not.toBeNull();

    const exported = await exportNow();
    const item = exported.items.find((i) => i.slug === 'faq-nueva-editorial');
    expect(item).toBeDefined();
    expect(item?.rowVersionToken).toBe(result.token);
    expect(
      exported.versionTokens.some((t) => t.sourceKey === 'faqs/es-PE/faq-nueva-editorial'),
    ).toBe(true);
    expect(exported.items).toHaveLength(84);
  });

  it('al archivarlo desaparece del export', async () => {
    await setStatus(db, 'items', 'faqs/es-PE/faq-nueva-editorial', 'archived');
    const exported = await exportNow();
    expect(exported.items.some((i) => i.slug === 'faq-nueva-editorial')).toBe(false);
    expect(exported.items).toHaveLength(83);
  });
});

describe('edición de un registro existente', () => {
  it('actualiza el contenido, asigna token nuevo y el export lo refleja', async () => {
    const source = golden.texts.find((t) => t.key === 'complaints.heading.preTitle');
    expect(source).toBeDefined();
    const edited = { ...source, value: 'Libro de (editado)' };

    const beforeExport = await exportNow();
    const beforeToken = beforeExport.versionTokens.find(
      (t) => t.sourceTable === 'ContentText' && t.sourceKey === 'es-PE/complaints.heading.preTitle',
    )?.rowVersionToken;

    const { results } = await setRecords(db, 'texts', [edited]);
    expect(results[0]?.action).toBe('updated');

    const exported = await exportNow();
    const text = exported.texts.find((t) => t.key === 'complaints.heading.preTitle');
    expect(text?.value).toBe('Libro de (editado)');

    const token = exported.versionTokens.find(
      (t) => t.sourceTable === 'ContentText' && t.sourceKey === 'es-PE/complaints.heading.preTitle',
    );
    expect(token?.rowVersionToken).toBe(results[0]?.token);
    expect(token?.rowVersionToken).not.toBe(beforeToken);
  });

  it('re-aplicar el mismo contenido no cambia nada (sin token ni contentVersion)', async () => {
    const source = golden.texts.find((t) => t.key === 'complaints.heading.preTitle');
    const edited = { ...source, value: 'Libro de (editado)' };

    const first = await setRecords(db, 'texts', [edited]);
    expect(first.results[0]?.action).toBe('unchanged');
    expect(first.contentVersion).toBeNull();
  });
});

describe('validación y seguridad de escritura', () => {
  it('rechaza un lote con datos inválidos sin escribir nada (todo-o-nada)', async () => {
    const before = await db.collection(contentCollections.texts).countDocuments();
    const valid = {
      localeCode: 'es-PE',
      key: 'test.valido',
      value: 'ok',
      isActive: true,
      sortOrder: 1,
    };
    const invalid = {
      localeCode: 'es-PE',
      key: 'test.invalido',
      value: 123,
      isActive: true,
      sortOrder: 1,
    };

    await expect(setRecords(db, 'texts', [valid, invalid])).rejects.toThrow(ContentWriteError);
    expect(await db.collection(contentCollections.texts).countDocuments()).toBe(before);
  });

  it('rechaza referencia inválida en segunda posición sin escribir la primera', async () => {
    const before = await db.collection(contentCollections.texts).countDocuments();
    const valid = {
      localeCode: 'es-PE',
      key: 'batch.preflight.a',
      value: 'a',
      isActive: true,
      sortOrder: 1,
    };
    const invalid = {
      localeCode: 'de',
      key: 'batch.preflight.b',
      value: 'b',
      isActive: true,
      sortOrder: 1,
    };

    await expect(setRecords(db, 'texts', [valid, invalid])).rejects.toThrow(ContentWriteError);
    expect(await db.collection(contentCollections.texts).countDocuments()).toBe(before);
    expect(
      await db.collection(contentCollections.texts).findOne({ key: 'batch.preflight.a' }),
    ).toBeNull();
  });

  it('incrementa contentVersion junto con la escritura', async () => {
    const metaBefore = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    const versionBefore = metaBefore?.contentVersion ?? 0;

    const { contentVersion } = await setRecords(db, 'texts', [
      {
        localeCode: 'es-PE',
        key: 'atomic.version.test',
        value: 'x',
        isActive: true,
        sortOrder: 998,
      },
    ]);

    const doc = await db
      .collection(contentCollections.texts)
      .findOne({ key: 'atomic.version.test' });
    const metaAfter = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });

    expect(doc).not.toBeNull();
    expect(contentVersion).toBe(versionBefore + 1);
    expect(metaAfter?.contentVersion).toBe(versionBefore + 1);
  });

  it('rechaza claves naturales duplicadas en el mismo lote sin escribir', async () => {
    const before = await db.collection(contentCollections.texts).countDocuments();
    const a = {
      localeCode: 'es-PE',
      key: 'batch.dup.key',
      value: 'uno',
      isActive: true,
      sortOrder: 1,
    };
    const b = { ...a, value: 'dos' };

    await expect(setRecords(db, 'texts', [a, b])).rejects.toThrow(ContentWriteError);
    await expect(setRecords(db, 'texts', [a, b])).rejects.toThrow(/claves naturales duplicadas/);
    expect(await db.collection(contentCollections.texts).countDocuments()).toBe(before);
    expect(
      await db.collection(contentCollections.texts).findOne({ key: 'batch.dup.key' }),
    ).toBeNull();
  });

  it('rechaza publicar un item si su colección no está publicada', async () => {
    await setStatus(db, 'collections', 'faqs', 'archived');

    await expect(
      setRecords(
        db,
        'items',
        [
          {
            collectionSlug: 'faqs',
            localeCode: 'es-PE',
            slug: 'faq-huerfana',
            sortOrder: 902,
            isActive: true,
            data: { question: '¿?', answerHtml: '<p>x</p>' },
          },
        ],
        { publish: true },
      ),
    ).rejects.toThrow(/colección 'faqs' no está publicada/);

    await setStatus(db, 'collections', 'faqs', 'published');
  });

  it('setStatus(published) revalida relaciones (colección archivada)', async () => {
    await setRecords(db, 'items', [
      {
        collectionSlug: 'faqs',
        localeCode: 'es-PE',
        slug: 'faq-para-revalidar',
        sortOrder: 903,
        isActive: true,
        data: { question: '¿Draft?', answerHtml: '<p>x</p>' },
      },
    ]);
    await setStatus(db, 'collections', 'faqs', 'archived');

    await expect(
      setStatus(db, 'items', 'faqs/es-PE/faq-para-revalidar', 'published'),
    ).rejects.toThrow(/colección 'faqs' no está publicada/);

    await setStatus(db, 'collections', 'faqs', 'published');
  });

  it('rechaza item con asset inexistente en data', async () => {
    await expect(
      setRecords(db, 'items', [
        {
          collectionSlug: 'banners',
          localeCode: 'es-PE',
          slug: 'banner-sin-asset',
          sortOrder: 904,
          isActive: true,
          data: { imageAsset: 'asset-que-no-existe' },
        },
      ]),
    ).rejects.toThrow(/asset 'asset-que-no-existe' no existe/);
  });

  it('sanitiza HTML peligroso al escribir y lo reporta', async () => {
    const { results } = await setRecords(db, 'items', [
      {
        collectionSlug: 'faqs',
        localeCode: 'es-PE',
        slug: 'faq-con-script',
        sortOrder: 901,
        isActive: true,
        data: {
          question: '¿XSS?',
          answerHtml: '<p>Hola</p><script>alert(1)</script><p onclick="x()">Chau</p>',
        },
      },
    ]);

    expect(results[0]?.sanitizedFields).toContain('answerHtml');
    const doc = await db.collection(contentCollections.items).findOne({ slug: 'faq-con-script' });
    const stored = (doc?.['data'] as { answerHtml: string }).answerHtml;
    expect(stored).not.toContain('script');
    expect(stored).not.toContain('onclick');
    expect(stored).toContain('<p>Hola</p>');
  });

  it('rechaza un item de una colección inexistente, con el detalle en el error', async () => {
    const attempt = setRecords(db, 'items', [
      {
        collectionSlug: 'coleccion-fantasma',
        localeCode: 'es-PE',
        slug: 'x',
        sortOrder: 1,
        isActive: true,
        data: {},
      },
    ]);
    await expect(attempt).rejects.toThrow(ContentWriteError);
    await attempt.catch((err: unknown) => {
      expect((err as ContentWriteError).details.join('\n')).toContain(
        'no tiene esquema registrado',
      );
    });
  });

  it('rechaza un text de un locale inexistente', async () => {
    await expect(
      setRecords(db, 'texts', [
        { localeCode: 'de', key: 'x', value: 'x', isActive: true, sortOrder: 1 },
      ]),
    ).rejects.toThrow(/el locale 'de' no existe/);
  });

  it('setStatus falla con clave inexistente', async () => {
    await expect(setStatus(db, 'items', 'faqs/es-PE/no-existe', 'published')).rejects.toThrow(
      /no existe/,
    );
  });
});

describe('statusSummary', () => {
  it('reporta conteos por sección y estado + meta global', async () => {
    const summary = await statusSummary(db);

    expect(summary.contentVersion).toBeGreaterThan(1);
    expect(summary.tokenSeq).toBeGreaterThan(0x4678);
    const items = summary.sections.find((s) => s.section === 'items');
    expect(items?.byStatus['published']).toBe(83);
    expect(items?.byStatus['archived']).toBe(1);
    expect(items?.byStatus['draft']).toBeGreaterThanOrEqual(1);
  });
});
