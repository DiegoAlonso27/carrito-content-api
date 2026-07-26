import type { Document } from 'mongodb';
import { editorialDocStatuses } from './editorial.types.js';

/**
 * Colecciones del modelo editorial. Prefijo `editorial_` para que convivan sin
 * ambigüedad con las colecciones flat que alimentan `content-cache.json`
 * (`content_items`, `assets`, …) hasta el cutover.
 */
export const editorialCollections = {
  localities: 'editorial_localities',
  destinations: 'editorial_destinations',
  boardingPoints: 'editorial_boarding_points',
  services: 'editorial_services',
  amenities: 'editorial_amenities',
  reviewQueue: 'editorial_review_queue',
  meta: 'meta',
} as const;

const envelopeProps: Document = {
  status: { enum: [...editorialDocStatuses] },
  revision: { bsonType: ['int', 'long', 'double'] },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
};

const envelopeRequired = ['status', 'revision', 'createdAt', 'updatedAt'];

function envelope(required: string[], properties: Document): Document {
  return {
    $jsonSchema: {
      bsonType: 'object',
      required: [...required, ...envelopeRequired],
      properties: { ...properties, ...envelopeProps },
    },
  };
}

/**
 * Validadores $jsonSchema (nivel moderate): defensa en profundidad sobre el
 * sobre y la clave natural. La validación fina vive en TypeBox.
 *
 * `isDestination: { enum: [false] }` es la versión en base de datos del
 * invariante del doc 02: ni un script ni una escritura manual pueden
 * convertir un punto de embarque en destino.
 */
export const editorialCollectionValidators: Record<string, Document> = {
  [editorialCollections.localities]: envelope(['id', 'name', 'slug', 'localityType'], {
    id: { bsonType: 'string' },
    name: { bsonType: 'string' },
    slug: { bsonType: 'string' },
    localityType: { enum: ['city', 'town', 'locality'] },
  }),
  [editorialCollections.destinations]: envelope(
    ['id', 'name', 'slug', 'localityId', 'pageType', 'blocks'],
    {
      id: { bsonType: 'string' },
      name: { bsonType: 'string' },
      slug: { bsonType: 'string' },
      localityId: { bsonType: 'string' },
      pageType: { enum: ['full', 'short'] },
      parentId: { bsonType: ['string', 'null'] },
      blocks: { bsonType: 'array' },
    },
  ),
  [editorialCollections.boardingPoints]: envelope(['id', 'name', 'slug', 'isDestination'], {
    id: { bsonType: 'string' },
    name: { bsonType: 'string' },
    slug: { bsonType: 'string' },
    localityId: { bsonType: ['string', 'null'] },
    isDestination: { enum: [false] },
    addressVerified: { bsonType: 'bool' },
  }),
  [editorialCollections.services]: envelope(['id', 'name', 'slug', 'deckConfigurations'], {
    id: { bsonType: 'string' },
    name: { bsonType: 'string' },
    slug: { bsonType: 'string' },
    deckConfigurations: { bsonType: 'array' },
  }),
  [editorialCollections.amenities]: envelope(['id', 'slug'], {
    id: { bsonType: 'string' },
    slug: { bsonType: 'string' },
  }),
};

interface IndexSpec {
  collection: string;
  name: string;
  keys: Document;
  unique: boolean;
}

/**
 * Únicos = identidad editorial (id inmutable) y espacio de slugs.
 * El slug de destino es único globalmente aunque la URL sea jerárquica: evita
 * que dos padres distintos generen la misma hoja y simplifica el redirect.
 */
export const editorialCollectionIndexes: IndexSpec[] = [
  {
    collection: editorialCollections.localities,
    name: 'ux_editorial_localities_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.localities,
    name: 'ux_editorial_localities_slug',
    keys: { slug: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.destinations,
    name: 'ux_editorial_destinations_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.destinations,
    name: 'ux_editorial_destinations_slug',
    keys: { slug: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.destinations,
    name: 'ix_editorial_destinations_status',
    keys: { status: 1, order: 1 },
    unique: false,
  },
  {
    collection: editorialCollections.destinations,
    name: 'ix_editorial_destinations_parent',
    keys: { parentId: 1 },
    unique: false,
  },
  {
    collection: editorialCollections.boardingPoints,
    name: 'ux_editorial_boarding_points_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.boardingPoints,
    name: 'ix_editorial_boarding_points_locality',
    keys: { localityId: 1 },
    unique: false,
  },
  {
    collection: editorialCollections.services,
    name: 'ux_editorial_services_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.services,
    name: 'ux_editorial_services_slug',
    keys: { slug: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.amenities,
    name: 'ux_editorial_amenities_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.reviewQueue,
    name: 'ux_editorial_review_queue_id',
    keys: { id: 1 },
    unique: true,
  },
  {
    collection: editorialCollections.reviewQueue,
    name: 'ix_editorial_review_queue_state',
    keys: { state: 1 },
    unique: false,
  },
];
