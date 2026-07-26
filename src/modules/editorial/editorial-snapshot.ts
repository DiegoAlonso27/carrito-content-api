import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  SNAPSHOT_SCHEMA_VERSION,
  editorialSnapshotSchema,
} from './editorial-snapshot.schemas.js';
import { isPublishableMedia } from './editorial.blocks.js';
import { canonicalUrlOf, validateDestination } from './editorial.validate.js';
import type { ValidationContext } from './editorial.validate.js';
import { buildValidationContext } from './editorial-write.js';
import { ContentRepo } from '../content/content.repo.js';
import { contentCollections } from '../content/content.collections.js';
import type { AssetDoc } from '../content/content.types.js';
import type {
  AmenityDoc,
  BoardingPointDoc,
  DestinationDoc,
  EditorialBlock,
  LocalityDoc,
  ServiceDoc,
} from './editorial.types.js';

/**
 * Snapshot editorial v2 (doc 08): export completo, versionado y verificable.
 *
 * El snapshot es la unidad primaria de exportación. Se construye, se valida, se
 * firma con SHA-256 y se ALMACENA; el endpoint sirve el snapshot activo, no una
 * construcción al vuelo. De ahí salen gratis el ETag estable, la retención y el
 * rollback: revertir es seleccionar otra versión ya validada.
 */

const snapshotChecker = TypeCompiler.Compile(editorialSnapshotSchema);

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * JSON con claves ordenadas: dos snapshots con el mismo contenido producen el
 * mismo hash aunque los documentos vengan de MongoDB en otro orden de campos.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

// ── Tipos del snapshot ──────────────────────────────────────────────────────

export interface SnapshotBlock {
  id: string;
  type: string;
  order: number;
  responsive: { desktop: boolean; tablet: boolean; mobile: boolean };
  config: Record<string, unknown>;
  content: Record<string, unknown>;
  isFallback: boolean;
}

export interface SnapshotManifestEntry {
  id: string;
  type: string;
  locale: string;
  hash: string;
  size: number;
  state: string;
  refs: string[];
}

export interface EditorialSnapshotBody {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  version: string;
  locale: string;
  defaultLocale: string;
  generatedAtUtc: string;
  localities: Record<string, unknown>[];
  destinations: Record<string, unknown>[];
  boardingPoints: Record<string, unknown>[];
  services: Record<string, unknown>[];
  amenities: Record<string, unknown>[];
  assets: Record<string, unknown>[];
  redirects: { from: string; to: string }[];
  manifest: SnapshotManifestEntry[];
  checksum: string;
}

export interface SnapshotBuildResult {
  body: EditorialSnapshotBody | null;
  errors: string[];
  warnings: string[];
}

// ── Selección de contenido por locale ───────────────────────────────────────

function pickLocale<T>(
  byLocale: Record<string, T>,
  locale: string,
  defaultLocale: string,
): { value: T | undefined; isFallback: boolean } {
  const direct = byLocale[locale];
  if (direct !== undefined) return { value: direct, isFallback: false };
  const fallback = byLocale[defaultLocale];
  return { value: fallback, isFallback: fallback !== undefined };
}

interface FilterContext {
  publishedAssets: Set<string>;
  publishedServices: Set<string>;
  publishedBoardingPoints: Set<string>;
  publishedDestinations: Set<string>;
}

function filterIds(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && allowed.has(v));
}

/**
 * Depura la configuración de un bloque contra lo realmente publicable.
 * Devuelve `null` si el bloque no debe exportarse.
 *
 * Reglas:
 * - galería: se cae el ítem cuyo asset no esté publicado o cuyos derechos no
 *   estén verificados, y con él su gemelo de contenido (van pareados por
 *   índice). Una galería que queda vacía SÍ se exporta: el front tiene estado
 *   vacío y ocultarla escondería el problema.
 * - listas de referencias: se filtran a lo publicado y, si quedan vacías, el
 *   bloque se omite — "Servicios: (nada)" es peor que no mostrar la sección.
 * - imágenes sueltas: si el asset no está publicado, el campo queda en `null`.
 */
function projectBlock(
  block: EditorialBlock,
  locale: string,
  defaultLocale: string,
  ctx: FilterContext,
): SnapshotBlock | null {
  if (!block.enabled) return null;
  if (block.status === 'draft' || block.status === 'archived') return null;

  const picked = pickLocale(block.content, locale, defaultLocale);
  if (picked.value === undefined) return null;

  const config = structuredClone(block.config);
  const content = structuredClone(picked.value);

  if (block.type === 'destination-gallery') {
    const configItems = Array.isArray(config['items']) ? (config['items'] as Record<string, unknown>[]) : [];
    const contentItems = Array.isArray(content['items'])
      ? (content['items'] as Record<string, unknown>[])
      : [];
    const keep: number[] = [];
    for (const [i, item] of configItems.entries()) {
      const slug = item['assetSlug'];
      const rights = item['rights'];
      const assetOk = typeof slug === 'string' && ctx.publishedAssets.has(slug);
      const rightsOk = typeof rights === 'string' && isPublishableMedia(rights);
      if (assetOk && rightsOk) keep.push(i);
    }
    config['items'] = keep.map((i) => configItems[i]);
    content['items'] = keep.map((i) => contentItems[i]).filter((i) => i !== undefined);
  }

  if (block.type === 'transport-services') {
    const ids = filterIds(config['serviceIds'], ctx.publishedServices);
    if (ids.length === 0) return null;
    config['serviceIds'] = ids;
  }
  if (block.type === 'boarding-points') {
    const ids = filterIds(config['boardingPointIds'], ctx.publishedBoardingPoints);
    if (ids.length === 0) return null;
    config['boardingPointIds'] = ids;
  }
  if (block.type === 'related-destinations') {
    const ids = filterIds(config['destinationIds'], ctx.publishedDestinations);
    if (ids.length === 0) return null;
    config['destinationIds'] = ids;
  }

  const nullUnpublishedAsset = (holder: Record<string, unknown>, key: string): void => {
    const slug = holder[key];
    if (typeof slug === 'string' && !ctx.publishedAssets.has(slug)) holder[key] = null;
  };
  nullUnpublishedAsset(config, 'imageAssetSlug');
  if (Array.isArray(config['items'])) {
    for (const item of config['items'] as Record<string, unknown>[]) {
      nullUnpublishedAsset(item, 'assetSlug');
      nullUnpublishedAsset(item, 'iconAssetSlug');
    }
  }

  return {
    id: block.id,
    type: block.type,
    order: block.order,
    responsive: block.responsive,
    config,
    content,
    isFallback: picked.isFallback,
  };
}

function refsOfBlocks(blocks: SnapshotBlock[]): string[] {
  const refs = new Set<string>();
  for (const block of blocks) {
    for (const key of ['serviceIds', 'boardingPointIds', 'destinationIds']) {
      const value = block.config[key];
      if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') refs.add(id);
    }
  }
  return [...refs].sort();
}

// ── Construcción ────────────────────────────────────────────────────────────

export interface BuildOptions {
  locale: string;
  version: string;
  generatedAtUtc: string;
}

export function buildSnapshotBody(
  ctx: ValidationContext,
  assets: AssetDoc[],
  opts: BuildOptions,
): SnapshotBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { locale, version } = opts;
  const defaultLocale = ctx.defaultLocale;

  const publishedOf = <T extends { status: string }>(docs: T[]): T[] =>
    docs.filter((d) => d.status === 'published');

  const localities = publishedOf<LocalityDoc>(ctx.graph.localities);
  const destinations = publishedOf<DestinationDoc>(ctx.graph.destinations);
  const boardingPoints = publishedOf<BoardingPointDoc>(ctx.graph.boardingPoints);
  const services = publishedOf<ServiceDoc>(ctx.graph.services);
  const amenities = publishedOf<AmenityDoc>(ctx.graph.amenities);
  const publishedAssets = assets.filter((a) => a.status === 'published' && a.isActive);

  const filterCtx: FilterContext = {
    publishedAssets: new Set(publishedAssets.map((a) => a.slug)),
    publishedServices: new Set(services.map((s) => s.id)),
    publishedBoardingPoints: new Set(boardingPoints.map((p) => p.id)),
    publishedDestinations: new Set(destinations.map((d) => d.id)),
  };

  // Identidad duplicada: rechaza la publicación (doc 08).
  const seenIds = new Set<string>();
  for (const d of destinations) {
    if (seenIds.has(d.id)) errors.push(`identidad duplicada: destino '${d.id}'`);
    seenIds.add(d.id);
  }

  const localityById = new Map(localities.map((l) => [l.id, l]));
  const destinationById = new Map(destinations.map((d) => [d.id, d]));
  const canonicalSeen = new Map<string, string>();
  const redirects: { from: string; to: string }[] = [];

  const snapshotDestinations = destinations.map((d) => {
    // Fail closed: si un documento publicado dejó de ser válido (edición
    // directa en Mongo, borrado de una referencia), el snapshot no sale.
    const validation = validateDestination(d, ctx);
    for (const issue of validation.errors) {
      errors.push(`${d.id}: ${issue.code}: ${issue.message}`);
    }
    for (const issue of validation.warnings) {
      warnings.push(`${d.id}: ${issue.code}: ${issue.message}`);
    }

    if (!localityById.has(d.localityId)) {
      errors.push(`${d.id}: la localidad '${d.localityId}' no está publicada`);
    }
    if (d.parentId !== null && !destinationById.has(d.parentId)) {
      warnings.push(`${d.id}: el padre '${d.parentId}' no está publicado`);
    }

    const parentSlug = d.parentId === null ? null : (destinationById.get(d.parentId)?.slug ?? null);
    const canonicalUrl = canonicalUrlOf(d, parentSlug);
    const previous = canonicalSeen.get(canonicalUrl);
    if (previous !== undefined) {
      errors.push(`identidad duplicada: '${canonicalUrl}' la usan '${previous}' y '${d.id}'`);
    }
    canonicalSeen.set(canonicalUrl, d.id);

    for (const from of d.redirectsFrom) {
      if (from !== canonicalUrl) redirects.push({ from, to: canonicalUrl });
    }

    const blocks = d.blocks
      .map((b) => projectBlock(b, locale, defaultLocale, filterCtx))
      .filter((b): b is SnapshotBlock => b !== null)
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

    const seo = pickLocale(d.seo, locale, defaultLocale);
    if (seo.value === undefined) errors.push(`${d.id}: sin SEO en '${locale}' ni en el default`);

    return {
      id: d.id,
      name: d.name,
      officialName: d.officialName,
      slug: d.slug,
      pageType: d.pageType,
      parentId: d.parentId,
      localityId: d.localityId,
      canonicalUrl,
      redirectsFrom: [...d.redirectsFrom].sort(),
      showInMainGrid: d.showInMainGrid,
      order: d.order,
      indexable: d.indexable,
      serviceIds: d.serviceIds.filter((id) => filterCtx.publishedServices.has(id)),
      seo: {
        title: seo.value?.title ?? '',
        description: seo.value?.description ?? '',
        ogImageSlug:
          seo.value?.ogImageSlug !== undefined &&
          seo.value.ogImageSlug !== null &&
          filterCtx.publishedAssets.has(seo.value.ogImageSlug)
            ? seo.value.ogImageSlug
            : null,
        isFallback: seo.isFallback,
      },
      blocks,
    };
  });

  const snapshotServices = services.map((s) => {
    const picked = pickLocale(s.content, locale, defaultLocale);
    if (picked.value === undefined) errors.push(`servicio ${s.id}: sin contenido en '${locale}'`);
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      order: s.order,
      amenityIds: s.amenityIds,
      excludedAmenityIds: s.excludedAmenityIds,
      deckConfigurations: s.deckConfigurations,
      heroAssetSlug:
        s.heroAssetSlug !== null && filterCtx.publishedAssets.has(s.heroAssetSlug)
          ? s.heroAssetSlug
          : null,
      gallery: s.gallery
        .filter((m) => filterCtx.publishedAssets.has(m.assetSlug) && isPublishableMedia(m.rights))
        .map((m) => ({
          assetSlug: m.assetSlug,
          credit: m.credit,
          rights: m.rights,
          alt: pickLocale(m.alt, locale, defaultLocale).value ?? '',
        })),
      shortDescription: picked.value?.shortDescription ?? '',
      description: picked.value?.description ?? '',
      isFallback: picked.isFallback,
    };
  });

  const snapshotAmenities = amenities.map((a) => {
    const picked = pickLocale(a.content, locale, defaultLocale);
    return {
      id: a.id,
      slug: a.slug,
      order: a.order,
      iconAssetSlug:
        a.iconAssetSlug !== null && filterCtx.publishedAssets.has(a.iconAssetSlug)
          ? a.iconAssetSlug
          : null,
      name: picked.value?.name ?? a.id,
      description: picked.value?.description ?? null,
      isFallback: picked.isFallback,
    };
  });

  const snapshotBoardingPoints = boardingPoints.map((p) => {
    if (p.localityId === null) {
      errors.push(`punto ${p.id}: publicado sin localidad (invariante del doc 03)`);
    }
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      localityId: p.localityId ?? '',
      isDestination: false as const,
      capabilities: p.capabilities,
      address: p.address,
    };
  });

  const snapshotLocalities = localities.map((l) => ({
    id: l.id,
    name: l.name,
    slug: l.slug,
    localityType: l.localityType,
    department: l.department,
    province: l.province,
    district: l.district,
  }));

  const snapshotAssets = publishedAssets.map((a) => ({
    slug: a.slug,
    path: a.path,
    altText: a.altText,
    mimeType: a.mimeType,
    width: a.width,
    height: a.height,
  }));

  // Referencias de comodidades: existen o el snapshot no sale.
  const amenityIds = new Set(snapshotAmenities.map((a) => a.id));
  for (const s of snapshotServices) {
    for (const id of [...s.amenityIds, ...s.excludedAmenityIds]) {
      if (!amenityIds.has(id)) {
        errors.push(`servicio ${s.id}: comodidad '${id}' no publicada o inexistente`);
      }
    }
  }

  if (errors.length > 0) return { body: null, errors, warnings };

  const sortById = <T extends { id: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const manifest: SnapshotManifestEntry[] = [];
  const entry = (type: string, doc: { id: string }, refs: string[]): void => {
    const serialized = canonicalJson(doc);
    manifest.push({
      id: doc.id,
      type,
      locale,
      hash: sha256Hex(serialized),
      size: Buffer.byteLength(serialized, 'utf8'),
      state: 'published',
      refs: [...refs].sort(),
    });
  };

  const orderedDestinations = sortById(snapshotDestinations);
  const orderedLocalities = sortById(snapshotLocalities);
  const orderedBoardingPoints = sortById(snapshotBoardingPoints);
  const orderedServices = sortById(snapshotServices);
  const orderedAmenities = sortById(snapshotAmenities);

  for (const d of orderedLocalities) entry('locality', d, []);
  for (const d of orderedDestinations) {
    entry('destination', d, [
      d.localityId,
      ...(d.parentId === null ? [] : [d.parentId]),
      ...d.serviceIds,
      ...refsOfBlocks(d.blocks),
    ]);
  }
  for (const d of orderedBoardingPoints) entry('boarding-point', d, [d.localityId]);
  for (const d of orderedServices) {
    entry('service', d, [...d.amenityIds, ...d.excludedAmenityIds]);
  }
  for (const d of orderedAmenities) entry('amenity', d, []);

  const body: EditorialSnapshotBody = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    version,
    locale,
    defaultLocale,
    generatedAtUtc: opts.generatedAtUtc,
    localities: orderedLocalities,
    destinations: orderedDestinations,
    boardingPoints: orderedBoardingPoints,
    services: orderedServices,
    amenities: orderedAmenities,
    assets: [...snapshotAssets].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    redirects: redirects.sort((a, b) => (a.from < b.from ? -1 : 1)),
    manifest,
    checksum: '',
  };

  body.checksum = checksumOf(body);

  const schemaErrors = [...snapshotChecker.Errors(body)]
    .slice(0, 20)
    .map((e) => `schema incompatible: ${e.path} ${e.message}`);
  if (schemaErrors.length > 0) return { body: null, errors: schemaErrors, warnings };

  return { body, errors: [], warnings };
}

/** Checksum del snapshot completo, excluyendo el propio campo `checksum`. */
export function checksumOf(body: EditorialSnapshotBody): string {
  const { checksum, ...rest } = body;
  void checksum;
  return sha256Hex(canonicalJson(rest));
}

/**
 * Verificación de integridad: recalcula cada hash del manifest y el checksum
 * global. Es lo que impide activar o servir un snapshot manipulado o truncado.
 */
export function verifySnapshotIntegrity(body: EditorialSnapshotBody): string[] {
  const problems: string[] = [];

  if (body.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    problems.push(
      `schema incompatible: versión ${String(body.schemaVersion)} ` +
        `(esperada ${String(SNAPSHOT_SCHEMA_VERSION)})`,
    );
    return problems;
  }

  const byType: Record<string, Record<string, unknown>[]> = {
    locality: body.localities,
    destination: body.destinations,
    'boarding-point': body.boardingPoints,
    service: body.services,
    amenity: body.amenities,
  };

  const documentCount = Object.values(byType).reduce((n, list) => n + list.length, 0);
  if (documentCount !== body.manifest.length) {
    problems.push(
      `manifest incompleto: ${String(body.manifest.length)} entradas para ` +
        `${String(documentCount)} documentos`,
    );
  }

  for (const item of body.manifest) {
    const doc = byType[item.type]?.find((d) => d['id'] === item.id);
    if (doc === undefined) {
      problems.push(`manifest: ${item.type} '${item.id}' no está en el snapshot`);
      continue;
    }
    const serialized = canonicalJson(doc);
    const hash = sha256Hex(serialized);
    if (hash !== item.hash) {
      problems.push(`hash inconsistente: ${item.type} '${item.id}'`);
    }
    if (Buffer.byteLength(serialized, 'utf8') !== item.size) {
      problems.push(`tamaño inconsistente: ${item.type} '${item.id}'`);
    }
  }

  // Referencias del manifest: toda ref debe existir en el propio snapshot.
  const knownIds = new Set(body.manifest.map((m) => m.id));
  for (const item of body.manifest) {
    for (const ref of item.refs) {
      if (ref.length > 0 && !knownIds.has(ref)) {
        problems.push(`referencia faltante: ${item.type} '${item.id}' → '${ref}'`);
      }
    }
  }

  if (checksumOf(body) !== body.checksum) problems.push('checksum global inconsistente');

  return problems;
}

/** Construye el snapshot del locale leyendo el estado actual de la base. */
export async function buildSnapshot(
  db: Db,
  opts: BuildOptions,
): Promise<SnapshotBuildResult> {
  const ctx = await buildValidationContext(db);
  const assets = await new ContentRepo(db).findAll<AssetDoc>(contentCollections.assets);
  return buildSnapshotBody(ctx, assets, opts);
}
