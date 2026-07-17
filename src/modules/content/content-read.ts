import type { Db } from 'mongodb';
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
import { ContentRepo } from './content.repo.js';
import { contentCollections } from './content.collections.js';
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
  ItemDoc,
  PageDoc,
  SettingDoc,
  TextDoc,
} from './content.types.js';

/** Item del bundle runtime: misma forma del contrato sin rowVersionToken. */
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
 * Caché en memoria por contentVersion y locale. Toda lectura de MongoDB
 * pasa por `ContentRepo` (AGENTS.md: persistencia solo en `*.repo.ts`).
 */
export class ContentReader {
  private readonly repo: ContentRepo;
  private readonly bundles = new Map<string, CachedBundle>();
  private localesCache: { contentVersion: number; locales: CacheLocale[] } | null = null;

  constructor(db: Db) {
    this.repo = new ContentRepo(db);
  }

  async getLocales(): Promise<{ contentVersion: number; locales: CacheLocale[] }> {
    const contentVersion = await this.repo.getContentVersion();
    if (this.localesCache?.contentVersion === contentVersion) return this.localesCache;

    const docs = await this.repo.findPublishedLocales();
    docs.sort(compareLocales);

    this.localesCache = { contentVersion, locales: docs.map(localeToCache) };
    return this.localesCache;
  }

  async getBundle(locale: string): Promise<ContentBundle | null> {
    const contentVersion = await this.repo.getContentVersion();
    const cached = this.bundles.get(locale);
    if (cached?.contentVersion === contentVersion) return cached.bundle;

    const { locales } = await this.getLocales();
    const requested = locales.find((l) => l.code === locale);
    if (requested === undefined) return null;
    const defaultLocale = locales.find((l) => l.isDefault)?.code;

    const localeFilter =
      defaultLocale !== undefined && defaultLocale !== locale
        ? { localeCode: { $in: [locale, defaultLocale] } }
        : { localeCode: locale };

    const c = contentCollections;
    const [settings, assets, collections, pages, texts, items] = await Promise.all([
      this.repo.findPublished<SettingDoc>(c.settings),
      this.repo.findPublished<AssetDoc>(c.assets),
      this.repo.findPublished<CollectionDoc>(c.collections),
      this.repo.findPublished<PageDoc>(c.pages, localeFilter),
      this.repo.findPublished<TextDoc>(c.texts, localeFilter),
      this.repo.findPublished<ItemDoc>(c.items, localeFilter),
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

  async getCollectionItems(locale: string, collectionSlug: string): Promise<BundleItem[] | null> {
    const bundle = await this.getBundle(locale);
    if (bundle === null) return null;
    if (!bundle.collections.some((col) => col.slug === collectionSlug)) return null;
    return bundle.items.filter((i) => i.collectionSlug === collectionSlug);
  }
}

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
