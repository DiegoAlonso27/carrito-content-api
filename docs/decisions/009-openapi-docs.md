# ADR-009: Documentación OpenAPI 3.1 con Swagger UI

**Estado:** aceptado  
**Fecha:** 2026-07-20  
**Fases:** posterior a F8

> **Actualización (2026-07-29): el recuento de rutas y el alcance de «TODAS».**
> Dos correcciones verificadas contra el código, sin cambiar la decisión.
>
> 1. **Ya no son ocho rutas, son nueve.** `test/integration/docs.test.ts:111-121`
>    enumera hoy `/health/live`, `/health/ready`, `/v1/locales`,
>    `/v1/content/{locale}`, `/v1/content/{locale}/collections/{slug}/items`,
>    `/v1/export/content-cache`, `/v1/export/editorial/{locale}`, `/v1/contact` y
>    `/v1/complaints`. La novena la sumó
>    [ADR-012](012-export-editorial-v2.md) (export editorial v2). La
>    consecuencia de más abajo se corrige en su sitio.
> 2. **«Documenta TODAS las rutas HTTP de la API»
>    (`test/integration/docs.test.ts:123-127`) es cierto solo con
>    `INTERNAL_EDITOR_ENABLED=false`.** Ese es el default del esquema
>    (`src/shared/config/env.ts:186`) y el que usan las pruebas —
>    `docs.test.ts:62` construye la app con `makeTestConfig({ DOCS_ENABLED:
>    'true' })` y el helper no toca el flag del editor
>    (`test/helpers/test-config.ts:5-13`)—, así que el aserto pasa. Con el
>    **editor encendido** hay cuatro rutas más vivas y **deliberadamente
>    ausentes** del spec: `/internal/edit`, `/internal/api/texts`,
>    `/internal/api/pages` y `/internal/api/settings` (esta última terna con
>    `GET` y `PUT`). Cada una se registra con `schema: { hide: true }`
>    (`src/modules/internal-editor/internal-editor.routes.ts:296-359`), y la
>    descripción del spec lo declara en prosa: «sus rutas no se publican en este
>    spec a propósito» (`src/docs/openapi.ts:91-100`).
>
> **Esa exclusión forma parte de la decisión**, no es un olvido: publicar una
> superficie de escritura sin autenticación de usuario sería un mapa para
> terceros, y el editor se apoya en no ser alcanzable (allowlist de IP) más que
> en no ser conocido. El precio es explícito: con el editor encendido el spec
> **deja de ser** el inventario completo de la superficie HTTP, y el nombre del
> test promete más de lo que puede garantizar. La decisión del editor y su
> postura de seguridad se registran en
> [ADR-013](013-editor-editorial-interno.md).

## Contexto

`docs/api-contract.md` describe el contrato HTTP en prosa, pero no es
verificable ni explorable: nada garantiza que siga a los `schema` TypeBox reales
cuando una ruta cambia, y un integrador no puede probar un endpoint desde ahí.

La API ya declara TypeBox (JSON Schema) en cada ruta para validar entradas y —
sobre todo— para serializar respuestas, que es la barrera anti-fuga exigida por
AGENTS.md. Ese material ya es, de hecho, un contrato formal sin publicar.

## Decisión

1. **OpenAPI 3.1 generado desde las rutas**, con `@fastify/swagger` (aprobado
   por el usuario junto a `@fastify/swagger-ui`). El spec es una proyección de
   los `schema` que validan y serializan en runtime, no un contrato paralelo
   mantenido a mano: no puede desviarse del comportamiento real.
   `docs/api-contract.md` se conserva como contrato narrativo (reglas de
   negocio, decisiones, matices operativos) y no se reemplaza.
2. **3.1 y no 3.0.3** (default del plugin): los `304` se declaran con
   `Type.Null()` y varios schemas usan uniones nulables; 3.1 es JSON Schema
   2020-12, así que se publican sin traducción con pérdida.
3. **Exposición apagada por defecto fuera de development** (`DOCS_ENABLED`,
   resuelto en `config.DOCS_UI_ENABLED`). Con las docs apagadas no se registra
   ninguna ruta: `/docs`, `/docs/json` y `/docs/yaml` caen en el notFound
   handler estándar y responden `404` con la envolvente del proyecto, sin
   revelar que la documentación existe. Forzarla en producción emite un `warn`.
4. **En producción, el flag no basta: hay allowlist de IPs** (`DOCS_ALLOWED_IPS`,
   vacío = solo loopback), aplicada con un hook `onRequest` en un scope propio
   que envuelve a swagger-ui, de modo que no afecta al resto de la API. Un
   cliente no autorizado recibe `404`, no `403`: para él la documentación
   simplemente no existe, igual que con `DOCS_ENABLED=false`.

   Sin esto, la protección dependía enteramente de IIS/ARR, cuya configuración
   este repositorio no contiene ni puede verificar. La allowlist no sustituye
   esa capa; la respalda con una barrera que sí se puede probar aquí.

5. **«Try it out» solo en development.** La UI ejecuta llamadas reales y
   `POST /v1/contact` persiste datos personales; fuera de development se
   registra `supportedSubmitMethods: []` y la UI queda de solo lectura.
6. **CSP resuelta con `staticCSP: true`.** La CSP por defecto de
   `@fastify/helmet` rompe la UI. En vez de relajar helmet globalmente,
   swagger-ui publica su propia CSP en un hook `onSend` encapsulado en su
   prefijo: aplica solo a `/docs/*` y la del resto de la API queda intacta.
7. **El cuerpo multipart de reclamos se documenta con `transform`.**
   `POST /v1/complaints` parsea el multipart a mano (`req.parts()`), así que no
   puede llevar `schema.body`: instalarlo pondría a Ajv a validar un `req.body`
   inexistente y convertiría altas válidas en `400`. `transform` interviene solo
   al generar el documento, nunca en el runtime de la ruta.
8. **El componente `ComplaintPayload` documenta la ENTRADA, no lo persistible.**
   El contrato heredado ubica el honeypot `website` dentro del JSON y la ruta lo
   extrae antes de `Value.Clean`, pero `complaintPayloadSchema` no lo declara y
   tiene `additionalProperties: false` —correctamente: `website` jamás debe
   llegar al documento persistido—. Publicar el schema validable como contrato
   de request haría que un cliente generado desde OpenAPI rechazara u omitiera
   un campo que la API sí admite, así que el componente se construye desde
   `complaintPayloadDocSchema`. Son dos contratos distintos y ambos verdaderos.
9. **Anotaciones sin acoplar las rutas a los plugins.** Las rutas importan
   `src/shared/docs/openapi-annotations.ts` (descripciones, headers de respuesta
   y nombre del security scheme), que no importa `@fastify/swagger`. La
   definición del spec vive en `src/docs/openapi.ts`. Esto mantiene los módulos
   de dominio libres de la dependencia de documentación; **no** evita que los
   plugins se carguen: `src/app.ts` importa `openapi.ts` estáticamente, así que
   `DOCS_ENABLED=false` evita **registrarlos**, no cargarlos.
10. **Descripciones por respuesta con `x-response-description`.** Sin ellas
    @fastify/swagger rotula todo como «Default Response» y la UI no distingue un
    alta nueva de un reintento idempotente, ni un `503` de readiness de uno de
    gate cerrado. Se usa esa extensión y no `description` porque el plugin la
    consume como descripción de la respuesta y luego la elimina del schema
    publicado, en vez de dejarla pegada al cuerpo.

## Consecuencias

- El spec hereda la barrera anti-fuga: solo documenta lo que los response
  schemas dejan salir. Nunca aparecen `_id`, documentos Mongo crudos,
  `rowVersionToken` en el bundle público ni los binarios de firma/adjuntos
  (que salen como hashes). Hay pruebas que lo verifican sobre el JSON generado.
- Añadir una ruta sin `tags`/`summary` la deja documentada pobremente pero
  visible; el test que enumera las nueve rutas públicas obliga a mantener la
  lista al día. (Eran ocho al redactar este ADR; ver la actualización del
  2026-07-29 en el encabezado.)
- El endpoint del export queda descrito como autenticación servidor-a-servidor
  (`apiKey` en header), con la advertencia de que la clave nunca debe llegar al
  navegador. El security scheme nombra el header en minúsculas (`x-export-key`)
  a propósito: @fastify/swagger omite de `parameters` los headers que ya cubre
  un security scheme comparando el nombre literal, y la ruta los declara así.
  Con otra grafía la credencial aparecería dos veces en la UI. Los headers HTTP
  son insensibles a mayúsculas; la prosa sigue usando `X-Export-Key`.
- El Libro de Reclamaciones aparece documentado como **bloqueado**: con el gate
  cerrado el spec publica el `503 COMPLAINTS_DISABLED` y **no** un `requestBody`
  multipart que la API no aceptaría. Esta decisión no toca los flags legales.
- La superficie que abre el flag es `/docs` (UI), `/docs/json`, `/docs/yaml` y
  los assets estáticos de la UI bajo `/docs/static/*`.
- Riesgo asumido: publicar `/docs` describe la superficie completa de la API a
  quien pueda alcanzarla. Por eso el default es apagado, en producción hay
  allowlist además del flag, y la activación fuera de development es una
  decisión operativa explícita, no un efecto del despliegue.
