import { describe, expect, it } from 'vitest';
import {
  blocksFromCatalogOnly,
  blocksFromGuide,
  buildMigrationPlan,
  serviceSeeds,
} from '../../src/modules/editorial/editorial-migrate.js';
import type { MigrationInput } from '../../src/modules/editorial/editorial-migrate.js';
import { parseAnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import type { CatalogDestination } from '../../src/modules/editorial/editorial.catalog.js';

const LOCALE = 'es-PE';

const chiclayo: CatalogDestination = {
  id: 'chiclayo',
  name: 'Chiclayo',
  slug: 'chiclayo',
  pageType: 'full',
  parentSlug: null,
  localityType: 'city',
  department: 'Lambayeque',
  province: 'Chiclayo',
  district: 'Chiclayo',
  catalogUrl: '/destinos/chiclayo',
  canonicalUrl: '/destinos/chiclayo',
  redirectsFrom: [],
  disposition: 'A-publishable',
  initialStatus: 'review',
  showInMainGrid: true,
  order: 10,
  blockingValidations: [],
  advisoryNotes: [],
};

const naranjos: CatalogDestination = {
  id: 'naranjos',
  name: 'Naranjos',
  slug: 'naranjos',
  pageType: 'short',
  parentSlug: 'tarapoto',
  localityType: 'town',
  department: 'San Martín',
  province: 'Rioja',
  district: 'Pardo Miguel',
  catalogUrl: '/destinos/tarapoto/naranjos',
  canonicalUrl: '/destinos/tarapoto/naranjos',
  redirectsFrom: [],
  disposition: 'A-publishable',
  initialStatus: 'review',
  showInMainGrid: true,
  order: 370,
  blockingValidations: [],
  advisoryNotes: [],
};

const tarapoto: CatalogDestination = {
  ...chiclayo,
  id: 'tarapoto',
  name: 'Tarapoto',
  slug: 'tarapoto',
  department: 'San Martín',
  province: 'San Martín',
  district: 'Tarapoto',
  catalogUrl: '/destinos/tarapoto',
  canonicalUrl: '/destinos/tarapoto',
  order: 90,
};

const guide = {
  title: 'Chiclayo',
  region: 'Lambayeque',
  imageAsset: 'banner-inicio',
  population: '600K+',
  altitude: '27 msnm',
  temperature: '24°C',
  description: 'Ciudad de la Amistad.',
  history: 'Fundada en 1835.',
  gastronomy: 'Arroz con pato.',
  festivities: 'Fiesta de la Virgen de la Paz.',
  gallery: [{ imageAsset: 'banner-inicio' }, { imageAsset: 'destino-lima' }],
  attractions: [
    {
      name: 'Museo Tumbas Reales',
      description: 'Tesoros del Señor de Sipán.',
      imageAsset: 'banner-inicio',
      duration: '2-3 horas',
      distance: '30 km',
    },
  ],
  bestTime: 'Abril a Diciembre',
  bestTimeDetail: 'Temporada seca.',
  duration: '3-4 días',
  durationDetail: 'Sin prisas.',
  howToArrive: 'Bus o avión',
  howToArriveDetail: 'Buses nocturnos.',
  tips: [{ icon: '☀️', title: 'Sol', description: 'Lleva bloqueador.' }],
  services: ['Terminal terrestre moderno', 'Hoteles y restaurantes'],
};

function input(overrides: Partial<MigrationInput> = {}): MigrationInput {
  return {
    catalog: {
      destinations: [chiclayo, tarapoto, naranjos],
      boardingPoints: [
        {
          id: 'plaza-norte',
          name: 'Terminal Plaza Norte',
          slug: 'plaza-norte',
          localitySlug: 'lima',
          isDestination: false,
          capabilities: ['boarding', 'disembarking'],
          addressVerified: false,
          blockingValidations: ['Confirmar la dirección oficial antes de publicar.'],
        },
      ],
      derivedBoardingPoints: [],
    },
    guides: [{ slug: 'chiclayo', data: guide }],
    flatServices: [
      { slug: 'panoramico', data: { title: 'Panorámico', imageAsset: 'service-bus' } },
      { slug: 'economico', data: { title: 'Económico', imageAsset: 'service-bus' } },
      { slug: 'bus-cama-vip', data: { title: 'Bus Cama VIP', imageAsset: 'service-bus' } },
    ],
    flatGalleryServices: [{ slug: 'gallery-01', data: { imageAsset: 'gallery-01' } }],
    existingDestinationIds: [],
    locale: LOCALE,
    ...overrides,
  };
}

describe('mapeo de guía flat a bloques', () => {
  const blocks = blocksFromGuide('chiclayo', guide, LOCALE);
  const types = blocks.map((b) => b.type);

  it('produce la composición completa de un destino full', () => {
    expect(types).toEqual([
      'destination-hero',
      'destination-overview',
      'destination-location',
      'destination-rich-text',
      'destination-rich-text',
      'destination-rich-text',
      'destination-gallery',
      'destination-attractions',
      'destination-practical-info',
      'destination-tips',
      'city-services',
    ]);
  });

  it('los ids de bloque son deterministas: reejecutar no cambia identidades', () => {
    const again = blocksFromGuide('chiclayo', guide, LOCALE);
    expect(again.map((b) => b.id)).toEqual(blocks.map((b) => b.id));
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  it('los servicios de la guía van a city-services, nunca a transport-services', () => {
    expect(types).toContain('city-services');
    expect(types).not.toContain('transport-services');
    const city = blocks.find((b) => b.type === 'city-services');
    const items = (city?.content[LOCALE] as { items: { name: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(guide.services);
  });

  it('el HTML del rich-text va escapado, sin etiquetas del origen', () => {
    const rich = blocks.find((b) => b.type === 'destination-rich-text');
    expect((rich?.content[LOCALE] as { bodyHtml: string }).bodyHtml).toBe(
      '<p>Fundada en 1835.</p>',
    );
  });

  it('la galería heredada entra con derechos sin verificar y alt generado', () => {
    const gallery = blocks.find((b) => b.type === 'destination-gallery');
    const config = gallery?.config as { items: { rights: string }[] };
    const content = gallery?.content[LOCALE] as { items: { alt: string }[] };
    expect(config.items.every((i) => i.rights === 'unverified')).toBe(true);
    expect(content.items).toHaveLength(config.items.length);
    expect(content.items[0]?.alt).toBe('Chiclayo: imagen 1');
  });
});

describe('destino sin guía', () => {
  it('recibe solo hero, overview y location con una frase geográfica factual', () => {
    const blocks = blocksFromCatalogOnly(naranjos, LOCALE);
    expect(blocks.map((b) => b.type)).toEqual([
      'destination-hero',
      'destination-overview',
      'destination-location',
    ]);
    const summary = (blocks[1]?.content[LOCALE] as { summary: string }).summary;
    expect(summary).toBe(
      'Naranjos es una localidad de la provincia de Rioja, en el departamento de ' +
        'San Martín, distrito de Pardo Miguel.',
    );
  });
});

describe('plan de migración', () => {
  const plan = buildMigrationPlan(input());

  it('crea una localidad por destino del catálogo', () => {
    expect(plan.localities).toHaveLength(3);
    expect(plan.localities.map((l) => l.id).sort()).toEqual(['chiclayo', 'naranjos', 'tarapoto']);
  });

  it('no publica nada: todo entra en review o draft', () => {
    const values = new Set(Object.values(plan.statuses));
    expect(values.has('published')).toBe(false);
    expect(plan.statuses['destinations/chiclayo']).toBe('review');
    expect(plan.statuses['boarding-points/plaza-norte']).toBe('draft');
  });

  it('solo el destino con guía queda indexable', () => {
    const byId = new Map(plan.destinations.map((d) => [d.id, d]));
    expect(byId.get('chiclayo')?.indexable).toBe(true);
    expect(byId.get('naranjos')?.indexable).toBe(false);
    expect(plan.report.destinationsFromGuide).toEqual(['chiclayo']);
    expect(plan.report.destinationsGenerated.sort()).toEqual(['naranjos', 'tarapoto']);
  });

  it('resuelve parentId por slug y conserva el redirect legado', () => {
    const naranjosDoc = plan.destinations.find((d) => d.id === 'naranjos');
    expect(naranjosDoc?.parentId).toBe('tarapoto');
    expect(naranjosDoc?.redirectsFrom).toContain('/destino/naranjos');
  });

  it('crea los tres servicios aprobados con la configuración confirmada del §6', () => {
    expect(plan.services.map((s) => s.id)).toEqual(['bus-normal', 'bus-cama', 'bus-cama-vip']);
    const vip = plan.services.find((s) => s.id === 'bus-cama-vip');
    expect(vip?.deckConfigurations).toEqual([
      { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
      { deck: 2, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
    ]);
    // Único traspaso 1:1 aprobado (D-F): el VIP conserva la imagen flat.
    expect(vip?.heroAssetSlug).toBe('service-bus');
    expect(plan.services.find((s) => s.id === 'bus-normal')?.heroAssetSlug).toBeNull();
  });

  it('no publica comodidades pendientes y sí registra las ausencias confirmadas', () => {
    const normal = plan.services.find((s) => s.id === 'bus-normal');
    expect(normal?.amenityIds).toEqual(['cortinas']);
    expect(normal?.excludedAmenityIds).toEqual(['wifi']);
    for (const seed of serviceSeeds) {
      expect(seed.amenityIds).not.toContain('aire-acondicionado');
      expect(seed.amenityIds).not.toContain('banio');
    }
  });

  it('manda a la cola de revisión los servicios flat fuera de la oferta y los medios huérfanos', () => {
    const keys = plan.report.unclassified.map((u) => u.sourceKey);
    expect(keys).toContain('services/panoramico');
    expect(keys).toContain('services/economico');
    expect(keys).toContain('gallery-services/gallery-01');
    expect(keys).not.toContain('services/bus-cama-vip');
  });

  it('reporta la deriva entre catálogo y base', () => {
    const withExtra = buildMigrationPlan(input({ existingDestinationIds: ['chiclayo', 'fantasma'] }));
    expect(withExtra.report.drift.onlyInDatabase).toEqual(['fantasma']);
    expect(withExtra.report.drift.onlyInCatalog.sort()).toEqual(['naranjos', 'tarapoto']);
  });
});

describe('catálogo anotado', () => {
  it('rechaza un parentSlug que no está en el catálogo', () => {
    const { catalog, errors } = parseAnnotatedCatalog({
      destinations: [{ ...naranjos, parentSlug: 'inexistente' }],
      boardingPoints: [],
      derivedBoardingPoints: [],
    });
    expect(catalog).toBeNull();
    expect(errors[0]).toContain('inexistente');
  });

  it('rechaza un catálogo con destinos duplicados', () => {
    const { catalog, errors } = parseAnnotatedCatalog({
      destinations: [chiclayo, chiclayo],
      boardingPoints: [],
      derivedBoardingPoints: [],
    });
    expect(catalog).toBeNull();
    expect(errors[0]).toContain('duplicado');
  });
});
