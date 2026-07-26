import type { Db } from 'mongodb';
import { EditorialRepo } from './editorial.repo.js';
import { editorialCollections } from './editorial.collections.js';
import { editorialSectionCollections } from './editorial-write.js';
import { transportServicesAlertText } from './editorial.blocks.js';
import { ContentRepo, ContentTopologyError } from '../content/content.repo.js';
import { contentCollections } from '../content/content.collections.js';
import type { ItemDoc } from '../content/content.types.js';
import type { AnnotatedCatalog, CatalogBoardingPoint, CatalogDestination } from './editorial.catalog.js';
import type {
  AmenityDoc,
  BoardingPointDoc,
  DestinationDoc,
  EditorialBlock,
  EditorialDocStatus,
  LocalityDoc,
  ReviewQueueDoc,
  ServiceDoc,
} from './editorial.types.js';

/**
 * Migración flat → modelo editorial (doc 01).
 *
 * Reglas duras de esta migración:
 * - NO borra el origen: `content_items` queda intacto.
 * - NO publica nada: todo entra en `review`/`draft` y la publicación es un
 *   paso explícito posterior.
 * - NO inventa contenido: lo que no se puede clasificar va a la cola de
 *   revisión. Los destinos sin guía reciben un documento mínimo derivado del
 *   catálogo (nombre + una frase geográfica factual) y quedan `indexable:
 *   false` hasta que exista redacción editorial.
 * - Los `id` de bloque migrados son deterministas para que reejecutar la
 *   migración no cambie la identidad de ningún bloque.
 */

const DEFAULT_LOCALE_FALLBACK = 'es-PE';

export interface MigrationPlan {
  localities: Omit<LocalityDoc, keyof EditorialEnvelopeFields>[];
  destinations: Omit<DestinationDoc, keyof EditorialEnvelopeFields>[];
  boardingPoints: Omit<BoardingPointDoc, keyof EditorialEnvelopeFields>[];
  services: Omit<ServiceDoc, keyof EditorialEnvelopeFields>[];
  amenities: Omit<AmenityDoc, keyof EditorialEnvelopeFields>[];
  statuses: Record<string, EditorialDocStatus>;
  reviewQueue: Omit<ReviewQueueDoc, 'createdAt' | 'updatedAt'>[];
  report: MigrationReport;
}

interface EditorialEnvelopeFields {
  status: EditorialDocStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MigrationReport {
  sourceCounts: Record<string, number>;
  destinationsFromGuide: string[];
  destinationsGenerated: string[];
  servicesCreated: string[];
  unclassified: { sourceKey: string; reason: string }[];
  /** Deriva catálogo ⇄ base (P-01): identidades que no están en ambos lados. */
  drift: { onlyInCatalog: string[]; onlyInDatabase: string[] };
}

// ── Utilidades de contenido ─────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const allResponsive = { desktop: true, tablet: true, mobile: true } as const;

function block(
  destinationId: string,
  type: string,
  index: number,
  locale: string,
  content: Record<string, unknown>,
  config: Record<string, unknown> = {},
  enabled = true,
): EditorialBlock {
  return {
    id: `${destinationId}:${type}:${String(index)}`,
    type,
    order: (index + 1) * 10,
    status: 'review',
    enabled,
    responsive: { ...allResponsive },
    config,
    content: { [locale]: content },
  };
}

// ── Guías flat ──────────────────────────────────────────────────────────────

interface GuideAttraction {
  name: string;
  description: string;
  imageAsset: string;
  duration: string;
  distance: string;
}

interface GuideTip {
  icon: string;
  title: string;
  description: string;
}

interface GuideData {
  title: string;
  region: string;
  imageAsset: string;
  population: string;
  altitude: string;
  temperature: string;
  description: string;
  history: string;
  gastronomy: string;
  festivities: string;
  gallery: { imageAsset: string }[];
  attractions: GuideAttraction[];
  bestTime: string;
  bestTimeDetail: string;
  duration: string;
  durationDetail: string;
  howToArrive: string;
  howToArriveDetail: string;
  tips: GuideTip[];
  services: string[];
}

/**
 * Mapea una guía flat a bloques. `services` de la guía son servicios URBANOS
 * (hoteles, bancos, terminal): van a `city-services`, jamás a
 * `transport-services` (doc 04, separación estricta).
 */
export function blocksFromGuide(
  destinationId: string,
  guide: GuideData,
  locale: string,
): EditorialBlock[] {
  const blocks: EditorialBlock[] = [];
  let index = 0;

  blocks.push(
    block(
      destinationId,
      'destination-hero',
      index++,
      locale,
      { kicker: null, title: guide.title, subtitle: guide.region },
      { imageAssetSlug: guide.imageAsset, overlay: true },
    ),
  );

  blocks.push(
    block(destinationId, 'destination-overview', index++, locale, {
      summary: guide.description,
      highlights: [
        { label: 'Población', value: guide.population },
        { label: 'Altitud', value: guide.altitude },
        { label: 'Temperatura', value: guide.temperature },
      ],
    }),
  );

  blocks.push(
    block(
      destinationId,
      'destination-location',
      index++,
      locale,
      { note: null },
      { showMap: false, mapUrl: null },
    ),
  );

  const richTexts: [string, string][] = [
    ['Historia', guide.history],
    ['Gastronomía', guide.gastronomy],
    ['Fiestas y celebraciones', guide.festivities],
  ];
  for (const [title, body] of richTexts) {
    if (body.trim().length === 0) continue;
    blocks.push(
      block(destinationId, 'destination-rich-text', index++, locale, {
        title,
        bodyHtml: paragraphs(body),
      }),
    );
  }

  if (guide.gallery.length > 0) {
    // Los derechos de los medios heredados no están registrados: entran como
    // `unverified` y el export los excluye hasta que alguien los confirme.
    blocks.push(
      block(
        destinationId,
        'destination-gallery',
        index++,
        locale,
        {
          title: 'Galería',
          items: guide.gallery.map((_, i) => ({
            alt: `${guide.title}: imagen ${String(i + 1)}`,
            caption: null,
          })),
        },
        {
          items: guide.gallery.map((g) => ({
            assetSlug: g.imageAsset,
            credit: null,
            rights: 'unverified',
          })),
        },
      ),
    );
  }

  if (guide.attractions.length > 0) {
    blocks.push(
      block(
        destinationId,
        'destination-attractions',
        index++,
        locale,
        {
          title: 'Qué visitar',
          items: guide.attractions.map((a) => ({
            name: a.name,
            description: a.description,
            duration: a.duration.length > 0 ? a.duration : null,
            distance: a.distance.length > 0 ? a.distance : null,
          })),
        },
        { items: guide.attractions.map((a) => ({ assetSlug: a.imageAsset })) },
      ),
    );
  }

  blocks.push(
    block(destinationId, 'destination-practical-info', index++, locale, {
      title: 'Información práctica',
      items: [
        { label: 'Mejor época', value: guide.bestTime, detail: guide.bestTimeDetail },
        { label: 'Duración sugerida', value: guide.duration, detail: guide.durationDetail },
        { label: 'Cómo llegar', value: guide.howToArrive, detail: guide.howToArriveDetail },
      ],
    }),
  );

  if (guide.tips.length > 0) {
    blocks.push(
      block(destinationId, 'destination-tips', index++, locale, {
        title: 'Recomendaciones',
        items: guide.tips.map((t) => ({
          icon: t.icon,
          title: t.title,
          description: t.description,
        })),
      }),
    );
  }

  if (guide.services.length > 0) {
    blocks.push(
      block(
        destinationId,
        'city-services',
        index++,
        locale,
        {
          title: 'Servicios en la ciudad',
          items: guide.services.map((s) => ({
            category: 'General',
            name: s,
            description: null,
            address: null,
            schedule: null,
            contact: null,
          })),
        },
        { items: guide.services.map(() => ({ iconAssetSlug: null })) },
      ),
    );
  }

  return blocks;
}

const localityLabel: Record<CatalogDestination['localityType'], string> = {
  city: 'ciudad',
  town: 'localidad',
  locality: 'localidad',
};

/**
 * Documento mínimo para un destino sin guía: nombre + una frase geográfica
 * derivada del catálogo. No es copy de marketing y no afirma nada operativo.
 */
export function blocksFromCatalogOnly(
  entry: CatalogDestination,
  locale: string,
): EditorialBlock[] {
  const district =
    entry.district === null || entry.district === entry.province
      ? ''
      : `, distrito de ${entry.district}`;
  const summary =
    `${entry.name} es una ${localityLabel[entry.localityType]} de la provincia de ` +
    `${entry.province}, en el departamento de ${entry.department}${district}.`;

  return [
    block(
      entry.id,
      'destination-hero',
      0,
      locale,
      { kicker: null, title: entry.name, subtitle: null },
      { imageAssetSlug: null, overlay: true },
    ),
    block(entry.id, 'destination-overview', 1, locale, { summary, highlights: [] }),
    block(
      entry.id,
      'destination-location',
      2,
      locale,
      { note: null },
      { showMap: false, mapUrl: null },
    ),
  ];
}

// ── Servicios de transporte (contexto maestro §6) ───────────────────────────

interface ServiceSeed {
  id: string;
  name: string;
  order: number;
  amenityIds: string[];
  excludedAmenityIds: string[];
  deckConfigurations: ServiceDoc['deckConfigurations'];
  shortDescription: string;
  description: string;
}

/**
 * Solo configuración y comodidades CONFIRMADAS (§6). Lo pendiente —USB en
 * Normal y VIP, aire acondicionado, baño, mantas, fotografías oficiales— no se
 * publica: se registra en la cola de revisión.
 */
export const serviceSeeds: readonly ServiceSeed[] = [
  {
    id: 'bus-normal',
    name: 'Bus Normal',
    order: 10,
    amenityIds: ['cortinas'],
    excludedAmenityIds: ['wifi'],
    deckConfigurations: [
      { deck: 1, leftSeatCount: 2, rightSeatCount: 2, hasIndividualSeat: false, reclineDegrees: 140 },
    ],
    shortDescription: 'Un piso con distribución 2-2 y reclinación de 140°.',
    description:
      'Bus Normal cuenta con un único piso, dos asientos a cada lado del pasillo y ' +
      'reclinación de 140°. Incluye cortinas. Actualmente no dispone de Wi-Fi a bordo.',
  },
  {
    id: 'bus-cama',
    name: 'Bus Cama',
    order: 20,
    amenityIds: ['usb', 'cortinas'],
    excludedAmenityIds: ['pantallas', 'wifi'],
    deckConfigurations: [
      { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 160 },
      { deck: 2, leftSeatCount: 2, rightSeatCount: 2, hasIndividualSeat: false, reclineDegrees: 140 },
    ],
    shortDescription: 'Dos pisos, asiento individual en el primero y reclinación de hasta 160°.',
    description:
      'Bus Cama distribuye el primer piso en dos asientos y un asiento individual con ' +
      'reclinación de 160°, y el segundo piso en dos asientos a cada lado con reclinación ' +
      'de 140°. Incluye puerto USB y cortinas. No dispone de pantallas ni Wi-Fi a bordo.',
  },
  {
    id: 'bus-cama-vip',
    name: 'Bus Cama VIP',
    order: 30,
    amenityIds: ['cortinas'],
    excludedAmenityIds: ['mantas', 'wifi'],
    deckConfigurations: [
      { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
      { deck: 2, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
    ],
    shortDescription: 'Asiento individual en ambos pisos con reclinación de 170°.',
    description:
      'Bus Cama VIP mantiene dos asientos y un asiento individual en ambos pisos, con ' +
      'reclinación de 170° en los dos niveles. Incluye cortinas. No entrega mantas ni ' +
      'dispone de Wi-Fi a bordo.',
  },
] as const;

export const amenitySeeds: readonly { id: string; name: string }[] = [
  { id: 'cortinas', name: 'Cortinas' },
  { id: 'usb', name: 'Puerto USB' },
  { id: 'pantallas', name: 'Pantallas' },
  { id: 'wifi', name: 'Wi-Fi' },
  { id: 'mantas', name: 'Mantas' },
] as const;

/** Servicios flat que la oferta aprobada no contempla (decisión D-F). */
const unclassifiedFlatServices = new Set(['panoramico', 'economico']);

// ── Construcción del plan ───────────────────────────────────────────────────

export interface MigrationInput {
  catalog: AnnotatedCatalog;
  guides: { slug: string; data: GuideData }[];
  flatServices: { slug: string; data: Record<string, unknown> }[];
  flatGalleryServices: { slug: string; data: Record<string, unknown> }[];
  existingDestinationIds: string[];
  locale: string;
}

function isStatus(value: string): value is EditorialDocStatus {
  return ['draft', 'review', 'approved', 'published', 'archived'].includes(value);
}

function boardingPointFrom(
  entry: CatalogBoardingPoint,
  localityIdBySlug: Map<string, string>,
): Omit<BoardingPointDoc, keyof EditorialEnvelopeFields> {
  const localityId =
    entry.localitySlug === null ? null : (localityIdBySlug.get(entry.localitySlug) ?? null);
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    localityId,
    isDestination: false,
    capabilities: entry.capabilities,
    address: entry.address ?? null,
    addressVerified: entry.addressVerified,
    notes: entry.blockingValidations,
  };
}

export function buildMigrationPlan(input: MigrationInput): MigrationPlan {
  const { catalog, locale } = input;
  const guideBySlug = new Map(input.guides.map((g) => [g.slug, g.data]));
  const localityIdBySlug = new Map(catalog.destinations.map((d) => [d.slug, d.id]));
  const statuses: Record<string, EditorialDocStatus> = {};
  const reviewQueue: MigrationPlan['reviewQueue'] = [];
  const unclassified: MigrationReport['unclassified'] = [];

  const localities = catalog.destinations.map((d) => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    localityType: d.localityType,
    department: d.department,
    province: d.province,
    district: d.district,
  }));
  for (const l of localities) statuses[`localities/${l.id}`] = 'review';

  const destinationsFromGuide: string[] = [];
  const destinationsGenerated: string[] = [];

  const destinations = catalog.destinations.map((entry) => {
    const guide = guideBySlug.get(entry.slug);
    const fromGuide = guide !== undefined;
    const blocks = fromGuide
      ? blocksFromGuide(entry.id, guide, locale)
      : blocksFromCatalogOnly(entry, locale);

    if (fromGuide) destinationsFromGuide.push(entry.id);
    else destinationsGenerated.push(entry.id);

    const notes = [...entry.advisoryNotes, ...entry.blockingValidations];
    if (!fromGuide) {
      notes.push(
        'Contenido mínimo derivado del catálogo: requiere redacción editorial antes de ' +
          'marcarlo indexable.',
      );
      reviewQueue.push({
        id: `destination-needs-copy:${entry.id}`,
        source: 'catalog',
        sourceKey: entry.id,
        reason: 'Destino sin guía editorial: solo tiene contenido mínimo derivado del catálogo.',
        payload: { pageType: entry.pageType, canonicalUrl: entry.canonicalUrl },
        state: 'open',
      });
    } else {
      reviewQueue.push({
        id: `media-rights-unverified:${entry.id}`,
        source: 'flat-item',
        sourceKey: `destination-guides/${entry.slug}`,
        reason: 'Galería migrada con derechos sin verificar: no entrará al snapshot publicado.',
        payload: { destinationId: entry.id },
        state: 'open',
      });
    }

    statuses[`destinations/${entry.id}`] = isStatus(entry.initialStatus)
      ? entry.initialStatus
      : 'review';

    const seoDescription = guide === undefined ? '' : truncate(guide.description, 300);

    return {
      id: entry.id,
      name: entry.name,
      officialName: null,
      slug: entry.slug,
      localityId: entry.id,
      pageType: entry.pageType,
      parentId: entry.parentSlug === null ? null : (localityIdBySlug.get(entry.parentSlug) ?? null),
      showInMainGrid: entry.showInMainGrid,
      order: entry.order,
      // Sin redacción propia, la página no debe competir en buscadores.
      indexable: fromGuide,
      serviceIds: [],
      redirectsFrom: [...new Set([...entry.redirectsFrom, `/destino/${entry.slug}`])],
      editorialNotes: notes,
      seo: {
        [locale]: {
          title: guide === undefined ? entry.name : `${entry.name} | Destinos`,
          description: seoDescription,
          ogImageSlug: guide?.imageAsset ?? null,
        },
      },
      blocks,
    };
  });

  const boardingPoints = [...catalog.boardingPoints, ...catalog.derivedBoardingPoints].map((b) => {
    statuses[`boarding-points/${b.id}`] = 'draft';
    if (b.blockingValidations.length > 0) {
      reviewQueue.push({
        id: `boarding-point-unverified:${b.id}`,
        source: 'catalog',
        sourceKey: b.id,
        reason: b.blockingValidations.join(' '),
        payload: { localitySlug: b.localitySlug, addressVerified: b.addressVerified },
        state: 'open',
      });
    }
    return boardingPointFrom(b, localityIdBySlug);
  });

  const amenities = amenitySeeds.map((a) => {
    statuses[`amenities/${a.id}`] = 'review';
    return {
      id: a.id,
      slug: a.id,
      order: (amenitySeeds.findIndex((x) => x.id === a.id) + 1) * 10,
      iconAssetSlug: null,
      content: { [locale]: { name: a.name, description: null } },
    };
  });

  const flatServiceBySlug = new Map(input.flatServices.map((s) => [s.slug, s.data]));
  const services = serviceSeeds.map((seed) => {
    statuses[`services/${seed.id}`] = 'review';
    // Único traspaso 1:1 aprobado (D-F): el VIP conserva su imagen actual.
    const legacy = flatServiceBySlug.get(seed.id);
    const heroAssetSlug =
      typeof legacy?.['imageAsset'] === 'string' ? (legacy['imageAsset']) : null;
    if (heroAssetSlug === null) {
      reviewQueue.push({
        id: `service-photo-missing:${seed.id}`,
        source: 'catalog',
        sourceKey: seed.id,
        reason: 'Faltan fotografías oficiales del servicio (pendiente del contexto maestro §6).',
        payload: {},
        state: 'open',
      });
    }
    return {
      id: seed.id,
      name: seed.name,
      slug: seed.id,
      order: seed.order,
      amenityIds: [...seed.amenityIds],
      excludedAmenityIds: [...seed.excludedAmenityIds],
      deckConfigurations: seed.deckConfigurations.map((d) => ({ ...d })),
      heroAssetSlug,
      gallery: [],
      content: {
        [locale]: { shortDescription: seed.shortDescription, description: seed.description },
      },
    };
  });

  for (const flat of input.flatServices) {
    if (!unclassifiedFlatServices.has(flat.slug)) continue;
    const reason =
      'Servicio flat fuera de la oferta aprobada (Bus Normal / Bus Cama / Bus Cama VIP) ' +
      'y con copy de relleno: no se migra ni se publica.';
    unclassified.push({ sourceKey: `services/${flat.slug}`, reason });
    reviewQueue.push({
      id: `unclassified-service:${flat.slug}`,
      source: 'flat-item',
      sourceKey: `services/${flat.slug}`,
      reason,
      payload: flat.data,
      state: 'open',
    });
  }

  for (const media of input.flatGalleryServices) {
    const reason =
      'Medio de galería sin documento dueño, sin alt y sin derechos registrados: ' +
      'requiere asignación editorial antes de usarse.';
    unclassified.push({ sourceKey: `gallery-services/${media.slug}`, reason });
    reviewQueue.push({
      id: `orphan-media:${media.slug}`,
      source: 'flat-item',
      sourceKey: `gallery-services/${media.slug}`,
      reason,
      payload: media.data,
      state: 'open',
    });
  }

  const catalogIds = new Set(catalog.destinations.map((d) => d.id));
  const existing = new Set(input.existingDestinationIds);
  const report: MigrationReport = {
    sourceCounts: {
      catalogDestinations: catalog.destinations.length,
      guides: input.guides.length,
      flatServices: input.flatServices.length,
      flatGalleryServices: input.flatGalleryServices.length,
      catalogBoardingPoints: catalog.boardingPoints.length + catalog.derivedBoardingPoints.length,
    },
    destinationsFromGuide,
    destinationsGenerated,
    servicesCreated: services.map((s) => s.id),
    unclassified,
    drift: {
      onlyInCatalog: [...catalogIds].filter((id) => !existing.has(id)),
      onlyInDatabase: [...existing].filter((id) => !catalogIds.has(id)),
    },
  };

  return { localities, destinations, boardingPoints, services, amenities, statuses, reviewQueue, report };
}

// ── Lectura del origen y aplicación ─────────────────────────────────────────

export async function loadMigrationInput(
  db: Db,
  catalog: AnnotatedCatalog,
): Promise<MigrationInput> {
  const contentRepo = new ContentRepo(db);
  const editorialRepo = new EditorialRepo(db);

  const items = await contentRepo.findAll<ItemDoc>(contentCollections.items);
  const locales = await contentRepo.findAll<{ code: string; isDefault: boolean; status: string }>(
    contentCollections.locales,
  );
  const locale =
    locales.find((l) => l.isDefault && l.status === 'published')?.code ?? DEFAULT_LOCALE_FALLBACK;

  const pick = (collectionSlug: string): { slug: string; data: Record<string, unknown> }[] =>
    items
      .filter((i) => i.collectionSlug === collectionSlug && i.localeCode === locale)
      .map((i) => ({ slug: i.slug, data: i.data }));

  const existing = await editorialRepo.findAll<{ id: string }>(editorialCollections.destinations);

  return {
    catalog,
    guides: pick('destination-guides').map((g) => ({
      slug: g.slug,
      data: g.data as unknown as GuideData,
    })),
    flatServices: pick('services'),
    flatGalleryServices: pick('gallery-services'),
    existingDestinationIds: existing.map((d) => d.id),
    locale,
  };
}

export interface MigrationOutcome {
  report: MigrationReport;
  written: Record<string, number>;
  reviewQueueOpen: number;
  editorialVersion: number | null;
}

/**
 * Aplica el plan. Idempotente: reejecutar con el mismo origen no duplica nada
 * ni cambia identidades. NO toca las colecciones flat de origen.
 */
export async function applyMigrationPlan(db: Db, plan: MigrationPlan): Promise<MigrationOutcome> {
  const repo = new EditorialRepo(db);
  await repo.ensureSetup();

  const sections: [string, string, Record<string, unknown>[]][] = [
    ['localities', editorialSectionCollections.localities, plan.localities],
    ['amenities', editorialSectionCollections.amenities, plan.amenities],
    ['services', editorialSectionCollections.services, plan.services],
    [
      'boarding-points',
      editorialSectionCollections['boarding-points'],
      plan.boardingPoints,
    ],
    ['destinations', editorialSectionCollections.destinations, plan.destinations],
  ];

  const written: Record<string, number> = {};

  try {
    const { editorialVersion } = await repo.withWrite(async (tx) => {
      for (const [section, collection, records] of sections) {
        let count = 0;
        for (const record of records) {
          const id = String(record['id']);
          const existing = await tx.findById<{ createdAt: Date; status: EditorialDocStatus }>(
            collection,
            id,
          );
          // Documento ya publicado: no pisar contenido editorial post-cutover.
          // La migración es para sembrar/actualizar borradores, no para
          // reescribir lo que un operador ya validó y publicó.
          if (existing?.status === 'published') continue;

          const now = new Date();
          const revision = await tx.allocateRevision();
          const status =
            existing?.status ?? plan.statuses[`${section}/${id}`] ?? ('review');
          const doc = {
            ...record,
            status,
            revision,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          if (existing === null) await tx.insertDoc(collection, doc);
          else await tx.replaceDoc(collection, id, doc);
          count += 1;
        }
        written[section] = count;
      }

      const now = new Date();
      let reviewWritten = 0;
      for (const entry of plan.reviewQueue) {
        const existing = await tx.findById<ReviewQueueDoc>(
          editorialCollections.reviewQueue,
          entry.id,
        );
        // No reabrir entradas que el operador ya resolvió.
        if (existing !== null) continue;
        await tx.upsertReviewEntry({ ...entry, createdAt: now, updatedAt: now });
        reviewWritten += 1;
      }
      written['review-queue'] = reviewWritten;

      return { result: null, wrote: true };
    });

    const open = await repo.listReviewQueue('open');
    return {
      report: plan.report,
      written,
      reviewQueueOpen: open.length,
      editorialVersion,
    };
  } catch (err) {
    if (err instanceof ContentTopologyError) throw err;
    throw err;
  }
}

/** Aviso obligatorio junto a la oferta comercial (D-G). Lo usa el seed y el front. */
export { transportServicesAlertText };
