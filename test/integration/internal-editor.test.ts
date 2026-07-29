import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { importCache, validateCache } from '../../src/modules/content/content-import.js';
import type { ContentCache } from '../../src/modules/content/content.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * Editor editorial interno (`/internal/*`): interruptor, allowlist de IP, CSP de
 * la página y contrato HTTP de las tres secciones editables.
 *
 * La suite tiene dos mitades deliberadamente separadas:
 *
 * - Sin MongoDB (como `docs.test.ts`): el flag, el guard y el HTML no tocan la
 *   base, y los clientes del driver conectan de forma perezosa, así que probar
 *   esa superficie no exige levantar un mongod.
 *
 * - Con MongoDB: las escrituras del editor pasan por `setRecords`, que agrupa
 *   los documentos y el bump de `contentVersion` en una TRANSACCIÓN. Mongo solo
 *   ofrece transacciones sobre replica set (ADR-001), de ahí `MongoMemoryReplSet`
 *   en vez del `MongoMemoryServer` standalone que usan las suites de lectura.
 */

const goldenPath = fileURLToPath(new URL('../contract/golden/content-cache.json', import.meta.url));

/** TEST-NET-3 (RFC 5737): jamás enrutable, no puede colisionar con nada real. */
const OUTSIDE_IP = '203.0.113.7';

const API_ROUTES = [
  '/internal/api/texts',
  '/internal/api/pages',
  '/internal/api/settings',
] as const;
const EDITOR_ROUTES = ['/internal/edit', ...API_ROUTES] as const;

/** Envolvente editorial del documento almacenado: nunca debe salir por HTTP. */
const HIDDEN_FIELDS = ['_id', 'revision', 'createdAt', 'updatedAt'] as const;

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, string[]>;
  };
}

type EditorRecord = Record<string, unknown>;

interface ListBody {
  section: string;
  contentVersion: number;
  records: EditorRecord[];
}

interface WriteBody {
  section: string;
  contentVersion: number | null;
  results: { key: string; action: string; status: string }[];
}

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

describe('editor interno apagado (default)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(makeTestConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('INTERNAL_EDITOR_ENABLED es false sin configurarlo', () => {
    expect(app.config.INTERNAL_EDITOR_ENABLED).toBe(false);
  });

  it('no registra ninguna ruta /internal en el router', () => {
    // La barrera real no es un 404 fabricado por el guard: la ruta NO EXISTE.
    for (const url of EDITOR_ROUTES) {
      expect(app.hasRoute({ method: 'GET', url }), `GET ${url}`).toBe(false);
    }
    for (const url of API_ROUTES) {
      expect(app.hasRoute({ method: 'PUT', url }), `PUT ${url}`).toBe(false);
    }
  });

  it('responde el 404 del notFound handler estándar en GET', async () => {
    for (const url of EDITOR_ROUTES) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      const body = res.json<ErrorBody>();
      expect(body.error.code, url).toBe('NOT_FOUND');
      // Mensaje y requestId del handler central: confirma que es el 404 genérico
      // del proyecto y no una respuesta propia del editor.
      expect(body.error.message, url).toBe('Recurso no encontrado.');
      expect(body.error.requestId, url).toBeTruthy();
    }
  });

  it('responde el 404 del notFound handler estándar también en PUT', async () => {
    for (const url of API_ROUTES) {
      const res = await app.inject({
        method: 'PUT',
        url,
        payload: { expectedContentVersion: 0, records: [{ key: 'x' }] },
      });
      expect(res.statusCode, url).toBe(404);
      const body = res.json<ErrorBody>();
      expect(body.error.code, url).toBe('NOT_FOUND');
      expect(body.error.message, url).toBe('Recurso no encontrado.');
    }
  });
});

describe('editor interno encendido (allowlist vacía = solo loopback)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(makeTestConfig({ INTERNAL_EDITOR_ENABLED: 'true' }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('página /internal/edit', () => {
    it('sirve el HTML sin caché al cliente loopback', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/edit',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('declara un nonce por respuesta en la CSP y lo sustituye en el cuerpo', async () => {
      const first = await app.inject({ method: 'GET', url: '/internal/edit' });
      const second = await app.inject({ method: 'GET', url: '/internal/edit' });

      // base64 de 16 bytes: alfabeto estándar con relleno.
      const nonceOf = (res: { headers: Record<string, unknown> }): string => {
        const csp = String(res.headers['content-security-policy']);
        const match = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp);
        expect(match, csp).not.toBeNull();
        return match?.[1] ?? '';
      };

      const firstNonce = nonceOf(first);
      const secondNonce = nonceOf(second);
      expect(firstNonce.length).toBeGreaterThan(0);
      // Un nonce reutilizado entre respuestas no aporta nada frente a inyección.
      expect(secondNonce).not.toBe(firstNonce);

      // El marcador debe quedar sustituido en TODAS sus apariciones: uno sin
      // sustituir dejaría un `<script>` sin nonce (bloqueado) o, peor, un valor
      // constante y predecible.
      expect(first.body).not.toContain('__CSP_NONCE__');
      expect(second.body).not.toContain('__CSP_NONCE__');
      expect(first.body).toContain(`nonce="${firstNonce}"`);
      expect(first.body).not.toContain(secondNonce);
    });
  });

  describe('allowlist de IP del guard', () => {
    it('rechaza con 403 FORBIDDEN a un cliente fuera de la allowlist', async () => {
      for (const url of EDITOR_ROUTES) {
        const res = await app.inject({ method: 'GET', url, remoteAddress: OUTSIDE_IP });
        expect(res.statusCode, url).toBe(403);
        const body = res.json<ErrorBody>();
        expect(body.error.code, url).toBe('FORBIDDEN');
        expect(body.error.requestId, url).toBeTruthy();
      }
    });

    it('rechaza también las escrituras, antes de mirar el cuerpo', async () => {
      for (const url of API_ROUTES) {
        const res = await app.inject({
          method: 'PUT',
          url,
          remoteAddress: OUTSIDE_IP,
          // Cuerpo inválido a propósito: el guard es onRequest, así que el 403
          // debe ganar al 400 de validación.
          payload: { basura: true },
        });
        expect(res.statusCode, url).toBe(403);
        expect(res.json<ErrorBody>().error.code, url).toBe('FORBIDDEN');
      }
    });

    it('con allowlist vacía, una petición con X-Forwarded-For NO cuenta como loopback', async () => {
      // Endurecimiento anti-proxy: `trustProxy: '127.0.0.1'` hace que `req.ip`
      // salga de X-Forwarded-For, así que un proxy mal configurado presentaría a
      // cualquier cliente externo como 127.0.0.1 y le dejaría publicar contenido.
      for (const forwarded of [OUTSIDE_IP, '127.0.0.1']) {
        const res = await app.inject({
          method: 'GET',
          url: '/internal/edit',
          remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-for': forwarded },
        });
        expect(res.statusCode, forwarded).toBe(403);
        expect(res.json<ErrorBody>().error.code, forwarded).toBe('FORBIDDEN');
      }
    });

    it('sin cabecera de reenvío el mismo cliente loopback sí entra', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/edit',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    });

    it('no aplica el guard al resto de la API', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        remoteAddress: OUTSIDE_IP,
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe('editor interno con allowlist explícita', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(
      makeTestConfig({
        INTERNAL_EDITOR_ENABLED: 'true',
        INTERNAL_EDITOR_ALLOWED_IPS: `10.0.0.5, ${OUTSIDE_IP}`,
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('admite al cliente listado que llega por socket directo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/edit',
      remoteAddress: OUTSIDE_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it('admite al cliente listado que llega por el proxy loopback', async () => {
    // Con allowlist explícita manda `req.ip`: es la única forma de dejar entrar
    // a un operador que atraviesa IIS/ARR.
    const res = await app.inject({
      method: 'GET',
      url: '/internal/edit',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': OUTSIDE_IP },
    });
    expect(res.statusCode).toBe(200);
  });

  it('deja de admitir loopback implícitamente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/edit',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });
});

describe('el editor no aparece en la documentación OpenAPI', () => {
  /** Rutas públicas documentadas, con la config por defecto de las pruebas. */
  const PUBLIC_PATHS = [
    '/health/live',
    '/health/ready',
    '/v1/locales',
    '/v1/content/{locale}',
    '/v1/content/{locale}/collections/{slug}/items',
    '/v1/export/content-cache',
    '/v1/export/editorial/{locale}',
    '/v1/contact',
    '/v1/complaints',
  ];

  let app: FastifyInstance;
  let spec: OpenApiSpec;

  beforeAll(async () => {
    app = buildApp(makeTestConfig({ DOCS_ENABLED: 'true', INTERNAL_EDITOR_ENABLED: 'true' }));
    await app.ready();
    spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json<OpenApiSpec>();
  });

  afterAll(async () => {
    await app.close();
  });

  it('el spec no lista ninguna ruta /internal', () => {
    expect(Object.keys(spec.paths).filter((path) => path.startsWith('/internal'))).toEqual([]);
  });

  it('el spec sigue listando exactamente las rutas públicas', () => {
    expect(Object.keys(spec.paths).sort((a, b) => a.localeCompare(b))).toEqual(
      [...PUBLIC_PATHS].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('el spec no menciona /internal en ninguna parte', () => {
    // `hide: true` podría ocultar la ruta y dejar rastros en componentes o tags.
    expect(JSON.stringify(spec)).not.toContain('/internal');
  });
});

describe('API del editor sobre MongoDB', () => {
  let replSet: MongoMemoryReplSet;
  let app: FastifyInstance;

  beforeAll(async () => {
    const golden = validateCache(JSON.parse(await readFile(goldenPath, 'utf8')))
      .cache as ContentCache;
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    app = buildApp(
      makeTestConfig({
        INTERNAL_EDITOR_ENABLED: 'true',
        MONGO_URI: replSet.getUri(),
        // Base propia: esta suite escribe y no debe compartir estado con otras.
        MONGO_DB_CONTENT: 'carrito_content_internal_editor_test',
      }),
    );
    await importCache(app.mongo.contentDb, golden);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await replSet.stop();
  });

  /** GET de una sección, ya validado como 200. */
  async function list(path: string): Promise<ListBody> {
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode, path).toBe(200);
    return res.json<ListBody>();
  }

  async function save(path: string, expectedContentVersion: number, records: unknown[]) {
    return app.inject({ method: 'PUT', url: path, payload: { expectedContentVersion, records } });
  }

  /** El PUT rechaza `status` (campo de solo lectura): hay que quitarlo antes. */
  function withoutStatus(record: EditorRecord): EditorRecord {
    const copy = { ...record };
    delete copy['status'];
    return copy;
  }

  function findRecord(records: EditorRecord[], field: string, value: string): EditorRecord {
    const found = records.find((record) => record[field] === value);
    if (found === undefined) throw new Error(`no se encontró el registro ${field}='${value}'`);
    return found;
  }

  describe('GET de una sección', () => {
    it('devuelve section, contentVersion y records en las tres secciones', async () => {
      for (const [path, section] of [
        ['/internal/api/texts', 'texts'],
        ['/internal/api/pages', 'pages'],
        ['/internal/api/settings', 'settings'],
      ] as const) {
        const body = await list(path);
        expect(body.section, path).toBe(section);
        expect(typeof body.contentVersion, path).toBe('number');
        expect(body.records.length, path).toBeGreaterThan(0);
      }
    });

    it('no filtra la envolvente editorial y sí expone el estado', async () => {
      for (const path of API_ROUTES) {
        const res = await app.inject({ method: 'GET', url: path });
        expect(res.statusCode, path).toBe(200);

        // Sobre el JSON CRUDO: el tipado del cliente no prueba nada, un campo de
        // más viaja igual por el cable.
        for (const field of HIDDEN_FIELDS) {
          expect(res.body, `${path} ${field}`).not.toContain(`"${field}"`);
        }

        const raw = JSON.parse(res.body) as { records: EditorRecord[] };
        expect(raw.records.length, path).toBeGreaterThan(0);
        for (const record of raw.records) {
          const keys = Object.keys(record);
          for (const field of HIDDEN_FIELDS) {
            expect(keys, `${path} ${field}`).not.toContain(field);
          }
          expect(typeof record['status'], path).toBe('string');
        }
      }
    });

    it('marca la respuesta como no cacheable', async () => {
      const res = await app.inject({ method: 'GET', url: '/internal/api/texts' });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('PUT con control de versión optimista', () => {
    const TEXT_KEY = 'complaints.heading.preTitle';
    const TEXT_NATURAL_KEY = `es-PE/${TEXT_KEY}`;

    it('actualiza y publica el registro, y sube contentVersion', async () => {
      const before = await list('/internal/api/texts');
      const record = withoutStatus(findRecord(before.records, 'key', TEXT_KEY));
      const newValue = 'Libro de (editado desde el editor interno)';

      const res = await save('/internal/api/texts', before.contentVersion, [
        { ...record, value: newValue },
      ]);
      expect(res.statusCode).toBe(200);

      const body = res.json<WriteBody>();
      expect(body.section).toBe('texts');
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toEqual({
        key: TEXT_NATURAL_KEY,
        action: 'updated',
        status: 'published',
      });
      expect(body.contentVersion).toBeGreaterThan(before.contentVersion);

      const after = await list('/internal/api/texts');
      expect(findRecord(after.records, 'key', TEXT_KEY)['value']).toBe(newValue);
      expect(after.contentVersion).toBe(body.contentVersion);
    });

    it('rechaza con 409 un expectedContentVersion desactualizado sin escribir nada', async () => {
      const before = await list('/internal/api/texts');
      // La versión arranca en 1 con el import del golden, así que restar 1 da
      // siempre una versión válida (minimum: 0) y distinta de la actual.
      expect(before.contentVersion).toBeGreaterThan(0);
      const record = withoutStatus(findRecord(before.records, 'key', TEXT_KEY));
      const previousValue = record['value'];

      const res = await save('/internal/api/texts', before.contentVersion - 1, [
        { ...record, value: 'valor que no debe llegar nunca a Mongo' },
      ]);
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('CONTENT_VERSION_CONFLICT');

      const after = await list('/internal/api/texts');
      expect(findRecord(after.records, 'key', TEXT_KEY)['value']).toBe(previousValue);
      expect(after.contentVersion).toBe(before.contentVersion);
    });
  });

  describe('alta de un registro nuevo (botón «Nuevo registro»)', () => {
    // `settings` es la sección sin dependencias de referencia (ni locale ni
    // assets): aísla la rama de creación de `setRecords` sin arrastrar el
    // preflight de otras secciones.
    const NEW_KEY = 'editor.interno.alta';
    const NEW_RECORD = {
      key: NEW_KEY,
      value: 'valor dado de alta por el editor interno',
      valueType: 'string',
      description: 'registro creado desde /internal/edit',
      isActive: true,
      sortOrder: 990,
    };

    it('crea la clave inexistente y la publica en el mismo guardado', async () => {
      const before = await list('/internal/api/settings');
      expect(before.records.some((record) => record['key'] === NEW_KEY)).toBe(false);

      const res = await save('/internal/api/settings', before.contentVersion, [NEW_RECORD]);
      expect(res.statusCode).toBe(200);

      const body = res.json<WriteBody>();
      // `publish: true` de la ruta: el alta nace publicada, no en draft como en
      // los CLI (que publican en un segundo paso).
      expect(body.results).toEqual([{ key: NEW_KEY, action: 'created', status: 'published' }]);
      expect(body.contentVersion).toBeGreaterThan(before.contentVersion);

      const after = await list('/internal/api/settings');
      expect(after.contentVersion).toBe(body.contentVersion);
      const created = findRecord(after.records, 'key', NEW_KEY);
      expect(created).toEqual({ ...NEW_RECORD, status: 'published' });

      // Reenviar el mismo alta (misma prueba para no depender del orden entre
      // tests): ya no crea nada y sin escritura efectiva no hay versión nueva.
      const again = await save('/internal/api/settings', after.contentVersion, [NEW_RECORD]);
      expect(again.statusCode).toBe(200);
      const repeated = again.json<WriteBody>();
      expect(repeated.results[0]?.action).toBe('unchanged');
      expect(repeated.contentVersion).toBeNull();
      expect((await list('/internal/api/settings')).contentVersion).toBe(after.contentVersion);
    });
  });

  describe('validación del cuerpo del PUT', () => {
    /** Registro válido de `settings`, base para las variantes inválidas. */
    async function settingBase(): Promise<{ version: number; record: EditorRecord }> {
      const before = await list('/internal/api/settings');
      const record = withoutStatus(findRecord(before.records, 'key', 'brand.color.primary'));
      return { version: before.contentVersion, record };
    }

    it('rechaza con 400 un campo del tipo equivocado (sortOrder como string)', async () => {
      const { version, record } = await settingBase();
      const res = await save('/internal/api/settings', version, [{ ...record, sortOrder: '20' }]);
      expect(res.statusCode).toBe(400);

      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // El detalle campo a campo viene de TypeBox dentro de `setRecords`.
      expect(body.error.details).toHaveProperty('records');

      const after = await list('/internal/api/settings');
      expect(after.contentVersion).toBe(version);
    });

    it('rechaza con 400 un campo desconocido', async () => {
      const { version, record } = await settingBase();
      const res = await save('/internal/api/settings', version, [
        { ...record, campoInventado: 'x' },
      ]);
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');

      const after = await list('/internal/api/settings');
      expect(after.contentVersion).toBe(version);
    });

    it('rechaza con 400 un lote vacío (minItems: 1)', async () => {
      const { version } = await settingBase();
      const res = await save('/internal/api/settings', version, []);
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
    });

    it('rechaza con 400 un cuerpo sin expectedContentVersion', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/internal/api/settings',
        payload: { records: [{ key: 'x' }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('regresión: los nullables de pages no se coercionan a cadena vacía', () => {
    const PAGE_SLUG = 'contactanos';
    const NULLABLE_FIELDS = ['metaTitle', 'metaDescription', 'ogImageSlug'] as const;

    it('un PUT con los tres campos en null los guarda y devuelve como null', async () => {
      const before = await list('/internal/api/pages');
      const page = withoutStatus(findRecord(before.records, 'slug', PAGE_SLUG));
      // Partir de valores NO nulos: si ya fueran null el PUT sería `unchanged` y
      // la coerción (null → '') no llegaría a ejercitarse.
      for (const field of NULLABLE_FIELDS) {
        expect(page[field], field).toBeTypeOf('string');
      }

      const res = await save('/internal/api/pages', before.contentVersion, [
        { ...page, metaTitle: null, metaDescription: null, ogImageSlug: null },
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json<WriteBody>().results[0]?.action).toBe('updated');

      const after = await app.inject({ method: 'GET', url: '/internal/api/pages' });
      expect(after.statusCode).toBe(200);
      // Comprobación sobre el cable: `""` y `null` no se distinguen a ojo en un
      // objeto ya deserializado si algo los normalizó por el camino.
      expect(after.body).toContain('"metaTitle":null');

      const raw = JSON.parse(after.body) as { records: EditorRecord[] };
      const stored = findRecord(raw.records, 'slug', PAGE_SLUG);
      for (const field of NULLABLE_FIELDS) {
        expect(stored[field], field).toBeNull();
        expect(stored[field], field).not.toBe('');
      }
    });
  });
});
