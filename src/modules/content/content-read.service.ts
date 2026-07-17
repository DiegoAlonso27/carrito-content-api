import type { Db } from 'mongodb';
import { contentCollections } from './content.collections.js';
import {
  assetToCache,
  collectionToCache,
  localeToCache,
  pageToCache,
  settingToCache,
  textToCache,
} from './content.mappers.js';
import {
  compareAssets,
  compareCollections,
  compareItems,
  compareLocales,
  comparePages,
  compareSettings,
  compareTexts,
} from './content.ordering.js';
import type {
  AssetDoc,
  CacheAsset,
  CacheCollection,
  CacheItem,
  CacheLocale,
  CachePage,
  CacheSetting,
  CacheText,
  CollectionDoc,
  ContentMetaDoc,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  TextDoc,
} from './content.types.js';

/** Item del bundle runtime: misma forma del contrato sin rowVersionToken (artefacto build-time). */
export type BundleItem = Omit<CacheItem, 'rowVersionToken'>;

export interface ContentBundle {
  locale: string;
  contentVersion: number;
  settings: CacheSetting[];
  assets: CacheAsset[];
  collections: CacheCollection[];
  pages: CachePage[];
  texts: CacheText[];
  items: BundleItem[];
}

interface CachedBundle {
  contentVersion: number;
  bundle: ContentBundle;
}

/**
 * Lectura pública runtime (consumo desde el navegador).
 *
 * - Solo documentos `published`; `isActive` viaja en el DTO y lo filtra el
 *   front (misma semántica que el content-cache.json de build).
 * - Fallback de idioma: el bundle de un locale ≠ default une sus documentos
 *   publicados con los del default cuya clave natural no exista en el locale
 *   pedido; `localeCode` conserva el origen real para que el front sepa qué
 *   vino por fallback.
 * - Un locale es atendible si está published + isActive; si no → null (404).
 * - Caché en memoria por contentVersion y locale (volumen ~130 KB).
 */
export class ContentReadService {
  private readonly bundles = new Map<string, CachedBundle>();
  private localesCache: { contentVersion: number; locales: CacheLocale[] } | null = null;

  constructor(private readonly db: Db) {}

  private async contentVersion(): Promise<number> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    return meta?.contentVersion ?? 0;
  }

  /** Locales publicados y activos, en el orden del contrato. */
  async getLocales(): Promise<{ contentVersion: number; locales: CacheLocale[] }> {
    const contentVersion = await this.contentVersion();
    if (this.localesCache?.contentVersion === contentVersion) return this.localesCache;

    const docs = (await this.db
      .collection(contentCollections.locales)
      .find({ status: 'published', isActive: true })
      .toArray()) as unknown as LocaleDoc[];
    docs.sort(compareLocales);

    this.localesCache = { contentVersion, locales: docs.map(localeToCache) };
    return this.localesCache;
  }

  /** Bundle completo publicado para un locale; null si el locale no es atendible. */
  async getBundle(locale: string): Promise<ContentBundle | null> {
    const contentVersion = await this.contentVersion();
    const cached = this.bundles.get(locale);
    if (cached?.contentVersion === contentVersion) return cached.bundle;

    const { locales } = await this.getLocales();
    const requested = locales.find((l) => l.code === locale);
    if (requested === undefined) return null;
    const defaultLocale = locales.find((l) => l.isDefault)?.code;

    const published = { status: 'published' as const };
    const localeFilter =
      defaultLocale !== undefined && defaultLocale !== locale
        ? { ...published, localeCode: { $in: [locale, defaultLocale] } }
        : { ...published, localeCode: locale };

    const find = <T extends object>(name: string, filter: object): Promise<T[]> =>
      this.db.collection(name).find(filter).toArray() as Promise<T[]>;
    const c = contentCollections;

    const [settings, assets, collections, pages, texts, items] = await Promise.all([
      find<SettingDoc>(c.settings, published),
      find<AssetDoc>(c.assets, published),
      find<CollectionDoc>(c.collections, published),
      find<PageDoc>(c.pages, localeFilter),
      find<TextDoc>(c.texts, localeFilter),
      find<ItemDoc>(c.items, localeFilter),
    ]);

    const mergedPages = mergeByKey(pages, locale, (p) => p.slug);
    const mergedTexts = mergeByKey(texts, locale, (t) => t.key);
    const mergedItems = mergeByKey(items, locale, (i) => `${i.collectionSlug}/${i.slug}`);

    settings.sort(compareSettings);
    assets.sort(compareAssets);
    collections.sort(compareCollections);
    mergedPages.sort(comparePages);
    mergedTexts.sort(compareTexts);
    mergedItems.sort(compareItems);

    const bundle: ContentBundle = {
      locale,
      contentVersion,
      settings: settings.map(settingToCache),
      assets: assets.map(assetToCache),
      collections: collections.map(collectionToCache),
      pages: mergedPages.map(pageToCache),
      texts: mergedTexts.map(textToCache),
      items: mergedItems.map(itemToBundle),
    };
    this.bundles.set(locale, { contentVersion, bundle });
    return bundle;
  }

  /**
   * Items publicados de una colección para un locale (con fallback).
   * null si el locale no es atendible o la colección no existe publicada.
   */
  async getCollectionItems(locale: string, collectionSlug: string): Promise<BundleItem[] | null> {
    const bundle = await this.getBundle(locale);
    if (bundle === null) return null;
    if (!bundle.collections.some((col) => col.slug === collectionSlug)) return null;
    return bundle.items.filter((i) => i.collectionSlug === collectionSlug);
  }
}

/** Prefiere el documento del locale pedido; completa con el default por clave natural. */
function mergeByKey<T extends { localeCode: string }>(
  docs: T[],
  requestedLocale: string,
  keyOf: (d: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const doc of docs) {
    if (doc.localeCode === requestedLocale) merged.set(keyOf(doc), doc);
  }
  for (const doc of docs) {
    if (doc.localeCode !== requestedLocale && !merged.has(keyOf(doc))) {
      merged.set(keyOf(doc), doc);
    }
  }
  return [...merged.values()];
}

function itemToBundle(d: ItemDoc): BundleItem {
  return {
    collectionSlug: d.collectionSlug,
    localeCode: d.localeCode,
    slug: d.slug,
    sortOrder: d.sortOrder,
    isActive: d.isActive,
    data: d.data,
  };
}
