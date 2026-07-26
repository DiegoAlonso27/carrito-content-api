import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';
import { mediaRights } from './editorial.blocks.js';

/**
 * Contrato del snapshot editorial v2 (doc 08).
 *
 * Es un formato NUEVO y paralelo: `/v1/export/content-cache` y su golden no se
 * tocan hasta el cutover. La versión de schema viaja en el propio documento
 * (`schemaVersion`) para que el consumidor pueda rechazar lo que no entiende.
 */

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const SNAPSHOT_SCHEMA_VERSION = 2;

const isoUtcDateTime = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$',
});

const sha256Hex = Type.String({ pattern: '^[a-f0-9]{64}$' });

export const snapshotBlockSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    order: Type.Integer({ minimum: 0 }),
    responsive: Type.Object(
      { desktop: Type.Boolean(), tablet: Type.Boolean(), mobile: Type.Boolean() },
      { additionalProperties: false },
    ),
    config: Type.Record(Type.String(), Type.Unknown()),
    content: Type.Record(Type.String(), Type.Unknown()),
    /** true si el contenido proviene del locale por defecto, no del pedido. */
    isFallback: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const snapshotLocalitySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    slug: Type.String({ minLength: 1 }),
    localityType: Type.String({ minLength: 1 }),
    department: Type.String({ minLength: 1 }),
    province: Type.String({ minLength: 1 }),
    district: nullable(Type.String()),
  },
  { additionalProperties: false },
);

export const snapshotDestinationSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    officialName: nullable(Type.String()),
    slug: Type.String({ minLength: 1 }),
    pageType: Type.Union([Type.Literal('full'), Type.Literal('short')]),
    parentId: nullable(Type.String()),
    localityId: Type.String({ minLength: 1 }),
    canonicalUrl: Type.String({ minLength: 1 }),
    redirectsFrom: Type.Array(Type.String()),
    showInMainGrid: Type.Boolean(),
    order: Type.Integer({ minimum: 0 }),
    indexable: Type.Boolean(),
    serviceIds: Type.Array(Type.String()),
    seo: Type.Object(
      {
        title: Type.String(),
        description: Type.String(),
        ogImageSlug: nullable(Type.String()),
        isFallback: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    blocks: Type.Array(snapshotBlockSchema),
  },
  { additionalProperties: false },
);

export const snapshotBoardingPointSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    slug: Type.String({ minLength: 1 }),
    localityId: Type.String({ minLength: 1 }),
    isDestination: Type.Literal(false),
    capabilities: Type.Array(Type.String()),
    address: nullable(Type.String()),
  },
  { additionalProperties: false },
);

export const snapshotServiceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    slug: Type.String({ minLength: 1 }),
    order: Type.Integer({ minimum: 0 }),
    amenityIds: Type.Array(Type.String()),
    excludedAmenityIds: Type.Array(Type.String()),
    deckConfigurations: Type.Array(
      Type.Object(
        {
          deck: Type.Integer(),
          leftSeatCount: Type.Integer(),
          rightSeatCount: Type.Integer(),
          hasIndividualSeat: Type.Boolean(),
          reclineDegrees: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    heroAssetSlug: nullable(Type.String()),
    gallery: Type.Array(
      Type.Object(
        {
          assetSlug: Type.String({ minLength: 1 }),
          credit: nullable(Type.String()),
          rights: Type.Union(mediaRights.map((r) => Type.Literal(r))),
          alt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    shortDescription: Type.String(),
    description: Type.String(),
    isFallback: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const snapshotAmenitySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    slug: Type.String({ minLength: 1 }),
    order: Type.Integer({ minimum: 0 }),
    iconAssetSlug: nullable(Type.String()),
    name: Type.String({ minLength: 1 }),
    description: nullable(Type.String()),
    isFallback: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const snapshotManifestEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    locale: Type.String({ minLength: 2 }),
    hash: sha256Hex,
    size: Type.Integer({ minimum: 0 }),
    state: Type.String({ minLength: 1 }),
    refs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const snapshotAssetSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    altText: nullable(Type.String()),
    mimeType: Type.String({ minLength: 1 }),
    width: nullable(Type.Integer()),
    height: nullable(Type.Integer()),
  },
  { additionalProperties: false },
);

export const editorialSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(SNAPSHOT_SCHEMA_VERSION),
    version: Type.String({ minLength: 1 }),
    locale: Type.String({ minLength: 2 }),
    defaultLocale: Type.String({ minLength: 2 }),
    generatedAtUtc: isoUtcDateTime,
    localities: Type.Array(snapshotLocalitySchema),
    destinations: Type.Array(snapshotDestinationSchema),
    boardingPoints: Type.Array(snapshotBoardingPointSchema),
    services: Type.Array(snapshotServiceSchema),
    amenities: Type.Array(snapshotAmenitySchema),
    assets: Type.Array(snapshotAssetSchema),
    redirects: Type.Array(
      Type.Object(
        { from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    manifest: Type.Array(snapshotManifestEntrySchema),
    checksum: sha256Hex,
  },
  { additionalProperties: false },
);
