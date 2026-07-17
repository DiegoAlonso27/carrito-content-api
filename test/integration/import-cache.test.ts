import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import {
  checkHtmlSanitization,
  importCache,
  preflightCache,
  validateCache,
  validateCacheSemantics,
  verifyCache,
} from '../../src/modules/content/content-import.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import { formatToken, parseToken } from '../../src/modules/content/content.mappers.js';
import type { ContentCache, ContentMetaDoc } from '../../src/modules/content/content.types.js';

const goldenPath = fileURLToPath(new URL('../../content-cache.json', import.meta.url));

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let cache: ContentCache;

beforeAll(async () => {
  const raw: unknown = JSON.parse(await readFile(goldenPath, 'utf8'));
  const validated = validateCache(raw);
  expect(validated.errors).toEqual([]);
  cache = validated.cache as ContentCache;

  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  db = client.db('carrito_content_test');
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('validación y sanitización del golden file', () => {
  it('el archivo real cumple el contrato completo (sobre + data por colección)', () => {
    // beforeAll ya falló si no; se deja explícito como criterio de aceptación.
    expect(cache.items).toHaveLength(83);
  });

  it('la sanitización del HTML embebido es no-op sobre el contenido actual', () => {
    expect(checkHtmlSanitization(cache)).toEqual([]);
  });

  it('preflightCache acepta el golden (forma + semántica)', () => {
    const result = preflightCache(cache);
    expect(result.errors).toEqual([]);
    expect(result.cache).not.toBeNull();
    expect(result.sanitizationChanges).toEqual([]);
  });

  it('validateCacheSemantics detecta locale inexistente en un text', () => {
    const broken = structuredClone(cache);
    const victim = broken.texts[0];
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    victim.localeCode = 'xx-XX';
    const errors = validateCacheSemantics(broken);
    expect(errors.some((e) => e.includes("locale 'xx-XX' inexistente"))).toBe(true);
  });

  it('validateCacheSemantics detecta versionToken huérfano y falta de correspondencia', () => {
    const broken = structuredClone(cache);
    broken.versionTokens.push({
      sourceTable: 'Setting',
      sourceKey: 'clave-fantasma',
      rowVersionToken: '0x00000000000000FF',
    });
    const errors = validateCacheSemantics(broken);
    expect(errors.some((e) => e.includes('huérfano') || e.includes('entradas vs'))).toBe(true);
  });

  it('validateCacheSemantics detecta collectionSlug inexistente', () => {
    const broken = structuredClone(cache);
    const victim = broken.items.find((i) => i.collectionSlug === 'faqs');
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    victim.collectionSlug = 'coleccion-fantasma';
    // El esquema de data también falla en validateCache; semántica cubre la relación.
    const errors = validateCacheSemantics(broken);
    expect(errors.some((e) => e.includes("collectionSlug 'coleccion-fantasma'"))).toBe(true);
  });

  it('importCache rechaza un cache semánticamente inválido sin escribir', async () => {
    const before = await db.collection(contentCollections.texts).countDocuments();
    const broken = structuredClone(cache);
    const victim = broken.texts[0];
    if (victim !== undefined) victim.localeCode = 'xx-XX';

    await expect(importCache(db, broken)).rejects.toThrow(/semánticamente inválido/);
    expect(await db.collection(contentCollections.texts).countDocuments()).toBe(before);
  });
});

describe('importación', () => {
  it('primera corrida: inserta los conteos exactos del archivo (1/16/13/62/33/17/83)', async () => {
    const summary = await importCache(db, cache);

    expect(summary.locales).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
    expect(summary.settings).toMatchObject({ inserted: 16, updated: 0, unchanged: 0 });
    expect(summary.pages).toMatchObject({ inserted: 13, updated: 0, unchanged: 0 });
    expect(summary.texts).toMatchObject({ inserted: 62, updated: 0, unchanged: 0 });
    expect(summary.assets).toMatchObject({ inserted: 33, updated: 0, unchanged: 0 });
    expect(summary.collections).toMatchObject({ inserted: 17, updated: 0, unchanged: 0 });
    expect(summary.items).toMatchObject({ inserted: 83, updated: 0, unchanged: 0 });
  });

  it('todo registro importado nace published (incluidos los isActive:false)', async () => {
    const items = db.collection(contentCollections.items);
    expect(await items.countDocuments({ status: 'published' })).toBe(83);
    // El golden contiene 11 items inactivos: el export los incluye igualmente.
    expect(await items.countDocuments({ isActive: false })).toBe(11);
  });

  it('meta: contentVersion inicial y tokenSeq = max(token) + 1', async () => {
    const meta = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    const maxToken = Math.max(...cache.versionTokens.map((t) => parseToken(t.rowVersionToken)));

    expect(meta).not.toBeNull();
    expect(meta?.contentVersion).toBe(1);
    expect(meta?.tokenSeq).toBe(maxToken + 1);
  });

  it('revision reproduce el rowVersionToken original de cada item', async () => {
    const source = cache.items.find((i) => i.collectionSlug === 'faqs');
    expect(source).toBeDefined();
    const doc = await db.collection(contentCollections.items).findOne({
      collectionSlug: source?.collectionSlug,
      localeCode: source?.localeCode,
      slug: source?.slug,
    });

    expect(formatToken(doc?.['revision'] as number)).toBe(source?.rowVersionToken);
  });

  it('segunda corrida: idempotente, nada insertado ni actualizado', async () => {
    const summary = await importCache(db, cache);

    for (const section of Object.values(summary)) {
      expect(section.inserted).toBe(0);
      expect(section.updated).toBe(0);
      expect(section.unchanged).toBe(section.total);
    }
  });

  it('los índices únicos existen con los nombres de la convención', async () => {
    const itemIndexes = await db.collection(contentCollections.items).indexes();
    const names = itemIndexes.map((i) => i.name);

    expect(names).toContain('ux_items_col_locale_slug');
    expect(names).toContain('ix_items_col_locale_status_sort');
    expect(itemIndexes.find((i) => i.name === 'ux_items_col_locale_slug')?.unique).toBe(true);

    expect((await db.collection(contentCollections.texts).indexes()).map((i) => i.name)).toContain(
      'ux_texts_locale_key',
    );
  });
});

describe('verificación contra el archivo fuente', () => {
  it('verifyCache pasa tras la importación', async () => {
    const result = await verifyCache(db, cache);
    expect(result.diffs).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('verifyCache detecta un documento alterado', async () => {
    const texts = db.collection(contentCollections.texts);
    const victim = cache.texts[0];
    expect(victim).toBeDefined();
    const filter = { localeCode: victim?.localeCode, key: victim?.key };

    await texts.updateOne(filter, { $set: { value: 'ALTERADO' } });
    const result = await verifyCache(db, cache);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.includes('contenido distinto'))).toBe(true);

    // Restaurar re-importando: la corrida repara el documento alterado.
    const summary = await importCache(db, cache);
    expect(summary.texts.updated).toBe(1);
    expect((await verifyCache(db, cache)).ok).toBe(true);
  });
});
