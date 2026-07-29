# Integración verificable con carrito-front

Límite contractual entre esta API y `carrito-front`. Describe **dos** contratos
de build servidor-a-servidor —el cache flat y el snapshot editorial— y cómo el
front los consume hoy.

**Inspección vigente: 2026-07-28**, de solo lectura, sobre el checkout local de
`carrito-front` en `CarritoComprasFront/ClientApp`. Sustituye a la inspección
original de F8, que se hizo sobre la rama `docs/forms-backend-plan` del front y
quedó caduca: aquella describía un pipeline SQL y una automatización pendiente
que ya no existen. Las afirmaciones de esta sección valen para el estado del
front en esa fecha; si el front cambia, esta sección se refecha, no se
reinterpreta. Este repositorio no modifica ni ejecuta builds del front.

## Estado comprobado del consumidor

- `app/composables/useContent.ts` carga
  `ClientApp/app/data/generated/content-cache.json` en **build-time**, con
  `import.meta.glob`. El archivo está **versionado en el repositorio del
  front** (ADR-0010 del front); si falta, el cache queda nulo y el build sigue
  con colecciones y textos vacíos, con aviso en desarrollo.
- El tipo `ContentCache` (`app/types/content.ts`) declara las mismas nueve
  claves raíz que el export de esta API, en el mismo orden.
- El cache del front y el golden de esta API tienen los mismos conteos:
  `1/16/13/62/33/17/84/226`
  (locales, settings, pages, texts, assets, collections, items, versionTokens).
- `app/composables/useEditorial.ts` carga
  `app/data/generated/editorial-snapshot.json`, también con `import.meta.glob`,
  y **descarta el snapshot si su `schemaVersion` no es el que entiende**.
- **Ambos formularios están cableados** a esta API mediante el cliente dedicado
  `app/services/contentApi.ts`: `CONTACT_ENDPOINT = "/v1/contact"` y
  `COMPLAINTS_ENDPOINT = "/v1/complaints"`. Lo que mantiene el Libro fuera de
  servicio es el gate del backend, no la ausencia de UI (ver «Formularios»).

## Contrato de build 1 — cache flat

El endpoint que reproduce el artefacto completo esperado por `useContent.ts`:

```text
GET /v1/export/content-cache
X-Export-Key: <credencial del build>
```

Destino en el consumidor:

```text
CarritoComprasFront/ClientApp/app/data/generated/content-cache.json
```

### Automatización: `npm run content:fetch`

La descarga **ya está implementada** en el front (ADR-0005 del front):
`scripts/fetch-content.mjs`, sin dependencias externas. No hay que escribir un
`Invoke-WebRequest` a mano ni existe ya `scripts/sync-content.mjs`: el pipeline
que generaba el cache desde SQL Server fue retirado (ADR-0006 del front) y esta
API es la **única** fuente del cache editorial.

```powershell
# En CarritoComprasFront/ClientApp
npm run content:fetch
npm run content:fetch -- --dry-run   # valida y no escribe nada
```

Configuración, sin secretos en el repositorio:

```text
CARRITO_CONTENT_API_URL     base de la API (p. ej. http://127.0.0.1:3000)
CARRITO_CONTENT_EXPORT_KEY  clave del header X-Export-Key (nunca se imprime)
```

`process.env` tiene prioridad; si no están, el script las lee de un archivo
externo (`db/content-api.env.local` por defecto, o `--env-file <ruta>`), fuera
de `ClientApp`. La clave pertenece al entorno secreto del proceso de build:

- nunca se versiona;
- nunca se incluye en el bundle;
- nunca se entrega al navegador;
- nunca se guarda con un valor real en un `.env.example`;
- nunca usa el prefijo `NUXT_PUBLIC_*`.

El export no debe solicitarse mediante el plugin `$api` del front: ese cliente
puede adjuntar el bearer del sistema de ventas. La descarga es una operación
servidor-a-servidor separada y no necesita autenticación de clientes.

Lo que el script hace antes de tocar el archivo de destino: exige `200`
autenticado, parsea el JSON, comprueba las nueve claves raíz en su orden
canónico y pasa los validadores compartidos (`content-cache-validators.mjs`,
V5–V8 más el gate E1 de HTML seguro). La escritura final es **atómica**:
archivo temporal en el mismo directorio, `fsync` y `rename`. Un fallo en
cualquier paso sale con código distinto de 0 sin sustituir el cache anterior.

### ETag y descarga condicional

El endpoint devuelve un ETag fuerte derivado de `contentVersion`. El script
guarda el de la última descarga en un **sidecar junto al archivo de salida**:

```text
CarritoComprasFront/ClientApp/app/data/generated/content-cache.etag.txt
```

Ese sidecar está git-ignorado en el front (a diferencia del propio
`content-cache.json`, que sí se versiona). Se envía `If-None-Match` solo si
existen a la vez el sidecar y el archivo JSON, para no provocar un `304`
huérfano que dejaría el front sin cache. Respuestas:

- `200`: validar y publicar el nuevo artefacto;
- `304`: conservar el artefacto previamente validado;
- `401`/`403`: detener el build sin imprimir la clave;
- cualquier otro estado o `5xx`: detener el build, no reemplazar el cache
  anterior.

La autenticación sigue siendo obligatoria para obtener un `304`.

### Gate de release del front

El front **sí impone** el gate: `build` y `build:ci` empiezan por
`content:verify` (`scripts/verify-content-cache.mjs`), que es de solo lectura y
falla si el cache no existe, no es JSON válido, no tiene las nueve claves raíz
en orden o no pasa los validadores compartidos. Un build de publicación no
puede compilar con contenido editorial ausente o corrupto.

`content:verify` no está enganchado en `dev`/`dev:nuxt`: en desarrollo local el
cache puede no existir todavía.

## Contrato de build 2 — snapshot editorial (Track B)

```text
GET /v1/export/editorial/:locale
X-Export-Key: <credencial del build>
```

Misma credencial servidor-a-servidor y mismo tratamiento del secreto que el
export flat. Sirve el snapshot **activo** del locale, almacenado, no construido
al vuelo; sin snapshot activo responde `404 NOT_FOUND`. Contrato y forma del
cuerpo: `docs/api-contract.md` y [ADR-012](decisions/012-export-editorial-v2.md).

Consumo en el front:

```powershell
# En CarritoComprasFront/ClientApp
npm run editorial:fetch        # scripts/fetch-editorial.mjs, locale es-PE por defecto
npm run editorial:verify       # scripts/verify-editorial-snapshot.mjs --allow-missing
```

Destino:

```text
CarritoComprasFront/ClientApp/app/data/generated/editorial-snapshot.json
```

`fetch-editorial.mjs` usa las mismas variables (`CARRITO_CONTENT_API_URL`,
`CARRITO_CONTENT_EXPORT_KEY`, o el mismo archivo externo vía
`CARRITO_CONTENT_ENV_FILE`) y verifica el artefacto antes de escribirlo:
`schemaVersion`, claves raíz, hashes del `manifest` y `checksum` global.
`verify-editorial-snapshot.mjs` repite esa verificación sobre el archivo local
y añade dos invariantes del modelo: ningún punto de embarque puede llegar
marcado como destino y ninguna URL canónica puede repetirse entre destinos.

El ETag de este export es la versión activa del snapshot
(`"editorial-es-PE-v3"`): cambia solo al publicar o revertir, nunca al editar
un borrador. Publicar o revertir un snapshot editorial **no** mueve
`contentVersion` ni el ETag del export flat (ADR-011).

`editorial:verify` lleva hoy `--allow-missing` para que un checkout limpio
compile sin snapshot. El corte de Track B retira esa bandera; el procedimiento
está en `docs/runbook.md` §12.

## Gate exacto del golden

En esta API:

```powershell
npm run test:golden
```

El test:

- confirma que la copia contractual es byte-idéntica al golden raíz;
- importa el golden en MongoDB efímero;
- solicita `/v1/export/content-cache`;
- compara el body serializado exacto, normalizando solo `generatedAtUtc`;
- confirma tokens, orden, ETag, autenticación y exclusión de drafts.

Inmediatamente después de una importación inicial en un entorno real, el
procedimiento de `docs/runbook.md` compara además el export de esa base con el
golden completo. Las publicaciones editoriales posteriores cambian el dataset
por diseño, pero no el contrato.

## Contenido runtime

`GET /v1/content/:locale` no es un reemplazo directo del archivo de build:

- agrega `locale` y `contentVersion`;
- no incluye `locales` ni `versionTokens`;
- sus items omiten `rowVersionToken`;
- aplica fallback por clave en el servidor.

El front consume `ContentCache` en build-time. Cambiarlo a consumo runtime
requiere tipos y estrategia de caché específicos, además de configurar
`CORS_ORIGINS`.

## Comunicados on/off (`announcements`)

Paridad con el front: items `covid` (alerta home) y `nav-modal` (modal del
navbar). Visibilidad = `isActive` + ventana opcional `activeFrom`/`activeTo`
(`isAnnouncementLive` en el front). El export incluye `isActive: false`; el
front no muestra ni inventa copy si el item no está live.

Operación sin redeploy de lógica: `content:set` → `content:publish` →
`content:export` → en el front `content:fetch` (+ build del artefacto). Detalle
CLI en `docs/runbook.md` (sección Comunicados). Al cambiar el texto del modal,
bump de `dismissKey`.

## Formularios

- **Contacto: cableado y en servicio.** `app/pages/contactanos.vue` genera el
  `submissionId` UUID v4 (`crypto.randomUUID`) y lo reutiliza en los reintentos
  del mismo envío; `submitContact` en `app/services/contentApi.ts` hace el
  `POST /v1/contact` y traduce `201` a alta nueva y `200` a reintento
  idempotente.
- **Reclamos: cableado, pero sin servicio por el gate del backend.**
  `app/pages/libro-de-reclamaciones.vue` llama a `submitComplaint`, que hace el
  `POST /v1/complaints` multipart. Con `FEATURE_COMPLAINTS_ENABLED=false` —el
  default, que **debe seguir así** hasta cerrar P1–P18 y recibir autorización
  expresa— la API responde `503 COMPLAINTS_DISABLED` y el front lo trata como
  «no disponible». Es decir: **la barrera es el flag del backend, no la
  ausencia de cliente**. Encender el flag basta para que la UI existente empiece
  a enviar reclamos reales; por eso su activación es una decisión explícita y
  autorizada, nunca un efecto colateral de un despliegue.
- Ningún formulario debe registrar payloads, constancias o errores que
  contengan datos personales.
- El cliente de esta API es independiente del `$api` de ventas y no envía
  `Authorization: Bearer`.

Las reglas de validación de ambos formularios, campo por campo y con la regla
de teléfono por país, están en `docs/validation-parity.md`. El contrato
público, sin datos personales de ejemplo, en `docs/api-contract.md`.
