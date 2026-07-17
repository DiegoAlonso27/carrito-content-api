import type { Db } from 'mongodb';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  assetToCache,
  collectionToCache,
  itemToCache,
  localeToCache,
  pageToCache,
  settingToCache,
  sourceKeyOf,
  textToCache,
  versionToken,
} from '../content/content.mappers.js';
import { contentCacheSchema } from '../content/content.schemas.js';
import { ContentRepo } from '../content/content.repo.js';
import { contentCollections } from '../content/content.collections.js';
import type {
  AssetDoc,
  CacheVersionToken,
  CollectionDoc,
  ContentCache,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  TextDoc,
} from '../content/content.types.js';
import {
  compareAssets,
  compareCollections,
  compareItems,
  compareLocales,
  comparePages,
  compareSettings,
  compareTexts,
  compareVersionTokens,
} from '../content/content.ordering.js';

const cacheChecker = TypeCompiler.Compile(contentCacheSchema);

export interface ExportSnapshot {
  body: string;
  etag: string;
  contentVersion: number;
  generatedAtUtc: string;
}

/**
 * Construye el export compatible con content-cache.json desde MongoDB.
 * Lectura de MongoDB solo vía `ContentRepo`.
 *
 * La forma se valida con `contentCacheSchema` antes de serializar (barrera
 * anti-fuga + contrato). El JSON se serializa a mano para conservar el orden
 * de claves del golden (ADR-002).
 */
export class ExportService {
  private readonly repo: ContentRepo;
  private cached: ExportSnapshot | null = null;

  constructor(db: Db) {
    this.repo = new ContentRepo(db);
  }

  async get(): Promise<ExportSnapshot> {
    const contentVersion = await this.repo.getContentVersion();

    if (this.cached !== null && this.cached.contentVersion === contentVersion) {
      return this.cached;
    }

    const cache = await this.build();
    this.cached = {
      body: JSON.stringify(cache),
      etag: `"content-v${String(contentVersion)}"`,
      contentVersion,
      generatedAtUtc: cache.generatedAtUtc,
    };
    return this.cached;
  }

  private async build(): Promise<ContentCache> {
    const c = contentCollections;

    const [locales, settings, pages, texts, assets, collections, items] = await Promise.all([
      this.repo.findPublished<LocaleDoc>(c.locales),
      this.repo.findPublished<SettingDoc>(c.settings),
      this.repo.findPublished<PageDoc>(c.pages),
      this.repo.findPublished<TextDoc>(c.texts),
      this.repo.findPublished<AssetDoc>(c.assets),
      this.repo.findPublished<CollectionDoc>(c.collections),
      this.repo.findPublished<ItemDoc>(c.items),
    ]);

    locales.sort(compareLocales);
    settings.sort(compareSettings);
    pages.sort(comparePages);
    texts.sort(compareTexts);
    assets.sort(compareAssets);
    collections.sort(compareCollections);
    items.sort(compareItems);

    const versionTokens: CacheVersionToken[] = [
      ...assets.map((d) => versionToken('Asset', sourceKeyOf.Asset(d), d.revision)),
      ...collections.map((d) =>
        versionToken('ContentCollection', sourceKeyOf.ContentCollection(d), d.revision),
      ),
      ...items.map((d) => versionToken('ContentItem', sourceKeyOf.ContentItem(d), d.revision)),
      ...texts.map((d) => versionToken('ContentText', sourceKeyOf.ContentText(d), d.revision)),
      ...locales.map((d) => versionToken('Locale', sourceKeyOf.Locale(d), d.revision)),
      ...pages.map((d) => versionToken('Page', sourceKeyOf.Page(d), d.revision)),
      ...settings.map((d) => versionToken('Setting', sourceKeyOf.Setting(d), d.revision)),
    ];
    versionTokens.sort(compareVersionTokens);

    const cache: ContentCache = {
      generatedAtUtc: new Date().toISOString(),
      locales: locales.map(localeToCache),
      settings: settings.map(settingToCache),
      pages: pages.map(pageToCache),
      texts: texts.map(textToCache),
      assets: assets.map(assetToCache),
      collections: collections.map(collectionToCache),
      items: items.map(itemToCache),
      versionTokens,
    };

    if (!cacheChecker.Check(cache)) {
      const first = cacheChecker.Errors(cache).First();
      throw new Error(
        `export construido no cumple contentCacheSchema: ${first?.path ?? '?'} ${first?.message ?? ''}`,
      );
    }
    return cache;
  }
}
