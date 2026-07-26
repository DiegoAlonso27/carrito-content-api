import {
  blockCatalog,
  blockRefs,
  checkBlockConfig,
  checkBlockContent,
  conditionalBlockRules,
  isBlockType,
  isPublishableMedia,
  requiredBlockTypes,
} from './editorial.blocks.js';
import type { BlockType } from './editorial.blocks.js';
import type { EditorialGraph } from './editorial.repo.js';
import type {
  DestinationDoc,
  EditorialBlock,
  LocalityDoc,
  PageType,
  ServiceDoc,
} from './editorial.types.js';

/**
 * Validación de publicación (docs 02/05): se valida el DOCUMENTO COMPLETO, no
 * el bloque editado. Un bloque desconocido o inválido impide publicar el
 * documento que lo contiene, esté ese bloque habilitado o no.
 *
 * Distinción deliberada:
 * - referencia INEXISTENTE → error (integridad rota);
 * - referencia existente pero NO PUBLICADA → aviso y exclusión del snapshot.
 * Sin esa distinción, un punto de embarque con dirección sin verificar
 * bloquearía la página entera del destino, que es justo lo que P-04 evita.
 */

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  blockId?: string;
}

export interface DestinationValidation {
  destinationId: string;
  canonicalUrl: string;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  publishable: boolean;
}

export interface ValidationContext {
  graph: EditorialGraph;
  defaultLocale: string;
  /** Slugs de assets existentes (colección flat `assets`). */
  assetSlugs: Set<string>;
  /** Slugs de assets publicados y activos. */
  publishedAssetSlugs: Set<string>;
}

const error = (code: string, message: string, blockId?: string): ValidationIssue => ({
  level: 'error',
  code,
  message,
  ...(blockId === undefined ? {} : { blockId }),
});

const warning = (code: string, message: string, blockId?: string): ValidationIssue => ({
  level: 'warning',
  code,
  message,
  ...(blockId === undefined ? {} : { blockId }),
});

// ── URLs canónicas (decisión P-09) ──────────────────────────────────────────

/**
 * La URL canónica depende de `pageType`, no de `parentSlug`: un documento
 * `full` es autónomo y no cuelga de nadie; un `short` sí toma el prefijo de su
 * padre. Al promover `short → full` la URL pasa a plana y la jerárquica queda
 * como redirección permanente.
 */
export function canonicalUrlOf(
  destination: Pick<DestinationDoc, 'slug' | 'pageType' | 'parentId'>,
  parentSlug: string | null,
): string {
  if (destination.pageType === 'short' && parentSlug !== null) {
    return `/destinos/${parentSlug}/${destination.slug}`;
  }
  return `/destinos/${destination.slug}`;
}

export function hierarchicalUrlOf(slug: string, parentSlug: string | null): string {
  return parentSlug === null ? `/destinos/${slug}` : `/destinos/${parentSlug}/${slug}`;
}

// ── Validación de bloques ───────────────────────────────────────────────────

function validateBlockShape(
  block: EditorialBlock,
  pageType: PageType,
  defaultLocale: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isBlockType(block.type)) {
    issues.push(
      error('block-type-unknown', `tipo de bloque desconocido '${block.type}'`, block.id),
    );
    return issues;
  }

  const type: BlockType = block.type;
  const spec = blockCatalog[type];

  if (!spec.pageTypes.includes(pageType)) {
    issues.push(
      error(
        'block-page-type',
        `el bloque '${type}' no está permitido en un documento '${pageType}'`,
        block.id,
      ),
    );
  }

  for (const e of checkBlockConfig(type, block.config)) {
    issues.push(error('block-config-invalid', `${type}: ${e}`, block.id));
  }

  const locales = Object.keys(block.content);
  if (!locales.includes(defaultLocale)) {
    issues.push(
      error(
        'block-default-locale-missing',
        `el bloque '${type}' no tiene contenido en el locale por defecto '${defaultLocale}'`,
        block.id,
      ),
    );
  }
  for (const locale of locales) {
    for (const e of checkBlockContent(type, locale, block.content[locale])) {
      issues.push(error('block-content-invalid', `${type}: ${e}`, block.id));
    }
  }

  if (spec.pairedItems) {
    const configItems = (block.config as { items?: unknown }).items;
    const configLength = Array.isArray(configItems) ? configItems.length : -1;
    for (const locale of locales) {
      const contentItems = (block.content[locale] as { items?: unknown } | undefined)?.items;
      const contentLength = Array.isArray(contentItems) ? contentItems.length : -1;
      if (configLength !== contentLength) {
        issues.push(
          error(
            'block-items-unpaired',
            `${type}: config.items (${String(configLength)}) y content.${locale}.items ` +
              `(${String(contentLength)}) deben tener la misma longitud`,
            block.id,
          ),
        );
      }
    }
  }

  return issues;
}

function validateBlockRefs(block: EditorialBlock, ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const refs = blockRefs(block.config);

  for (const slug of refs.assets) {
    if (!ctx.assetSlugs.has(slug)) {
      issues.push(error('ref-asset-missing', `asset inexistente '${slug}'`, block.id));
    } else if (!ctx.publishedAssetSlugs.has(slug)) {
      issues.push(
        warning('ref-asset-unpublished', `asset '${slug}' no publicado: se excluye`, block.id),
      );
    }
  }

  const check = (
    ids: string[],
    docs: { id: string; status: string }[],
    kind: string,
  ): void => {
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const id of ids) {
      const found = byId.get(id);
      if (found === undefined) {
        issues.push(error(`ref-${kind}-missing`, `${kind} inexistente '${id}'`, block.id));
      } else if (found.status !== 'published') {
        issues.push(
          warning(
            `ref-${kind}-unpublished`,
            `${kind} '${id}' no publicado (${found.status}): se excluye del snapshot`,
            block.id,
          ),
        );
      }
    }
  };

  check(refs.services, ctx.graph.services, 'service');
  check(refs.boardingPoints, ctx.graph.boardingPoints, 'boarding-point');
  check(refs.destinations, ctx.graph.destinations, 'destination');

  return issues;
}

/**
 * Medios (doc 04): `alt` ausente es error — es accesibilidad y siempre está en
 * nuestra mano. Derechos sin verificar es aviso: el medio se excluye del
 * snapshot en vez de tumbar la página entera.
 */
function validateGalleryRights(block: EditorialBlock, defaultLocale: string): ValidationIssue[] {
  const items = (block.config as { items?: { rights?: unknown }[] }).items ?? [];
  const issues: ValidationIssue[] = [];
  if (block.type !== 'destination-gallery') return [];
  for (const [i, item] of items.entries()) {
    if (typeof item.rights !== 'string' || item.rights.length === 0) {
      issues.push(
        error('media-rights-missing', `galería: item ${String(i)} sin derechos`, block.id),
      );
      continue;
    }
    if (!isPublishableMedia(item.rights)) {
      issues.push(
        warning(
          'media-rights-unverified',
          `galería: item ${String(i)} con derechos sin verificar: se excluye del snapshot`,
          block.id,
        ),
      );
    }
  }
  const localeItems = (block.content[defaultLocale] as { items?: { alt?: unknown }[] } | undefined)
    ?.items;
  for (const [i, item] of (localeItems ?? []).entries()) {
    if (typeof item.alt !== 'string' || item.alt.trim().length === 0) {
      issues.push(error('media-alt-missing', `galería: item ${String(i)} sin alt`, block.id));
    }
  }
  return issues;
}

// ── Validación del documento ────────────────────────────────────────────────

export function validateDestination(
  destination: DestinationDoc,
  ctx: ValidationContext,
): DestinationValidation {
  const issues: ValidationIssue[] = [];
  const byId = new Map(ctx.graph.destinations.map((d) => [d.id, d]));
  const localityById = new Map<string, LocalityDoc>(ctx.graph.localities.map((l) => [l.id, l]));

  // Identidad y jerarquía.
  // Locality y padre deben estar publicados: buildSnapshot solo exporta el set
  // published, así que un destino "published" con refs draft rompe el snapshot.
  const locality = localityById.get(destination.localityId);
  if (locality === undefined) {
    issues.push(
      error('locality-missing', `la localidad '${destination.localityId}' no existe`),
    );
  } else if (locality.status !== 'published') {
    issues.push(
      error(
        'locality-unpublished',
        `la localidad '${locality.id}' no está publicada (${locality.status})`,
      ),
    );
  }

  let parentSlug: string | null = null;
  if (destination.parentId !== null) {
    const parent = byId.get(destination.parentId);
    if (parent === undefined) {
      issues.push(error('parent-missing', `el padre '${destination.parentId}' no existe`));
    } else {
      parentSlug = parent.slug;
      if (parent.id === destination.id) {
        issues.push(error('parent-self', 'un destino no puede ser su propio padre'));
      }
      if (parent.status !== 'published') {
        issues.push(
          error(
            'parent-unpublished',
            `el padre '${parent.id}' no está publicado (${parent.status})`,
          ),
        );
      }
      if (parent.parentId !== null) {
        // Invariante del doc 02: la profundidad editorial máxima es dos.
        issues.push(
          error(
            'depth-exceeded',
            `profundidad editorial 3: '${destination.id}' → '${parent.id}' → '${parent.parentId}'`,
          ),
        );
      }
    }
  }

  const canonicalUrl = canonicalUrlOf(destination, parentSlug);

  // Duplicidad de identidad en el espacio publicado.
  for (const other of ctx.graph.destinations) {
    if (other.id === destination.id) continue;
    if (other.slug === destination.slug) {
      issues.push(error('slug-duplicated', `el slug '${destination.slug}' ya existe en '${other.id}'`));
    }
    if (other.status !== 'published') continue;
    const otherParent = other.parentId === null ? null : (byId.get(other.parentId)?.slug ?? null);
    if (canonicalUrlOf(other, otherParent) === canonicalUrl) {
      issues.push(
        error('canonical-duplicated', `la URL canónica '${canonicalUrl}' ya la usa '${other.id}'`),
      );
    }
  }

  if (destination.redirectsFrom.includes(canonicalUrl)) {
    issues.push(
      error(
        'redirect-loop',
        `redirectsFrom contiene la propia URL canónica '${canonicalUrl}'`,
      ),
    );
  }

  // Bloques.
  const blockIds = new Set<string>();
  for (const block of destination.blocks) {
    if (blockIds.has(block.id)) {
      issues.push(error('block-id-duplicated', `id de bloque duplicado '${block.id}'`, block.id));
    }
    blockIds.add(block.id);
    issues.push(...validateBlockShape(block, destination.pageType, ctx.defaultLocale));
    issues.push(...validateBlockRefs(block, ctx));
    issues.push(...validateGalleryRights(block, ctx.defaultLocale));
  }

  const activeTypes = new Set(
    destination.blocks.filter((b) => b.enabled).map((b) => b.type),
  );
  for (const required of requiredBlockTypes) {
    if (!activeTypes.has(required)) {
      issues.push(error('block-required-missing', `falta el bloque obligatorio '${required}'`));
    }
  }
  for (const rule of conditionalBlockRules) {
    if (activeTypes.has(rule.when) && !activeTypes.has(rule.requires)) {
      issues.push(
        error(
          'block-conditional-missing',
          `el bloque '${rule.when}' exige un bloque '${rule.requires}' habilitado`,
        ),
      );
    }
  }

  // SEO (doc 07): no se publica metadata vacía en páginas indexables.
  const seo = destination.seo[ctx.defaultLocale];
  if (seo === undefined) {
    issues.push(error('seo-missing', `falta SEO en el locale por defecto '${ctx.defaultLocale}'`));
  } else if (destination.indexable) {
    if (seo.title.trim().length === 0) issues.push(error('seo-title-empty', 'SEO sin título'));
    if (seo.description.trim().length === 0) {
      issues.push(error('seo-description-empty', 'SEO sin descripción'));
    }
    if (seo.ogImageSlug !== null && !ctx.assetSlugs.has(seo.ogImageSlug)) {
      issues.push(error('seo-og-missing', `ogImageSlug inexistente '${seo.ogImageSlug}'`));
    }
  }

  // Servicios declarados a nivel de documento.
  const serviceById = new Map<string, ServiceDoc>(ctx.graph.services.map((s) => [s.id, s]));
  for (const serviceId of destination.serviceIds) {
    if (!serviceById.has(serviceId)) {
      issues.push(error('ref-service-missing', `servicio inexistente '${serviceId}'`));
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return {
    destinationId: destination.id,
    canonicalUrl,
    issues,
    errors,
    warnings,
    publishable: errors.length === 0,
  };
}

export interface ServiceValidation {
  serviceId: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  publishable: boolean;
}

export function validateService(service: ServiceDoc, ctx: ValidationContext): ServiceValidation {
  const issues: ValidationIssue[] = [];
  const amenityIds = new Set(ctx.graph.amenities.map((a) => a.id));

  for (const id of [...service.amenityIds, ...service.excludedAmenityIds]) {
    if (!amenityIds.has(id)) {
      issues.push(error('ref-amenity-missing', `comodidad inexistente '${id}'`));
    }
  }
  const overlap = service.amenityIds.filter((id) => service.excludedAmenityIds.includes(id));
  for (const id of overlap) {
    issues.push(
      error('amenity-contradiction', `'${id}' está a la vez incluida y excluida del servicio`),
    );
  }

  if (service.content[ctx.defaultLocale] === undefined) {
    issues.push(error('content-default-locale-missing', `falta contenido en '${ctx.defaultLocale}'`));
  }

  const decks = service.deckConfigurations.map((d) => d.deck);
  if (new Set(decks).size !== decks.length) {
    issues.push(error('deck-duplicated', 'hay pisos repetidos en deckConfigurations'));
  }

  if (service.heroAssetSlug !== null && !ctx.assetSlugs.has(service.heroAssetSlug)) {
    issues.push(error('ref-asset-missing', `asset inexistente '${service.heroAssetSlug}'`));
  }
  for (const [i, media] of service.gallery.entries()) {
    if (!ctx.assetSlugs.has(media.assetSlug)) {
      issues.push(error('ref-asset-missing', `galería ${String(i)}: asset '${media.assetSlug}' inexistente`));
    }
    const alt = media.alt[ctx.defaultLocale];
    if (alt === undefined || alt.trim().length === 0) {
      issues.push(error('media-alt-missing', `galería ${String(i)}: sin alt en '${ctx.defaultLocale}'`));
    }
    if (!isPublishableMedia(media.rights)) {
      issues.push(
        warning(
          'media-rights-unverified',
          `galería ${String(i)}: derechos sin verificar, se excluye del snapshot`,
        ),
      );
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  return {
    serviceId: service.id,
    errors,
    warnings: issues.filter((i) => i.level === 'warning'),
    publishable: errors.length === 0,
  };
}

/**
 * Gate de publicación de un punto de embarque (P-04/P-13): sin localidad o sin
 * dirección verificada, el documento existe pero no se publica.
 */
export function validateBoardingPoint(point: {
  id: string;
  localityId: string | null;
  addressVerified: boolean;
  isDestination: false;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (point.localityId === null) {
    issues.push(error('boarding-point-locality-missing', 'sin localidad: permanece en validación'));
  }
  if (!point.addressVerified) {
    issues.push(error('boarding-point-address-unverified', 'dirección sin verificar'));
  }
  if (point.isDestination !== false) {
    issues.push(error('boarding-point-is-destination', 'isDestination debe ser false'));
  }
  return issues;
}
