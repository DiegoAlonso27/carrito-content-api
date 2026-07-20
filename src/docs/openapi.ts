import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from '../shared/config/env.js';
import { ErrorCodes } from '../shared/errors/app-error.js';
import { EXPORT_KEY_SECURITY_SCHEME } from '../shared/docs/openapi-annotations.js';
import {
  complaintMultipartDocSchema,
  complaintPayloadDocSchema,
} from '../modules/complaints/complaints.schemas.js';

/**
 * Documentación OpenAPI 3.1 generada desde los `schema` TypeBox ya declarados
 * en las rutas: el spec no es un contrato paralelo, es una proyección del que
 * ya valida y serializa en runtime. `docs/api-contract.md` sigue siendo el
 * contrato narrativo (reglas de negocio, decisiones y matices operativos).
 *
 * Exposición gobernada por `DOCS_ENABLED` (resuelto en `config.DOCS_UI_ENABLED`):
 * fuera de development queda apagada salvo decisión explícita. Con las docs
 * apagadas no se registra ninguna ruta: `/docs` cae en el notFound handler
 * estándar (404 con la envolvente del proyecto), sin revelar que existen.
 */

export const DOCS_ROUTE_PREFIX = '/docs';

/**
 * Nombre del componente que publica la forma de la hoja del reclamo. Se
 * registra como schema compartido de Fastify: @fastify/swagger vuelca todos los
 * schemas compartidos en `components.schemas` usando su `$id` como clave.
 */
const COMPLAINT_PAYLOAD_COMPONENT = 'ComplaintPayload';

const TAGS = [
  {
    name: 'health',
    description:
      'Sondas operativas sin versionar ni credencial. IIS/ARR y el monitoreo ' +
      'deben apuntar a readiness, no a liveness.',
  },
  {
    name: 'content',
    description:
      'Lectura pública del contenido editorial publicado. Rate limit por IP, ' +
      'ETag por `contentVersion` y `304` con `If-None-Match`.',
  },
  {
    name: 'export',
    description:
      'Export servidor-a-servidor del cache de build. Autenticado con ' +
      '`X-Export-Key`; jamás debe consumirse desde el navegador.',
  },
  {
    name: 'contact',
    description: 'Formulario de contacto público, idempotente por `submissionId`.',
  },
  {
    name: 'complaints',
    description:
      'Libro de Reclamaciones (Perú). Bloqueado por gate de fase: responde ' +
      '`503 COMPLAINTS_DISABLED` mientras `FEATURE_COMPLAINTS_ENABLED=false`.',
  },
];

const DESCRIPTION = [
  'API de contenido editorial, export de build y formularios para `carrito-front`.',
  '',
  'Contrato narrativo completo (reglas de negocio, límites y decisiones): ' +
    '`docs/api-contract.md` del repositorio. Este documento es su proyección ' +
    'mecánica: todos los schemas salen de los `schema` TypeBox que la API usa ' +
    'para validar y serializar, así que no pueden desviarse del comportamiento real.',
  '',
  '### Envolvente de error',
  '',
  'Toda respuesta de error usa la misma forma, sin stacks ni detalles internos:',
  '',
  '```json',
  '{ "error": { "code": "VALIDATION_ERROR", "message": "Datos inválidos.", ' +
    '"requestId": "…", "details": { "campo": ["…"] } } }',
  '```',
  '',
  '`details` es opcional. Los códigos (`VALIDATION_ERROR`, `UNAUTHORIZED`, ' +
    '`NOT_FOUND`, `RATE_LIMITED`, `SERVICE_NOT_READY`, `COMPLAINTS_DISABLED`, ' +
    '`INTERNAL_ERROR`, …) son estables y forman parte del contrato.',
  '',
  '### Correlación',
  '',
  'Toda respuesta incluye `x-request-id`, el mismo valor que `error.requestId` ' +
    'y que el campo del log. Las fechas son ISO 8601 UTC.',
  '',
  '### Superficie de escritura',
  '',
  '**No hay rutas administrativas de escritura.** La edición y publicación de ' +
    'contenido se hacen con CLIs privilegiados de `scripts/content/`, fuera de ' +
    'la superficie HTTP y sin exposición de red.',
].join('\n');

/**
 * Registra el spec y la UI. No hace nada si las docs están apagadas: la
 * decisión de exponerlas es del bootstrap, no de este módulo.
 */
export function registerOpenApiDocs(app: FastifyInstance, config: AppConfig): void {
  // Publica la forma DOCUMENTAL del payload (incluye el honeypot `website`, que
  // la API acepta dentro del JSON). Ninguna ruta la referencia para validar —el
  // multipart se valida a mano contra `complaintPayloadSchema`—, así que
  // registrarla no instala validación ni cambia el comportamiento.
  app.addSchema({ $id: COMPLAINT_PAYLOAD_COMPONENT, ...complaintPayloadDocSchema });

  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'carrito-content-api',
        description: DESCRIPTION,
        version: '0.1.0',
      },
      servers: [{ url: `http://${config.HOST}:${String(config.PORT)}`, description: 'Local' }],
      tags: TAGS,
      components: {
        securitySchemes: {
          [EXPORT_KEY_SECURITY_SCHEME]: {
            type: 'apiKey',
            // En minúsculas a propósito: @fastify/swagger omite de `parameters`
            // los headers que ya cubre un security scheme comparando el nombre
            // literal, y la ruta los declara en minúsculas (Fastify normaliza).
            // Con otra grafía, la credencial aparecería DOS veces en la UI: como
            // «Authorize» y como parámetro suelto. Los headers HTTP son
            // insensibles a mayúsculas; la prosa usa `X-Export-Key`.
            name: 'x-export-key',
            in: 'header',
            description:
              'Clave del export servidor-a-servidor, comparada de forma timing-safe ' +
              'contra `EXPORT_API_KEYS` (hasta dos claves activas para rotar sin corte). ' +
              'Se usa solo desde un proceso de build seguro: nunca debe viajar al ' +
              'navegador, quedar en código cliente ni almacenarse en variables ' +
              '`NUXT_PUBLIC_*`. Sin claves configuradas el endpoint queda deshabilitado ' +
              'y responde `401` aunque se envíe el header.',
          },
        },
      },
    },
    // Sin esto los schemas compartidos se publican como `def-0`, `def-1`…:
    // el nombre del componente debe ser estable y legible (`ComplaintPayload`),
    // porque forma parte de lo que se referencia desde el spec.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' && json.$id.length > 0 ? json.$id : `def-${String(i)}`,
    },
    transform: ({ schema, url, route }) => {
      if (!isComplaintsIntake(url, route.method, config)) return { schema, url };
      // El alta de reclamos parsea el multipart a mano: el cuerpo solo puede
      // describirse aquí, en generación de spec, sin instalar un validador.
      return {
        schema: {
          ...schema,
          consumes: ['multipart/form-data'],
          body: complaintMultipartDocSchema,
        },
        url,
      };
    },
  });

  // La UI y el spec viven en un scope propio para que el guard de producción
  // aplique SOLO a ellos: swagger-ui está envuelto en fastify-plugin, así que
  // sus rutas se registran dentro de este scope y heredan su hook onRequest.
  void app.register((scope, _opts, done) => {
    if (config.NODE_ENV === 'production') {
      scope.addHook('onRequest', (req, reply, next) => {
        if (isDocsClientAllowed(req.ip, config.DOCS_ALLOWED_IPS_LIST)) {
          next();
          return;
        }
        // 404 y no 403: para un cliente no autorizado la documentación
        // simplemente no existe, igual que con DOCS_ENABLED=false.
        req.log.warn({ url: req.url }, 'acceso a /docs bloqueado por allowlist');
        void reply.status(404).send({
          error: {
            code: ErrorCodes.notFound,
            message: 'Recurso no encontrado.',
            requestId: req.id,
          },
        });
      });
    }

    void scope.register(swaggerUi, {
      routePrefix: DOCS_ROUTE_PREFIX,
      // La UI publica su propia CSP en un hook onSend encapsulado en su prefijo:
      // sobrescribe la de @fastify/helmet SOLO en estas rutas y deja intacta la
      // del resto de la API. Sin esto, la CSP por defecto de helmet rompe la UI.
      staticCSP: true,
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
        // «Try it out» ejecuta llamadas REALES (POST /v1/contact persiste). Se
        // permite solo en development: si alguien fuerza DOCS_ENABLED=true en un
        // entorno con datos reales, la UI queda de lectura.
        supportedSubmitMethods: config.NODE_ENV === 'development' ? ['get', 'post'] : [],
      },
    });

    done();
  });
}

/**
 * Loopback en todas sus formas, incluida la IPv4 mapeada sobre IPv6 que expone
 * Node cuando el socket escucha en dualstack.
 */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Allowlist vacía = solo loopback (default deliberadamente restrictivo). */
function isDocsClientAllowed(ip: string, allowed: readonly string[]): boolean {
  return allowed.length > 0 ? allowed.includes(ip) : LOOPBACK_IPS.has(ip);
}

function isComplaintsIntake(url: string, method: string | string[], config: AppConfig): boolean {
  // Con el gate cerrado la ruta registrada es el 503 sin cuerpo: documentar un
  // requestBody multipart ahí describiría un contrato que la API no acepta.
  if (!config.FEATURE_COMPLAINTS_ENABLED) return false;
  if (url !== '/v1/complaints') return false;
  return Array.isArray(method) ? method.includes('POST') : method === 'POST';
}
