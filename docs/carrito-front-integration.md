# Integración verificable con carrito-front

Este documento describe el límite contractual entre esta API y
`carrito-front`. F8 no modifica ni ejecuta builds dentro del repositorio del
front.

## Estado comprobado del consumidor

La inspección de solo lectura se realizó sobre la rama local
`docs/forms-backend-plan` de `carrito-front`.

- `useContent.ts` carga en build-time
  `ClientApp/app/data/generated/content-cache.json`.
- Si el archivo falta, `import.meta.glob` devuelve un cache nulo y el build
  puede continuar con colecciones/textos vacíos y fallbacks.
- `scripts/sync-content.mjs` todavía genera el archivo desde SQL Server; no
  consume `carrito-content-api`.
- El tipo `ContentCache` declara las mismas nueve secciones raíz que el export
  de esta API.
- El cache local inspeccionado tenía los mismos conteos que el golden:
  `1/16/13/62/33/17/83/225`.
- El contenido editorial coincidía al excluir `generatedAtUtc`,
  `versionTokens` y `items[].rowVersionToken`. El archivo no era idéntico al
  golden completo porque sus timestamps y tokens SQL eran distintos.

Estos hallazgos verifican compatibilidad estructural, no una integración ya
cableada. Los bloqueos del front se registran con severidad en
`docs/f8-closure.md`.

## Contrato de build

El único endpoint que reproduce el artefacto completo esperado por
`useContent.ts` es:

```text
GET /v1/export/content-cache
X-Export-Key: <credencial del build>
```

Destino esperado por el consumidor:

```text
CarritoComprasFront/ClientApp/app/data/generated/content-cache.json
```

La clave pertenece al entorno secreto del proceso de build:

- nunca se versiona;
- nunca se incluye en el bundle;
- nunca se entrega al navegador;
- nunca se guarda en `.env.example` del front con un valor real;
- nunca usa el prefijo `NUXT_PUBLIC_*`.

El export no debe solicitarse mediante el plugin `$api` existente del front:
ese cliente puede adjuntar el bearer del sistema de ventas. La descarga es una
operación servidor-a-servidor separada y no necesita autenticación de clientes.

## Procedimiento para un build seguro

La automatización futura puede recibir estas variables secretas del entorno de
CI/build, sin valores literales en scripts o logs:

```text
CARRITO_CONTENT_API_URL
CARRITO_CONTENT_EXPORT_KEY
```

Descargar primero a una ruta temporal fuera del árbol fuente:

```powershell
$headers = @{ 'X-Export-Key' = $env:CARRITO_CONTENT_EXPORT_KEY }
$stagedCache = Join-Path $env:TEMP 'carrito-front-content-cache.json'
Invoke-WebRequest -Uri "$env:CARRITO_CONTENT_API_URL/v1/export/content-cache" -Headers $headers -OutFile $stagedCache
node --input-type=module -e "import fs from 'node:fs'; const p=process.argv[1]; const c=JSON.parse(fs.readFileSync(p,'utf8')); const required=['generatedAtUtc','locales','settings','pages','texts','assets','collections','items','versionTokens']; if(required.some(k=>!(k in c))){console.error('Cache incompleto');process.exit(1)} console.log('Cache JSON válido');" $stagedCache
```

El pipeline autorizado debe publicar el archivo staged en la ruta generada del
front únicamente después de:

1. respuesta HTTP `200` autenticada;
2. parseo JSON correcto;
3. presencia de las nueve secciones;
4. comprobación de que existe exactamente un locale default activo;
5. gate `npm run test:golden` en esta API;
6. build verificable del front.

La sustitución del artefacto generado debe ser atómica y no debe tocar los
golden de esta API. La implementación de esa automatización o cualquier cambio
en `sync-content.mjs` requiere autorización para modificar `carrito-front` y
queda fuera de F8.

## ETag

El endpoint devuelve un ETag fuerte derivado de `contentVersion`. Un proceso de
build puede conservar el ETag anterior fuera del repositorio y enviar
`If-None-Match`:

- `200`: validar y publicar el nuevo artefacto;
- `304`: conservar el artefacto previamente validado;
- `401`: detener el build sin imprimir la clave;
- cualquier `5xx`: detener el build, no reemplazar el cache anterior.

La autenticación sigue siendo obligatoria para obtener `304`.

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

El front actual usa `ContentCache` en build-time. Cambiarlo a consumo runtime
requiere tipos y estrategia de caché específicos, además de configurar
`CORS_ORIGINS`; no forma parte de F8.

## Formularios

Las páginas actuales del front no consumen estas rutas.

- Contacto debe usar `POST /v1/contact`, generar un `submissionId` UUID v4 y
  tratar `200` como reintento idempotente y `201` como alta nueva.
- Reclamos no debe conectarse mientras
  `FEATURE_COMPLAINTS_ENABLED=false`. Su activación depende del gate legal
  P1–P18 y de una autorización posterior.
- Ningún formulario debe registrar payloads, constancias o errores que
  contengan datos personales.
- Un futuro cliente de esta API debe ser independiente del `$api` de ventas y
  no enviar `Authorization: Bearer`.

El contrato detallado, sin datos personales de ejemplo, está en
`docs/api-contract.md`.

## Gate de release del front

Una build destinada a publicación debe fallar antes de compilar si el cache
generado no existe, está vacío o no supera la validación contractual. El front
actual no impone ese fallo: continuar con contenido vacío es un riesgo de
release alto y bloqueante de preproducción, registrado en el backlog de F8.
