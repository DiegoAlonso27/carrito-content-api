# Contrato HTTP de la API

Contrato público de `carrito-content-api` bajo `/v1` y endpoints operativos de
health. Los response schemas de Fastify son la barrera anti-fuga: MongoDB nunca
sale crudo, no se expone `_id` y las respuestas no incluyen campos no
declarados.

Todas las respuestas incluyen el header `x-request-id` para correlación. Las
fechas se expresan en ISO 8601 UTC.

Este documento es el contrato narrativo: reglas de negocio, decisiones y
matices operativos. La API además publica un **OpenAPI 3.1 generado desde los
mismos schemas TypeBox** que validan y serializan en runtime, explorable con
Swagger UI en `/docs` (spec en `/docs/json` y `/docs/yaml`). Está habilitado
solo en `development` salvo que `DOCS_ENABLED=true` lo fuerce; en producción,
además, `/docs*` exige una IP permitida (ver runbook y ADR-009).
Ante una discrepancia, el spec refleja el comportamiento real y este documento
explica el porqué.

## Superficies y acceso

| Método y ruta                                     | Acceso                            | Éxito        | Uso                                      |
| ------------------------------------------------- | --------------------------------- | ------------ | ---------------------------------------- |
| `GET /health/live`                                | Operativo, sin credencial         | `200`        | Vida del proceso; no toca MongoDB.       |
| `GET /health/ready`                               | Operativo, sin credencial         | `200`        | Disponibilidad de ambas bases MongoDB.   |
| `GET /v1/locales`                                 | Público                           | `200`, `304` | Locales publicados.                      |
| `GET /v1/content/:locale`                         | Público                           | `200`, `304` | Bundle runtime por locale.               |
| `GET /v1/content/:locale/collections/:slug/items` | Público                           | `200`, `304` | Items de una colección.                  |
| `GET /v1/export/content-cache`                    | Protegido servidor-a-servidor     | `200`, `304` | Cache de build compatible con el golden. |
| `POST /v1/contact`                                | Público si el feature está activo | `201`, `200` | Alta idempotente de contacto.            |
| `POST /v1/complaints`                             | Público, bloqueado por defecto    | `503`        | Gate del Libro de Reclamaciones.         |

No hay rutas administrativas de escritura. La edición y publicación de
contenido se realizan mediante CLIs privilegiados en `scripts/content/`.

## Envolvente de error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Datos inválidos.",
    "requestId": "identificador-de-correlacion",
    "details": {
      "campo": ["descripción del problema"]
    }
  }
}
```

`details` es opcional. Nunca se devuelven stacks, nombres internos de
colecciones, credenciales ni detalles de infraestructura.

| HTTP  | Código estable           | Significado                                                  |
| ----- | ------------------------ | ------------------------------------------------------------ |
| `400` | `VALIDATION_ERROR`       | Forma o regla de negocio inválida.                           |
| `401` | `UNAUTHORIZED`           | Credencial de export ausente o inválida.                     |
| `403` | `FORBIDDEN`              | Acceso denegado por una capa HTTP.                           |
| `404` | `NOT_FOUND`              | Ruta, locale o colección no encontrados.                     |
| `405` | `METHOD_NOT_ALLOWED`     | Método no permitido cuando la capa HTTP lo reporta como 405. |
| `413` | `PAYLOAD_TOO_LARGE`      | Body, firma o adjuntos demasiado grandes.                    |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Tipo de contenido no soportado.                              |
| `429` | `RATE_LIMITED`           | Presupuesto de la ruta agotado; incluye `Retry-After`.       |
| `500` | `INTERNAL_ERROR`         | Fallo interno sanitizado.                                    |
| `503` | `SERVICE_NOT_READY`      | Readiness falló.                                             |
| `503` | `COMPLAINTS_DISABLED`    | Libro bloqueado por el gate de fase.                         |

## Health checks

### `GET /health/live`

Respuesta `200`:

```json
{ "status": "ok" }
```

No consulta dependencias. Que liveness esté en verde no implica que la API
pueda atender contenido o formularios.

### `GET /health/ready`

Ejecuta `ping` sobre `MONGO_DB_CONTENT` y `MONGO_DB_FORMS`. Comprueba ambas
bases aunque contacto y reclamos estén desactivados.

- `200`: `{ "status": "ok" }`.
- `503 SERVICE_NOT_READY`: alguna base no responde; no identifica cuál en la
  respuesta pública.

## Lectura pública de contenido

Las rutas públicas aplican `RATE_LIMIT_READ_PER_MINUTE`. Las respuestas `200`
incluyen:

- `etag: "content-v<n>"`;
- `cache-control: public, max-age=300, stale-while-revalidate=3600`.

Enviar `If-None-Match` con el ETag vigente devuelve `304` sin body.

### `GET /v1/locales`

Devuelve `{ locales: [...] }`. Solo lista locales `published`; la forma de cada
locale es `code`, `name`, `isDefault`, `isActive` y `sortOrder`.

### `GET /v1/content/:locale`

Devuelve:

- `locale` solicitado;
- `contentVersion` numérico;
- `settings`, `assets`, `collections`, `pages`, `texts` e `items` publicados.

Los items no incluyen `rowVersionToken`. Un locale inexistente o no atendible
devuelve `404 NOT_FOUND`. Para un locale distinto del default, la API completa
claves ausentes con el documento del locale default y conserva en cada
documento el `localeCode` de su origen.

### `GET /v1/content/:locale/collections/:slug/items`

Devuelve `{ items: [...] }` con los items publicados de la colección. Locale o
colección inexistentes devuelven `404 NOT_FOUND`.

## Export protegido de build

### `GET /v1/export/content-cache`

Headers de request:

- `X-Export-Key`: obligatorio; se compara de forma timing-safe contra una o
  dos claves de `EXPORT_API_KEYS`.
- `If-None-Match`: opcional para descarga condicional.

La clave se usa únicamente en un proceso de build seguro. Jamás debe viajar al
navegador, quedar en código cliente o almacenarse en una variable
`NUXT_PUBLIC_*`.

Sin claves configuradas, el endpoint permanece deshabilitado y responde
`401 UNAUTHORIZED` incluso si el cliente envía un header.

El `200` respeta este orden de secciones:

1. `generatedAtUtc`;
2. `locales`;
3. `settings`;
4. `pages`;
5. `texts`;
6. `assets`;
7. `collections`;
8. `items`;
9. `versionTokens`.

El response schema es `contentCacheSchema`. El test F2 demuestra igualdad con
el golden inicial en datos, orden de claves, orden de arrays y tokens,
normalizando únicamente `generatedAtUtc`.

La respuesta incluye un ETag fuerte derivado de `contentVersion` y
`cache-control: no-cache`. La autenticación se exige también para obtener un
`304`.

## Formulario de contacto

### `POST /v1/contact`

Disponible cuando `FEATURE_CONTACT_ENABLED=true`. Si el kill-switch está en
`false`, la ruta no se registra y responde `404 NOT_FOUND`.

Body JSON:

| Campo             | Regla                                                       |
| ----------------- | ----------------------------------------------------------- |
| `submissionId`    | UUID v4; clave de idempotencia.                             |
| `nombreApellidos` | 3–200 caracteres, sin controles.                            |
| `correo`          | Email de hasta 254 caracteres.                              |
| `telefono`        | Separadores visuales permitidos; se persisten 6–15 dígitos. |
| `dni`             | 8–12 caracteres alfanuméricos.                              |
| `mensaje`         | 10–2000 caracteres; admite saltos de línea.                 |
| `aceptaTerminos`  | Debe ser `true`.                                            |
| `website`         | Honeypot opcional.                                          |

Los strings se recortan antes de validar. Un honeypot con contenido responde
éxito falso sin persistir ni registrar el envío.

- `201`: alta nueva.
- `200`: reintento del mismo `submissionId`; devuelve el mismo registro.
- Body de éxito: únicamente `id`, `receivedAtUtc` e `isViewed`.

El body máximo es 32 KiB. El rate limit se configura con
`RATE_LIMIT_CONTACT_MAX` y `RATE_LIMIT_CONTACT_WINDOW_MINUTES`.

Los datos se guardan exclusivamente en `carrito_forms.contact_messages`. La
API no persiste IP ni User-Agent y no devuelve el contenido enviado.

## Libro de Reclamaciones

### Estado por defecto

`FEATURE_COMPLAINTS_ENABLED=false` y
`COMPLAINTS_LEGAL_GATE_CLEARED=false` permanecen obligatoriamente sin cambios
hasta cerrar P1–P18 y recibir autorización expresa.

Con el gate cerrado:

- una solicitud que llega al handler responde `503 COMPLAINTS_DISABLED` sin
  tocar MongoDB;
- un request `multipart/form-data` puede ser rechazado antes con
  `415 UNSUPPORTED_MEDIA_TYPE`, porque el parser multipart no se registra
  mientras el gate está apagado.

### Contrato reservado para una activación futura autorizada

El request es `multipart/form-data` con:

- `payload`: JSON con `submissionId`, consumidor, apoderado opcional, servicio,
  detalle y `confirmation: true`;
- `consumerSignaturePng`: firma PNG obligatoria;
- `files`: cero o más adjuntos según límites configurados;
- `website`: honeypot opcional, aceptado también dentro de `payload`.

La constancia `201`/`200` contiene código, fechas, estado, snapshot del
proveedor, hoja, hashes de firma/adjuntos y estado del correo. No contiene
`_id`, binarios ni detalles internos. Como la constancia refleja datos de la
hoja al mismo remitente, el consumidor no debe registrarla en consola ni
telemetría cliente.

La API nunca incluye la firma o adjuntos en logs, DTOs o correo. Tampoco guarda
IP/User-Agent. Con el gate cerrado no deben enviarse reclamos ni probarse este
contrato desde una UI pública.

## CORS y separación de consumidores

`CORS_ORIGINS` admite únicamente orígenes HTTP(S) exactos. El export es
servidor-a-servidor y no depende de CORS para su seguridad. Los endpoints
públicos de contenido y formularios sí requieren el origen real del front si
se consumen desde el navegador.

La API de contenido no acepta ni necesita el bearer del sistema de ventas. Un
cliente frontal dedicado debe evitar enviar ese header a estas rutas.
