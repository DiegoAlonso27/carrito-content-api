import type { Db, Document } from 'mongodb';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import sanitizeHtml from 'sanitize-html';
import { contentCacheSchema, htmlDataFields, itemDataSchemas } from './content.schemas.js';
import { contentCollections } from './content.collections.js';
import { ContentRepo } from './content.repo.js';
import {
  assetToCache,
  collectionToCache,
  formatToken,
  itemToCache,
  localeToCache,
  pageToCache,
  parseToken,
  settingToCache,
  sourceKeyOf,
  textToCache,
} from './content.mappers.js';
import type {
  AssetDoc,
  CacheItem,
  CollectionDoc,
  ContentCache,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  SourceTable,
  TextDoc,
} from './content.types.js';

// ── Validación del archivo fuente ───────────────────────────────────────────

const cacheChecker = TypeCompiler.Compile(contentCacheSchema);
const dataCheckers = new Map(
  Object.entries(itemDataSchemas).map(([slug, schema]) => [slug, TypeCompiler.Compile(schema)]),
);

/** Valida la forma completa del cache (sobre + `data` por colección). */
export function validateCache(raw: unknown): { cache: ContentCache | null; errors: string[] } {
  const errors: string[] = [];
  for (const issue of cacheChecker.Errors(raw)) {
    errors.push(`${issue.path}: ${issue.message}`);
    if (errors.length >= 20) break;
  }
  if (errors.length > 0) return { cache: null, errors };

  const cache = raw as ContentCache;
  for (const item of cache.items) {
    const checker = dataCheckers.get(item.collectionSlug);
    const id = `items/${item.collectionSlug}/${item.localeCode}/${item.slug}`;
    if (!checker) {
      errors.push(`${id}: colección sin esquema de data registrado`);
      continue;
    }
    for (const issue of checker.Errors(item.data)) {
      errors.push(`${id}: data${issue.path} ${issue.message}`);
    }
  }
  return errors.length > 0 ? { cache: null, errors } : { cache, errors: [] };
}

function pushUnique(errors: string[], message: string, limit = 40): void {
  if (errors.length < limit) errors.push(message);
}

function findDuplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return [...dupes];
}

function assetSlugsInValue(value: unknown): string[] {
  const slugs: string[] = [];
  const walk = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const entry of obj) walk(entry);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if ((k === 'imageAsset' || k === 'iconAsset') && typeof v === 'string' && v.length > 0) {
        slugs.push(v);
      } else {
        walk(v);
      }
    }
  };
  walk(value);
  return slugs;
}

/**
 * Validación semántica del cache (unicidad, tokens, relaciones).
 * Complementa `validateCache` (forma TypeBox + data por colección).
 */
export function validateCacheSemantics(cache: ContentCache): string[] {
  const errors: string[] = [];

  for (const code of findDuplicateKeys(cache.locales.map((l) => l.code))) {
    pushUnique(errors, `locales: code duplicado '${code}'`);
  }
  for (const key of findDuplicateKeys(cache.settings.map((s) => s.key))) {
    pushUnique(errors, `settings: key duplicado '${key}'`);
  }
  for (const key of findDuplicateKeys(cache.pages.map((p) => sourceKeyOf.Page(p)))) {
    pushUnique(errors, `pages: clave duplicada '${key}'`);
  }
  for (const key of findDuplicateKeys(cache.texts.map((t) => sourceKeyOf.ContentText(t)))) {
    pushUnique(errors, `texts: clave duplicada '${key}'`);
  }
  for (const slug of findDuplicateKeys(cache.assets.map((a) => a.slug))) {
    pushUnique(errors, `assets: slug duplicado '${slug}'`);
  }
  for (const slug of findDuplicateKeys(cache.collections.map((c) => c.slug))) {
    pushUnique(errors, `collections: slug duplicado '${slug}'`);
  }
  for (const key of findDuplicateKeys(cache.items.map((i) => sourceKeyOf.ContentItem(i)))) {
    pushUnique(errors, `items: clave duplicada '${key}'`);
  }

  const defaults = cache.locales.filter((l) => l.isDefault);
  if (defaults.length !== 1) {
    pushUnique(
      errors,
      `locales: se espera exactamente 1 isDefault:true (hay ${String(defaults.length)})`,
    );
  }

  const localeCodes = new Set(cache.locales.map((l) => l.code));
  const collectionSlugs = new Set(cache.collections.map((c) => c.slug));
  const assetSlugs = new Set(cache.assets.map((a) => a.slug));

  for (const page of cache.pages) {
    if (!localeCodes.has(page.localeCode)) {
      pushUnique(
        errors,
        `pages/${sourceKeyOf.Page(page)}: locale '${page.localeCode}' inexistente`,
      );
    }
    if (page.ogImageSlug !== null && !assetSlugs.has(page.ogImageSlug)) {
      pushUnique(
        errors,
        `pages/${sourceKeyOf.Page(page)}: ogImageSlug '${page.ogImageSlug}' inexistente`,
      );
    }
  }

  for (const text of cache.texts) {
    if (!localeCodes.has(text.localeCode)) {
      pushUnique(
        errors,
        `texts/${sourceKeyOf.ContentText(text)}: locale '${text.localeCode}' inexistente`,
      );
    }
  }

  for (const item of cache.items) {
    const id = sourceKeyOf.ContentItem(item);
    if (!collectionSlugs.has(item.collectionSlug)) {
      pushUnique(errors, `items/${id}: collectionSlug '${item.collectionSlug}' inexistente`);
    }
    if (!localeCodes.has(item.localeCode)) {
      pushUnique(errors, `items/${id}: locale '${item.localeCode}' inexistente`);
    }
    for (const assetSlug of assetSlugsInValue(item.data)) {
      if (!assetSlugs.has(assetSlug)) {
        pushUnique(errors, `items/${id}: asset '${assetSlug}' inexistente`);
      }
    }
  }

  // Correspondencia completa versionTokens ↔ registros.
  type Expected = { table: SourceTable; key: string; token?: string };
  const expected: Expected[] = [
    ...cache.locales.map((r) => ({ table: 'Locale' as const, key: sourceKeyOf.Locale(r) })),
    ...cache.settings.map((r) => ({ table: 'Setting' as const, key: sourceKeyOf.Setting(r) })),
    ...cache.pages.map((r) => ({ table: 'Page' as const, key: sourceKeyOf.Page(r) })),
    ...cache.texts.map((r) => ({ table: 'ContentText' as const, key: sourceKeyOf.ContentText(r) })),
    ...cache.assets.map((r) => ({ table: 'Asset' as const, key: sourceKeyOf.Asset(r) })),
    ...cache.collections.map((r) => ({
      table: 'ContentCollection' as const,
      key: sourceKeyOf.ContentCollection(r),
    })),
    ...cache.items.map((r) => ({
      table: 'ContentItem' as const,
      key: sourceKeyOf.ContentItem(r),
      token: r.rowVersionToken,
    })),
  ];

  const tokenByRef = new Map<string, string>();
  for (const t of cache.versionTokens) {
    const ref = `${t.sourceTable}:${t.sourceKey}`;
    if (tokenByRef.has(ref)) {
      pushUnique(errors, `versionTokens: entrada duplicada ${ref}`);
    }
    tokenByRef.set(ref, t.rowVersionToken);
  }

  if (cache.versionTokens.length !== expected.length) {
    pushUnique(
      errors,
      `versionTokens: ${String(cache.versionTokens.length)} entradas vs ${String(expected.length)} registros`,
    );
  }

  for (const exp of expected) {
    const ref = `${exp.table}:${exp.key}`;
    const token = tokenByRef.get(ref);
    if (token === undefined) {
      pushUnique(errors, `versionTokens: falta ${ref}`);
      continue;
    }
    if (exp.token !== undefined && exp.token !== token) {
      pushUnique(errors, `items/${exp.key}: rowVersionToken ${exp.token} ≠ versionTokens ${token}`);
    }
    tokenByRef.delete(ref);
  }
  for (const orphan of tokenByRef.keys()) {
    pushUnique(errors, `versionTokens: huérfano ${orphan}`);
  }

  return errors;
}

/**
 * Preflight completo del archivo fuente (forma + semántica + sanitización).
 * Lo usan `--dry-run` y la importación real: mismo camino de validación.
 */
export function preflightCache(raw: unknown): {
  cache: ContentCache | null;
  errors: string[];
  sanitizationChanges: SanitizationChange[];
} {
  const shape = validateCache(raw);
  if (shape.cache === null) {
    return { cache: null, errors: shape.errors, sanitizationChanges: [] };
  }
  const semanticErrors = validateCacheSemantics(shape.cache);
  if (semanticErrors.length > 0) {
    return { cache: null, errors: semanticErrors, sanitizationChanges: [] };
  }
  return {
    cache: shape.cache,
    errors: [],
    sanitizationChanges: checkHtmlSanitization(shape.cache),
  };
}

// ── Sanitización de HTML embebido ───────────────────────────────────────────

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h3', 'h4'],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
};

export function sanitizeContentHtml(html: string): string {
  return sanitizeHtml(html, sanitizeOptions);
}

export interface SanitizationChange {
  itemKey: string;
  field: string;
  original: string;
  sanitized: string;
}

export function checkHtmlSanitization(cache: ContentCache): SanitizationChange[] {
  const changes: SanitizationChange[] = [];
  for (const item of cache.items) {
    for (const field of htmlDataFields[item.collectionSlug] ?? []) {
      const original = item.data[field];
      if (typeof original !== 'string') continue;
      const sanitized = sanitizeContentHtml(original);
      if (sanitized !== original) {
        changes.push({
          itemKey: `${item.collectionSlug}/${item.localeCode}/${item.slug}`,
          field,
          original,
          sanitized,
        });
      }
    }
  }
  return changes;
}

// ── Tokens de versión del archivo fuente ────────────────────────────────────

class TokenMap {
  private readonly map = new Map<string, number>();

  constructor(cache: ContentCache) {
    for (const t of cache.versionTokens) {
      this.map.set(`${t.sourceTable}:${t.sourceKey}`, parseToken(t.rowVersionToken));
    }
  }

  revisionOf(table: SourceTable, key: string): number {
    const revision = this.map.get(`${table}:${key}`);
    if (revision === undefined) {
      throw new Error(`versionTokens no contiene ${table}:${key} — archivo fuente inconsistente`);
    }
    return revision;
  }

  get maxRevision(): number {
    return Math.max(0, ...this.map.values());
  }
}

// ── Importación idempotente ─────────────────────────────────────────────────

export interface SectionSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
}

export type ImportSummary = Record<
  'locales' | 'settings' | 'pages' | 'texts' | 'assets' | 'collections' | 'items',
  SectionSummary
>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

type Bare<T> = Omit<T, 'createdAt' | 'updatedAt'>;

export async function importCache(db: Db, cache: ContentCache): Promise<ImportSummary> {
  const semanticErrors = validateCacheSemantics(cache);
  if (semanticErrors.length > 0) {
    throw new Error(
      `cache semánticamente inválido:\n${semanticErrors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  const repo = new ContentRepo(db);
  await repo.ensureSetup();
  const tokens = new TokenMap(cache);
  const now = new Date();
  const published = { status: 'published' as const };

  const locales: Bare<LocaleDoc>[] = cache.locales.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Locale', sourceKeyOf.Locale(r)),
  }));
  const settings: Bare<SettingDoc>[] = cache.settings.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Setting', sourceKeyOf.Setting(r)),
  }));
  const pages: Bare<PageDoc>[] = cache.pages.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Page', sourceKeyOf.Page(r)),
  }));
  const texts: Bare<TextDoc>[] = cache.texts.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('ContentText', sourceKeyOf.ContentText(r)),
  }));
  const assets: Bare<AssetDoc>[] = cache.assets.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Asset', sourceKeyOf.Asset(r)),
  }));
  const collections: Bare<CollectionDoc>[] = cache.collections.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('ContentCollection', sourceKeyOf.ContentCollection(r)),
  }));
  const items: Bare<ItemDoc>[] = cache.items.map(({ rowVersionToken, ...r }) => {
    void rowVersionToken;
    return {
      ...r,
      ...published,
      revision: tokens.revisionOf('ContentItem', sourceKeyOf.ContentItem(r)),
    };
  });

  const c = contentCollections;
  const summary: ImportSummary = {
    locales: await repo.upsertImportSection(
      c.locales,
      locales,
      (r) => ({ code: r.code }),
      now,
      deepEqual,
    ),
    settings: await repo.upsertImportSection(
      c.settings,
      settings,
      (r) => ({ key: r.key }),
      now,
      deepEqual,
    ),
    pages: await repo.upsertImportSection(
      c.pages,
      pages,
      (r) => ({ localeCode: r.localeCode, slug: r.slug }),
      now,
      deepEqual,
    ),
    texts: await repo.upsertImportSection(
      c.texts,
      texts,
      (r) => ({ localeCode: r.localeCode, key: r.key }),
      now,
      deepEqual,
    ),
    assets: await repo.upsertImportSection(
      c.assets,
      assets,
      (r) => ({ slug: r.slug }),
      now,
      deepEqual,
    ),
    collections: await repo.upsertImportSection(
      c.collections,
      collections,
      (r) => ({ slug: r.slug }),
      now,
      deepEqual,
    ),
    items: await repo.upsertImportSection(
      c.items,
      items,
      (r) => ({ collectionSlug: r.collectionSlug, localeCode: r.localeCode, slug: r.slug }),
      now,
      deepEqual,
    ),
  };

  await repo.seedImportMeta(tokens.maxRevision);
  return summary;
}

// ── Verificación contra el archivo fuente ───────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  diffs: string[];
}

export async function verifyCache(db: Db, cache: ContentCache): Promise<VerifyResult> {
  const repo = new ContentRepo(db);
  const diffs: string[] = [];
  const c = contentCollections;

  async function compareSection<TDoc extends Document, TCache>(
    name: string,
    collection: string,
    sourceRecords: TCache[],
    toCache: (d: TDoc) => TCache,
    keyOf: (r: TCache) => string,
  ): Promise<void> {
    const docs = await repo.findAll<TDoc>(collection);
    const fromDb = new Map(
      docs.map((d) => {
        const mapped = toCache(d);
        return [keyOf(mapped), mapped] as const;
      }),
    );
    if (fromDb.size !== sourceRecords.length) {
      diffs.push(`${name}: ${fromDb.size} documentos vs ${sourceRecords.length} en el archivo`);
    }
    for (const source of sourceRecords) {
      const stored = fromDb.get(keyOf(source));
      if (stored === undefined) {
        diffs.push(`${name}/${keyOf(source)}: ausente en MongoDB`);
      } else if (!deepEqual(stored, source)) {
        diffs.push(`${name}/${keyOf(source)}: contenido distinto`);
      }
      if (diffs.length >= 20) return;
    }
  }

  await compareSection(c.locales, c.locales, cache.locales, localeToCache, (r) => r.code);
  await compareSection(c.settings, c.settings, cache.settings, settingToCache, (r) => r.key);
  await compareSection(c.pages, c.pages, cache.pages, pageToCache, sourceKeyOf.Page);
  await compareSection(c.texts, c.texts, cache.texts, textToCache, sourceKeyOf.ContentText);
  await compareSection(c.assets, c.assets, cache.assets, assetToCache, (r) => r.slug);
  await compareSection(
    'content_collections',
    c.collections,
    cache.collections,
    collectionToCache,
    (r) => r.slug,
  );
  await compareSection<ItemDoc, CacheItem>(
    'content_items',
    c.items,
    cache.items,
    itemToCache,
    sourceKeyOf.ContentItem,
  );

  const meta = await repo.getMeta();
  if (meta === null) {
    diffs.push('meta/content: ausente');
  } else {
    const expectedSeq = new TokenMap(cache).maxRevision + 1;
    if (meta.tokenSeq < expectedSeq) {
      diffs.push(
        `meta/content: tokenSeq ${String(meta.tokenSeq)} < esperado ${String(expectedSeq)} (${formatToken(expectedSeq)})`,
      );
    }
  }

  return { ok: diffs.length === 0, diffs };
}
