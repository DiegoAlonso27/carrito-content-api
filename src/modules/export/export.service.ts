import type { Db } from 'mongodb';
import { contentCollections } from '../content/content.collections.js';
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
import type {
  AssetDoc,
  CacheVersionToken,
  CollectionDoc,
  ContentCache,
  ContentMetaDoc,
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

export interface ExportSnapshot {
  /** JSON serializado del export (el contrato es estructura + orden). */
  body: string;
  etag: string;
  contentVersion: number;
  generatedAtUtc: string;
}

/**
 * Construye el export compatible con content-cache.json desde MongoDB.
 *
 * - Solo documentos `published` (el export ES el contenido publicado;
 *   `isActive` es un dato del contrato que el front filtra en runtime).
 * - Cachea en memoria por contentVersion (≈130 KB): `generatedAtUtc` queda
 *   estable entre cambios y el ETag es coherente para GET condicional.
 * - Serializa a mano (JSON.stringify del objeto construido por los mappers):
 *   aquí NO se usa la serialización por response schema porque el contrato
 *   exige control byte-a-byte del orden de claves; los mappers son la única
 *   fuente del objeto, por lo que no puede filtrarse `_id` ni campos internos.
 */
export class ExportService {
  private cached: ExportSnapshot | null = null;

  constructor(private readonly db: Db) {}

  async get(): Promise<ExportSnapshot> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    const contentVersion = meta?.contentVersion ?? 0;

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
    const published = { status: 'published' as const };
    const find = <T extends object>(name: string): Promise<T[]> =>
      this.db.collection(name).find(published).toArray() as Promise<T[]>;

    const [locales, settings, pages, texts, assets, collections, items] = await Promise.all([
      find<LocaleDoc>(c.locales),
      find<SettingDoc>(c.settings),
      find<PageDoc>(c.pages),
      find<TextDoc>(c.texts),
      find<AssetDoc>(c.assets),
      find<CollectionDoc>(c.collections),
      find<ItemDoc>(c.items),
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

    // Orden de claves top-level = contrato (ver golden file).
    return {
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
  }
}
