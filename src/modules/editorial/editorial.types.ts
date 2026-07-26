/**
 * Modelo editorial por bloques (Track B, plan-editorial-web-tc docs 02–05).
 *
 * Vive en colecciones propias (`editorial_*`) y con su propio contador de
 * versión (`meta/_id:'editorial'`): el contrato flat de `content-cache.json`
 * y su golden no se tocan hasta el cutover (Fase 5).
 */

/** Estados del doc 02. Las colecciones flat conservan su set de 3 (ADR-011). */
export type EditorialDocStatus = 'draft' | 'review' | 'approved' | 'published' | 'archived';

export const editorialDocStatuses: readonly EditorialDocStatus[] = [
  'draft',
  'review',
  'approved',
  'published',
  'archived',
] as const;

export type PageType = 'full' | 'short';

export type LocalityType = 'city' | 'town' | 'locality';

export type BoardingCapability = 'boarding' | 'disembarking' | 'ticketing';

/** Sobre editorial común a todo documento del modelo nuevo. */
export interface EditorialDocEnvelope {
  status: EditorialDocStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Bloques ─────────────────────────────────────────────────────────────────

export interface BlockResponsive {
  desktop: boolean;
  tablet: boolean;
  mobile: boolean;
}

/**
 * Envelope de bloque (doc 05): `type`, `id` estable, orden, estado editorial,
 * contenido por idioma y configuración responsive.
 *
 * `config` es la configuración neutra al idioma (referencias a medios y a
 * otros documentos); `content` es el texto por locale. Separarlos evita que
 * una referencia se duplique —y se desincronice— en cada traducción.
 */
export interface EditorialBlock {
  id: string;
  type: string;
  order: number;
  status: EditorialDocStatus;
  enabled: boolean;
  responsive: BlockResponsive;
  config: Record<string, unknown>;
  content: Record<string, Record<string, unknown>>;
}

// ── Documentos ──────────────────────────────────────────────────────────────

export interface LocalityDoc extends EditorialDocEnvelope {
  id: string;
  name: string;
  slug: string;
  localityType: LocalityType;
  department: string;
  province: string;
  district: string | null;
}

export interface SeoEntry {
  title: string;
  description: string;
  ogImageSlug: string | null;
}

export interface DestinationDoc extends EditorialDocEnvelope {
  id: string;
  name: string;
  /** Denominación oficial cuando difiere del nombre comercial (P-11). */
  officialName: string | null;
  slug: string;
  localityId: string;
  pageType: PageType;
  /** Agrupación editorial. No es dependencia administrativa ni ruta (doc 02). */
  parentId: string | null;
  showInMainGrid: boolean;
  order: number;
  indexable: boolean;
  serviceIds: string[];
  /** URLs previas que deben responder con redirección permanente (doc 07). */
  redirectsFrom: string[];
  /** Dudas del catálogo visibles para el equipo editorial (doc 03, P-03). */
  editorialNotes: string[];
  seo: Record<string, SeoEntry>;
  blocks: EditorialBlock[];
}

export interface BoardingPointDoc extends EditorialDocEnvelope {
  id: string;
  name: string;
  slug: string;
  /** Obligatorio para publicar: un punto sin localidad queda en validación (doc 03). */
  localityId: string | null;
  /** Invariante del doc 02: un punto de embarque nunca es destino. */
  isDestination: false;
  capabilities: BoardingCapability[];
  address: string | null;
  addressVerified: boolean;
  notes: string[];
}

export interface DeckConfiguration {
  deck: number;
  leftSeatCount: number;
  rightSeatCount: number;
  hasIndividualSeat: boolean;
  reclineDegrees: number;
}

export interface ServiceMedia {
  assetSlug: string;
  credit: string | null;
  rights: MediaRights;
  alt: Record<string, string>;
}

export type MediaRights = 'own' | 'licensed' | 'public-domain';

export interface ServiceDoc extends EditorialDocEnvelope {
  id: string;
  name: string;
  slug: string;
  order: number;
  /** Comodidades garantizadas en TODAS las unidades del servicio (§6). */
  amenityIds: string[];
  /** Ausencias confirmadas (sin Wi-Fi, sin pantallas, sin mantas). */
  excludedAmenityIds: string[];
  deckConfigurations: DeckConfiguration[];
  heroAssetSlug: string | null;
  gallery: ServiceMedia[];
  content: Record<string, { shortDescription: string; description: string }>;
}

export interface AmenityDoc extends EditorialDocEnvelope {
  id: string;
  slug: string;
  order: number;
  iconAssetSlug: string | null;
  content: Record<string, { name: string; description: string | null }>;
}

// ── Cola de revisión (doc 01) ───────────────────────────────────────────────

export interface ReviewQueueDoc {
  id: string;
  source: string;
  sourceKey: string;
  reason: string;
  payload: Record<string, unknown>;
  state: 'open' | 'resolved';
  createdAt: Date;
  updatedAt: Date;
}

/** Singleton de versión del modelo editorial (colección `meta`, _id 'editorial'). */
export interface EditorialMetaDoc {
  _id: 'editorial';
  editorialVersion: number;
  revisionSeq: number;
}
