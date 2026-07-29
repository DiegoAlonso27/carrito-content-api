# Runbook operativo

Procedimiento de puesta en marcha, publicación, verificación y rollback de
`carrito-content-api`. No contiene secretos ni comandos que eliminen datos,
colecciones, bases o índices. `AGENTS.md` y los ADR de `docs/decisions/`
prevalecen ante cualquier discrepancia.

## 1. Prerrequisitos

- Node.js 22 o posterior y npm.
- MongoDB accesible únicamente desde la red necesaria.
- Dos bases con nombres distintos: `carrito_content` y `carrito_forms` por
  defecto.
- En producción, usuarios y URI distintos para contenido y formularios.
- Replica set para `content:set` y `content:publish`. Puede ser de un nodo en
  desarrollo. La importación inicial, lectura pública y export toleran un
  servidor standalone.
- Una cuenta de migración con DDL y una cuenta runtime con privilegios mínimos.

No exponer MongoDB a Internet. No usar las credenciales del sistema de ventas
ni conectarse a su base de datos.

## 2. Instalación y configuración

Instalar exactamente el lockfile:

```powershell
npm ci
```

Para desarrollo puede crearse un `.env` local ignorado por Git:

```powershell
Copy-Item .env.example .env
```

En producción, el archivo de variables vive fuera del repositorio y de cada
release. El proceso recibe su ruta mediante `CARRITO_ENV_FILE`. Si esa ruta no
existe, la aplicación falla antes de escuchar tráfico.

### Variables base

| Variable                             | Requisito operativo                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | `development`, `test` o `production`.                                                                                  |
| `HOST`, `PORT`                       | Interfaz y puerto del proceso.                                                                                         |
| `LOG_LEVEL`                          | Nivel estructurado; no habilita bodies ni headers.                                                                     |
| `MONGO_URI`                          | Cuenta de contenido; nunca una cuenta de ventas.                                                                       |
| `MONGO_URI_FORMS`                    | Obligatoria y distinta de `MONGO_URI` en producción cuando contacto está activo; también cuando reclamos se habiliten. |
| `MONGO_DB_CONTENT`, `MONGO_DB_FORMS` | Nombres no vacíos y siempre distintos.                                                                                 |
| `CORS_ORIGINS`                       | Orígenes exactos del front. Vacío mantiene CORS cerrado; `*` es inválido.                                              |
| `EXPORT_API_KEYS`                    | Cero, una o dos claves de al menos 32 caracteres. Vacío deshabilita el export con `401`.                               |
| `DOCS_ENABLED`                       | `auto` (default: solo `development`), `true` o `false`. Gobierna la superficie `/docs*`.                               |
| `DOCS_ALLOWED_IPS`                   | IPs que pueden leer `/docs` en producción, separadas por coma. Vacío = solo loopback. No aplica fuera de producción.   |
| `RATE_LIMIT_READ_PER_MINUTE`         | Presupuesto por IP y minuto de las tres rutas públicas de lectura (default 120). No cubre health ni export.            |
| `RATE_LIMIT_CONTACT_MAX`             | Envíos de contacto permitidos por ventana (default 5).                                                                 |
| `RATE_LIMIT_CONTACT_WINDOW_MINUTES`  | Duración de esa ventana, en minutos (default 10).                                                                      |
| `INTERNAL_EDITOR_ENABLED`            | Editor editorial interno. Default `false`: no se registra ninguna ruta `/internal/*`.                                  |
| `INTERNAL_EDITOR_ALLOWED_IPS`        | IPs que pueden usar el editor, separadas por coma. Vacío = modo loopback estricto (ver más abajo).                     |

Los flags y límites de reclamos (`FEATURE_COMPLAINTS_ENABLED`,
`COMPLAINTS_LEGAL_GATE_CLEARED`, `RATE_LIMIT_COMPLAINTS_*`, valores legales,
SMTP, firma y adjuntos) se documentan en «Feature flags» y en
`docs/api-contract.md`; no se tocan en un despliegue ordinario.

`X-Export-Key` es una credencial servidor-a-servidor exclusiva del build. No
se guarda en el repositorio, no se entrega al navegador y nunca se publica como
`NUXT_PUBLIC_*`.

**Las allowlists de IP (`DOCS_ALLOWED_IPS`, `INTERNAL_EDITOR_ALLOWED_IPS`) se
comparan por igualdad exacta.** No admiten CIDR, rangos ni comodines: escribir
`10.0.0.0/24` o `10.0.0.*` no autoriza a nadie —falla cerrado, pero la entrada
tampoco se rechaza al arrancar, así que el operador solo lo descubre al recibir
un `404`/`403` inesperado. Cada IP se declara suelta. La única normalización es
la del formato IPv4 mapeado sobre IPv6 (`::ffff:10.0.0.5` casa con
`10.0.0.5`).

**El rate limit no es global.** El plugin se registra con `global: false` y
cada ruta declara el suyo. Lo tienen: las tres rutas públicas de lectura
(`RATE_LIMIT_READ_PER_MINUTE`), `POST /v1/contact`
(`RATE_LIMIT_CONTACT_*`), `POST /v1/complaints` **solo con el gate abierto**
(`RATE_LIMIT_COMPLAINTS_*`; la ruta que responde `503` no lleva presupuesto) y
el `PUT` del editor interno (30/min, fijo en código). `/health/*` y
`/v1/export/*` **no tienen presupuesto**: su control es la credencial de export
y la red desde la que se alcanzan, no el rate limit.

**Presupuesto BSON de reclamos (validado al arrancar).**
`COMPLAINTS_SIGNATURE_MAX_BYTES + COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES` debe
ser como máximo **15 MiB**; superarlo detiene el proceso antes de escuchar
tráfico. El reclamo se persiste como un único documento atómico y el margen
restante hasta los 16 MiB de BSON queda reservado para hoja, metadatos y sobre.
`COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES` tampoco puede superar el total.

### Documentación OpenAPI

La superficie es `/docs` (UI), `/docs/json`, `/docs/yaml` y los assets de la UI
bajo `/docs/static/*`.

Con `DOCS_ENABLED=auto` (default) la documentación solo existe en
`development`. En producción todas esas rutas responden `404` como cualquier
ruta inexistente: no hay superficie que proteger.

Ponerlo en `true` describe la API completa a quien alcance el puerto; el
arranque lo advierte en el log. **En producción el flag no basta por sí solo:**
las rutas `/docs*` exigen además que la IP del cliente esté permitida.
`DOCS_ALLOWED_IPS` vacío admite solo loopback; declarar IPs explícitas sustituye
ese default (loopback deja de estar permitido salvo que se incluya). Un cliente
no autorizado recibe `404`, no `403`: para él la documentación no existe.

Esa allowlist no reemplaza la restricción en IIS/ARR, la respalda: es la parte
verificable desde este repositorio. «Try it out» de la UI queda deshabilitado
fuera de `development`, porque ejecuta llamadas reales y `POST /v1/contact`
persiste datos personales. Ver ADR-009.

### Editor editorial interno

Superficie análoga a `/docs` en el modelo de exposición (flag + allowlist de
IP), pero de escritura: `GET /internal/edit` sirve una página HTML de una sola
pieza, y `GET`/`PUT` sobre `/internal/api/texts`, `/internal/api/pages` y
`/internal/api/settings` leen y guardan esas tres secciones. No es un CMS: no
tiene login ni sesiones de usuario, no gestiona `items`, `assets`,
`collections` ni `locales` —eso sigue siendo territorio exclusivo de los CLI
de `scripts/content/`, que tocan la topología del contenido (referencias,
esquemas por colección)— y no aparece en `/docs`: sus rutas se declaran
`hide: true` a propósito, por lo que este runbook es su única documentación.

Encenderlo:

```
INTERNAL_EDITOR_ENABLED=true
```

en el archivo de entorno, y abrir `http://127.0.0.1:3000/internal/edit` desde
la propia máquina donde corre el proceso. Con el flag en `false` (default) no
se registra ninguna ruta: `/internal/edit` cae en el notFound estándar y
responde `404`, igual que cualquier ruta inexistente.

**Allowlist e IP de origen.** `INTERNAL_EDITOR_ALLOWED_IPS` vacío (default) es
modo loopback: exige socket loopback real y **rechaza de plano** cualquier
petición que traiga `X-Forwarded-For`, aunque el socket sea `127.0.0.1`. La
razón es la misma que sostiene el resto del proceso: `trustProxy: '127.0.0.1'`
hace que, detrás de un proxy en la misma máquina, `req.ip` se calcule a partir
de esa cabecera; si el proxy la reenvía sin anexarla correctamente, cualquier
cliente externo podría presentarse como `127.0.0.1`. En `/docs` ese fallo solo
dejaría leer documentación; aquí dejaría escribir en `carrito_content`. Por
eso el flujo previsto es abrir el editor **desde la propia máquina del
servidor**, o por un túnel SSH hasta ella —nunca a través de IIS/ARR. Si hace
falta acceso a través del proxy, hay que declarar la IP explícitamente en
`INTERNAL_EDITOR_ALLOWED_IPS` (loopback deja de estar implícitamente permitido
en cuanto la allowlist deja de estar vacía); a partir de ahí la seguridad
depende por completo de que el proxy anexe `X-Forwarded-For` correctamente, y
este repositorio no puede verificarlo. Una IP fuera de la allowlist recibe
`403`, no `404`: a diferencia de `/docs`, encender el editor ya fue una
decisión explícita, así que no hay nada que ocultarle a un cliente rechazado.
La comparación es por **igualdad exacta**, sin CIDR ni rangos: ver la nota de
la sección «Variables base».

**Rate limit propio.** Cada `PUT` de sección lleva un presupuesto fijo en
código de **30 peticiones por minuto y por IP**, independiente del de lectura
pública. Un guardado que llegue por encima recibe `429 RATE_LIMITED` con
`Retry-After`. Los `GET` del editor no tienen presupuesto.

**Advertencia de producción.** Guardar en el editor publica de inmediato
(`setRecords(..., { publish: true })`) y sube `contentVersion`, lo que
invalida el ETag del contenido público y el del export que `carrito-front`
consume en build. Encenderlo en un entorno públicamente alcanzable es publicar
contenido editorial sin autenticación de usuario, protegido solo por la
allowlist de IP. El arranque lo advierte en el log cuando
`INTERNAL_EDITOR_ENABLED=true` y `NODE_ENV=production`.

**Permisos de MongoDB.** El editor no abre una conexión propia: escribe con la
misma conexión `MONGO_URI` que usa el resto del proceso en ejecución. Esto es
distinto de los CLI de `scripts/content/`, que se invocan bajo demanda y
pueden apuntar a un archivo de entorno con la cuenta de «Operador editorial»
solo mientras dura la operación (§3). Encender el editor exige que la cuenta
de `MONGO_URI` del proceso tenga permisos de **lectura y escritura** sobre las
colecciones editoriales de `carrito_content` de forma continua —ya no basta la
cuenta de solo lectura de «Runtime de contenido»—, pero **no** de DDL: el
camino HTTP llama a `setRecords` con `ensureSetup: false` a propósito, para no
requerir privilegios de esquema sobre la cuenta que queda expuesta por más
tiempo que una invocación de CLI.

**Topología.** Igual que `content:set`/`content:publish`, las escrituras del
editor son transacciones multi-documento y exigen MongoDB en replica set
(ADR-001). Contra un servidor standalone, el editor responde `503` al
guardar; la lectura de las secciones no se ve afectada.

**Errores que verá el operador:**

- `403 FORBIDDEN`: la IP de origen no está en la allowlist.
- `409 CONTENT_VERSION_CONFLICT`: el contenido cambió desde que se cargó la
  sección (otra pestaña, otro operador). Recargar la sección antes de guardar;
  el editor no fusiona cambios.
- `400 VALIDATION_ERROR`: uno o más registros del lote no pasan las reglas
  editoriales (referencia inexistente, clave duplicada, campo inválido); el
  detalle viene por registro. También si el lote va vacío o supera 500
  registros.
- `429 RATE_LIMITED`: más de 30 guardados por minuto desde la misma IP.
- `503 SERVICE_NOT_READY`: MongoDB no está en replica set, o la escritura no
  pudo confirmarse por un problema de infraestructura. La lectura de la
  sección sigue disponible.

**Apagarlo:** `INTERNAL_EDITOR_ENABLED=false` y reiniciar. Verificar que
`GET /internal/edit` responde `404`.

**Después de publicar**, el contenido servido por el editor ya está
actualizado en `carrito_content`, pero ni el golden de este repositorio ni el
cache de build del front lo reflejan todavía. El resync completo son cuatro
pasos, y omitirlos deja pruebas en rojo:

1. Reexportar el golden de este repo con `npm run content:export` y sincronizar
   la copia contractual `test/contract/golden/content-cache.json` (deben quedar
   byte-idénticas; ADR-004). Si no, `npm run test:golden` falla.
2. Actualizar en el **mismo cambio** los conteos de
   `test/integration/import-cache.test.ts` si variaron altas, bajas o
   `isActive`. Editar el golden y dejar ese test en rojo hace que la siguiente
   tarea no pueda distinguir un fallo propio de uno heredado (lección de
   `AGENTS.md`).
3. En `carrito-front`: `npm run content:fetch` (o esperar a que caduque la
   caché HTTP pública) y reconstruir el artefacto.
4. Commitear en **ambos** repos: el `content-cache.json` del front está
   versionado por la excepción de su ADR-0010, así que un publish sin commit
   deja producción y repositorio divergentes sin que ningún gate lo detecte.

### Feature flags

- `FEATURE_CONTACT_ENABLED=true`: contacto registrado. `false` retira la ruta
  y funciona como kill-switch.
- `FEATURE_COMPLAINTS_ENABLED=false`: gate de fase, debe permanecer en `false`.
- `COMPLAINTS_LEGAL_GATE_CLEARED=false`: segundo bloqueo legal, también debe
  permanecer en `false` hasta cerrar P1–P18 y recibir autorización expresa.

Los valores legales, SMTP, firma y adjuntos de reclamos no se completan ni se
activan durante un despliegue ordinario.

## 3. Privilegios MongoDB

| Cuenta                                 | Privilegios mínimos                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Migración de contenido                 | DDL y escritura en `carrito_content`.                                         |
| Runtime de contenido                   | Lectura en colecciones editoriales y `meta`.                                  |
| Operador editorial                     | Lectura/escritura y transacciones en `carrito_content`; requiere replica set. |
| Migración de formularios               | DDL en `carrito_forms`.                                                       |
| Runtime de contacto                    | `find`/`insert` en `contact_messages`, sin DDL.                               |
| Runtime de reclamos, solo tras el gate | `find`/`insert` y actualización acotada de `emailDispatch`, sin DDL.          |

Los scripts usan la configuración activa. Antes de ejecutar DDL o una
importación, el operador debe verificar qué archivo externo de entorno y qué
cuenta están seleccionados; los scripts no imprimen credenciales.

## 4. Verificación previa de una release

Desde un checkout limpio:

```powershell
npm ci
npm run typecheck
npm run lint
npm run format
npm run test:golden
npm test
npm run build
```

`test:golden` aparece también dentro de la suite completa, pero se ejecuta por
separado para que el gate contractual F2 sea visible. Un fallo impide publicar
la release. No se corrige modificando el golden salvo una decisión contractual
expresa fuera de F8.

## 5. Aprovisionamiento inicial

Ejecutar con las cuentas de migración correspondientes y con la API detenida o
fuera del balanceador.

### Formularios

```powershell
npm run setup:contact
npm run setup:complaints
npm run indexes:obsolete
```

`setup:complaints` solo crea validador e índices. No habilita el Libro ni cambia
flags. Ninguno de estos comandos elimina índices. `indexes:obsolete` es de solo
lectura y únicamente reporta nombres conocidos.

### Contenido inicial

Primero validar el archivo canónico sin conectarse ni escribir:

```powershell
npm run migrate:cache -- --dry-run
```

La importación real se usa sobre una base inicial destinada a
`carrito_content`, o como reconciliación previamente revisada. Es idempotente,
pero puede actualizar documentos cuyo contenido difiera de la fuente:

```powershell
npm run migrate:cache
```

La verificación registro a registro está activa por defecto. No usar
`--no-verify` en el procedimiento normal. El resultado esperado para el golden
inicial es:

- locales: 1;
- settings: 16;
- pages: 13;
- texts: 62;
- assets: 33;
- collections: 17;
- items: 84.

Esos conteos son los que afirma `test/integration/import-cache.test.ts`: al
dar de alta o de baja registros en el golden hay que actualizarlos en el mismo
cambio (AGENTS.md — Lecciones).

Nunca usar `content-cache.json` ni
`test/contract/golden/content-cache.json` como destino de un export.

## 6. Revisión y publicación editorial

Las mutaciones siguientes exigen MongoDB replica set. Sin esa topología el CLI
falla antes de confirmar cambios; no existe fallback standalone.

Consultar resumen y borradores:

```powershell
npm run content:status
npm run content:status -- --section items --status draft
```

Crear o editar desde un JSON previamente revisado y sin datos personales:

```powershell
$changeFile = Read-Host 'Ruta del JSON editorial revisado'
npm run content:set -- --section items --file $changeFile
```

Un registro nuevo nace `draft`. Revisar de nuevo y publicarlo explícitamente:

```powershell
npm run content:status -- --section items --status draft
$itemKey = Read-Host 'Clave natural: coleccion/locale/slug'
npm run content:publish -- --section items --key $itemKey --to published
```

Para retirar contenido sin borrarlo:

```powershell
$itemKey = Read-Host 'Clave natural: coleccion/locale/slug'
npm run content:publish -- --section items --key $itemKey --to archived
```

`content:set -- --publish` existe, pero el procedimiento normal separa edición,
revisión y publicación. Cada mutación confirmada incrementa `contentVersion`,
renueva ETag y valida referencias antes de escribir.

### Modelo editorial por bloques (Track B)

Los mismos dos comandos atienden las secciones del modelo por bloques
(`localities`, `destinations`, `boarding-points`, `services`, `amenities`).
Viven en colecciones `editorial_*` y en su propio contador
`editorialVersion`: **editar contenido editorial no invalida el ETag del
export flat** (ver ADR-011).

```powershell
$docFile = Read-Host 'Ruta del JSON del documento editorial'
npm run content:set -- --section destinations --file $docFile
npm run content:publish -- --section destinations --key chiclayo --to published
```

Estados disponibles en estas secciones: `draft`, `review`, `approved`,
`published`, `archived`. Publicar valida el **documento completo**: un bloque
inválido, un tipo desconocido o una referencia rota impiden la publicación y el
CLI lista cada motivo. Los avisos (referencia no publicada, medio sin derechos
verificados) no bloquean: ese contenido se excluye del snapshot.

Migración desde el modelo flat, con reporte y sin escribir:

```powershell
$catalog = Read-Host 'Ruta de catalogo-localidades.anotado.json'
npm run editorial:migrate -- --catalog $catalog --dry-run
```

La migración real (mismo comando sin `--dry-run`) no borra el origen y no
publica nada. Para revisar qué documentos son publicables hoy y qué les falta:

```powershell
npm run editorial:validate
npm run editorial:validate -- --only-errors
```

`editorial:validate` sale con código 1 si hay **cualquier** error del grafo,
incluidos los puntos de embarque sin dirección o localidad verificada, que al
corte son el estado esperado (P-04/P-13). Sirve para revisar contenido; el gate
Go/No-Go del corte es `npm run editorial:cutover-check` (§12.2), que distingue
lo que bloquea de lo que solo avisa.

### Snapshot editorial: publicar, listar y revertir

El export v2 (`GET /v1/export/editorial/:locale`) sirve el snapshot **activo**
almacenado. Publicar es una operación de operación, con responsable y motivo
(ADR-012).

Ensayo sin escribir, y publicación:

```powershell
npm run editorial:snapshot -- --publish --locale es-PE --operator "$env:USERNAME" --reason "ensayo" --dry-run
npm run editorial:snapshot -- --publish --locale es-PE --operator "$env:USERNAME" --reason "corte editorial"
```

La publicación se rechaza —sin escribir nada— ante hash inconsistente,
referencia faltante, identidad duplicada o schema incompatible. Los avisos
(medios sin derechos, referencias no publicadas) no bloquean: ese contenido
queda fuera del snapshot y se lista en la salida.

Inventario de versiones, con la activa marcada:

```powershell
npm run editorial:snapshot -- --list --locale es-PE
```

Rollback a una versión anterior ya validada (se recalculan sus hashes antes de
activarla; si está corrupta, no se activa):

```powershell
npm run editorial:snapshot -- --rollback v3 --locale es-PE --operator "$env:USERNAME" --reason "regresión en destinos"
```

Retención: se conservan las 5 versiones más recientes por locale; la activa y la
anterior nunca se descartan. Lo podado se informa en la salida.

**El export del lunes no se ve afectado.** `/v1/export/content-cache`,
`content:fetch` y `content:verify` del front siguen igual: publicar o revertir
un snapshot editorial no cambia su cuerpo ni su ETag.

El procedimiento completo de corte, verificación y rollback de Track B —con sus
gates P0, el ensayo y los nav-links— está en la sección 12.

### Comunicados (`announcements`) on/off

Interruptor: `isActive` del item (+ opcional `data.activeFrom` / `data.activeTo`
en UTC; `null` = sin límite). No hay setting global aparte. El front solo
muestra el modal (`nav-modal`) y la alerta home (`covid`) cuando el item está
live; sin fallback hardcodeado si está inactivo.

Claves naturales: `announcements/es-PE/covid` y `announcements/es-PE/nav-modal`.

Ocultar (sin cambiar lógica del front):

```powershell
# JSON revisado con isActive: false (mismo slug/locale/colección)
$changeFile = Read-Host 'Ruta del JSON editorial revisado'
npm run content:set -- --section items --file $changeFile
npm run content:publish -- --section items --key announcements/es-PE/covid --to published
# repetir publish para nav-modal si aplica
```

Activar: mismo flujo con `isActive: true`, body/título actualizados y, si hace
falta, ventana `activeFrom`/`activeTo`. Tras publicar:

```powershell
$env:CARRITO_EXPORT_FILE = Join-Path $env:TEMP 'carrito-content-cache.generated.json'
npm run content:export -- --out $env:CARRITO_EXPORT_FILE
# En carrito-front/ClientApp: npm run content:fetch && build del artefacto
```

Al cambiar el copy del modal, hacer bump de `data.dismissKey` para que vuelva a
mostrarse a quien ya lo cerró en `localStorage`. Esto refresca contenido; no
requiere redeploy de lógica TypeScript/Vue.

## 7. Export y comprobación del golden inicial

Generar un archivo temporal desde la base configurada:

```powershell
$env:CARRITO_EXPORT_FILE = Join-Path $env:TEMP 'carrito-content-cache.generated.json'
npm run content:export -- --out $env:CARRITO_EXPORT_FILE
```

Inmediatamente después de importar el golden inicial, verificar igualdad exacta
de datos, tokens, orden de claves y arrays, normalizando únicamente
`generatedAtUtc`:

```powershell
node --input-type=module -e "import fs from 'node:fs'; const expected=JSON.parse(fs.readFileSync('content-cache.json','utf8')); const actual=JSON.parse(fs.readFileSync(process.env.CARRITO_EXPORT_FILE,'utf8')); expected.generatedAtUtc=actual.generatedAtUtc; if(JSON.stringify(actual)!==JSON.stringify(expected)){console.error('Export distinto del golden');process.exit(1)} console.log('Export compatible con el golden');"
```

Tras publicaciones editoriales aprobadas, el contenido exportado puede diferir
del dataset inicial por diseño. En ese caso `npm run test:golden` sigue siendo
el gate de forma, orden y serialización, y el archivo de build debe validarse
antes de compilar `carrito-front`.

El contrato servidor-a-servidor, su descarga segura y el destino esperado por
el front se detallan en `docs/carrito-front-integration.md`.

## 8. Arranque y health checks

Compilar y arrancar:

```powershell
npm run build
npm start
```

Comprobar desde la misma red autorizada:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

- `GET /health/live`: `200` si el proceso responde; no toca MongoDB.
- `GET /health/ready`: `200` solo si responden ambas bases. Comprueba
  `carrito_content` y `carrito_forms` incluso si contacto y reclamos están
  desactivados. Ante un fallo devuelve `503 SERVICE_NOT_READY` sin detalles.

El balanceador usa readiness para admitir tráfico y liveness para detectar un
proceso bloqueado. Solo se confía en `X-Forwarded-For` recibido desde
`127.0.0.1`; ampliar el proxy confiable exige una decisión operativa.

El proceso maneja `SIGINT` y `SIGTERM` de forma idempotente, deja de aceptar
tráfico y espera el cierre de ambos clientes Mongo. Un cierre fallido o que
supere diez segundos termina con código de error.

## 9. Publicación de la release

F8 no ejecuta despliegues. Para una publicación posterior:

1. Conservar la release anterior disponible para rollback.
2. Inyectar el archivo externo de entorno sin copiarlo a la release.
3. Ejecutar los gates de la sección 4.
4. Aplicar únicamente el aprovisionamiento o migración previamente aprobados.
5. Arrancar la nueva instancia fuera del balanceador.
6. Confirmar liveness, readiness, export y rutas públicas.
7. Incorporarla al balanceador solo después de todas las verificaciones.

## 10. Incidentes y rollback seguro

1. Retirar la instancia afectada del balanceador cuando readiness falle.
2. Correlacionar por `x-request-id`. No solicitar ni copiar bodies de
   formularios, firma, adjuntos, IP, User-Agent, headers de autenticación ni
   claves de export a tickets o logs.
3. Para un fallo de aplicación, restaurar la release anterior conservando el
   mismo archivo externo de configuración compatible.
4. Para un fallo de configuración, restaurar la versión anterior del archivo
   externo y reiniciar de forma controlada.
5. Para contenido incorrecto, detener nuevas publicaciones, inspeccionar el
   estado editorial y corregir mediante un nuevo cambio revisado o archivar el
   registro afectado. No borrar colecciones ni bases.
6. Volver a ejecutar health checks y generar un export de verificación antes
   de reabrir tráfico.

Para una regresión del contenido editorial por bloques (destinos y servicios
servidos desde el snapshot v2), el procedimiento específico es el §12.6.

La importación inicial no es un mecanismo automático de rollback de contenido
editorial ya administrado. No ejecutar operaciones de borrado, `dropIndex` ni
reimportaciones sobre una base poblada para “volver atrás”. Cualquier
restauración de datos requiere respaldo verificado, plan específico y
autorización operativa fuera de este runbook.

## 11. Rotación y observabilidad

`EXPORT_API_KEYS` acepta como máximo dos claves. La secuencia de rotación es:

1. agregar la nueva manteniendo la anterior;
2. actualizar el proceso seguro de build;
3. verificar un export autenticado;
4. retirar la clave anterior.

Nunca imprimir, registrar o incorporar las claves en comandos con valores
literales. Los logs de la API contienen request id, método, ruta y categorías
de error sanitizadas; no contienen headers, IP ni cuerpos. El serializador de
`req` descarta la query a propósito, pero hay una excepción conocida: el
rechazo de `/docs` por allowlist registra `req.url` completo
(`src/docs/openapi.ts:181`), que sí incluye la query. El guard del editor
interno evita ese caso registrando `req.routeOptions.url`.

**Los fallos internos sí registran frames de stack** (desde `536cc5e`). Para un
5xx —y para `uncaughtException`/`unhandledRejection`, que `src/server.ts`
engancha para conservarlos en logs estructurados— el log incluye tipo, código,
`statusCode` y hasta 20 frames del stack, recortados a 4096 caracteres.
Lo que **nunca** se registra es el `message` del error: la primera línea del
stack (`Error: <mensaje>`) se elimina, porque puede llevar texto de negocio o
valores enviados. Los 4xx se registran sin stack. La respuesta HTTP sigue sin
stack ni detalles internos: la sanitización es del cuerpo público, no del log.
Los frames apuntan a rutas de archivo del despliegue, así que la captura de
stdout/stderr debe tener el mismo control de acceso que el resto de la release.
La aplicación no crea archivos de log. Antes de desplegar con NSSM:

1. Configurar `AppStdout` y `AppStderr` hacia rutas con acceso restringido.
2. Habilitar `AppRotateFiles` y `AppRotateOnline`, y fijar `AppRotateBytes`
   según el límite operativo aprobado.
3. Configurar una tarea externa de retención; NSSM rota, pero no aplica por sí
   solo el plazo de conservación.
4. Reiniciar el servicio y verificar que una petición aparece en el archivo
   capturado con su `x-request-id`, sin IP, query ni headers sensibles.

Con IIS u otro supervisor se exige el equivalente. No desplegar sin captura,
rotación y retención verificadas.

## 12. Corte de Track B (modelo editorial por bloques)

El corte cambia la fuente de `/destinos` y `/servicios` del contenido flat al
snapshot editorial v2. **No toca la venta, ni el Libro de Reclamaciones, ni
`/v1/export/content-cache`**: el export del soft-launch sigue byte a byte igual
a su golden durante todo el procedimiento, y el ensayo automatizado
(`test/integration/editorial-cutover.test.ts`) lo comprueba al final de cada
ejecución.

### 12.1 Prerrequisitos

- MongoDB **replica set**: publicar, revertir y `content:publish` son
  transacciones multi-documento (ADR-001). Standalone no sirve para el corte.
- Respaldo verificado de `carrito_content` inmediatamente antes de la ventana.
- Migración ya aplicada en la base objetivo (`editorial:migrate`, sin
  `--dry-run`) y contenido editorial revisado por quien corresponda.
- `EXPORT_API_KEYS` vigente y accesible desde el proceso de build del front.
- Responsable y motivo acordados: se almacenan con el snapshot y son la
  trazabilidad del corte (ADR-012). No son texto decorativo.
- Ventana anunciada y congelación de publicaciones editoriales mientras dure.

### 12.2 Ensayo (obligatorio antes del corte)

Contra staging con una copia de producción, en este orden y sin escribir nada:

```powershell
npm run editorial:validate -- --only-errors
npm run editorial:snapshot -- --publish --locale es-PE --operator "$env:USERNAME" --reason "ensayo de corte" --dry-run
npm run editorial:cutover-check
```

`editorial:cutover-check` es de **solo lectura** y emite el informe de gates P0
del plan editorial (doc 11) con verde/rojo por gate:

| Gate | Qué comprueba |
| ---- | ------------- |
| G1 · Integridad de datos | El grafo editorial existe, sus referencias (localidad, padre) resuelven y el origen flat sigue completo |
| G2 · Separación destino/punto | Ningún punto de embarque es destino, ni comparte identidad o slug con uno, ni aparece como destino en el snapshot |
| G3 · Publicación correcta | Todo documento **publicado** valida sin errores, sin URL canónica duplicada, y el snapshot activo supera checksum y manifest |
| G4 · Rollback | Toda versión almacenada del locale supera la verificación de integridad, es decir, se puede activar |

Sale con código **1** si algún gate P0 está en rojo, y **0** si todos pasan; los
avisos (`⚠`) no tumban el corte.

Dos aclaraciones que evitan una lectura equivocada del informe:

- `editorial:validate` sale con código 1 mientras haya puntos de embarque sin
  dirección o sin localidad verificada. Ese es el estado **esperado** al corte
  (decisiones P-04 y P-13): el punto existe, no se publica y su bloque sale
  vacío. Para decidir Go/No-Go manda `editorial:cutover-check`, que separa los
  errores de documentos publicados (P0, rojo) del gate de publicación de un
  punto (aviso).
- Los avisos de medios sin derechos verificados también son esperados: ese
  contenido se excluye del snapshot en vez de bloquear la página (ADR-011).

Si no hay MongoDB disponible, el mismo ensayo corre íntegro en memoria:

```powershell
npx vitest run test/integration/editorial-cutover.test.ts
```

Ese archivo ejecuta la secuencia completa —golden, migración de los 32
destinos, publicación del grafo, `validateEditorialGraph`, publicación del
snapshot, verificación de checksum y manifest, rollback y comparación final del
export vigente contra el golden— sobre `MongoMemoryReplSet`. **No sustituye al
ensayo contra staging**: no valida credenciales, topología real, latencia ni el
contenido realmente cargado en la base.

### 12.3 Ventana de corte, paso a paso

1. Anunciar la ventana y congelar publicaciones editoriales.
2. Respaldo de `carrito_content` verificado (restauración probada, no solo el
   volcado).
3. `npm run editorial:validate -- --only-errors` y resolver todo error de un
   documento que se vaya a publicar.
4. Publicar los documentos aprobados, por sección y por clave:

   ```powershell
   npm run content:publish -- --section localities   --key chiclayo --to published
   npm run content:publish -- --section services     --key bus-cama-vip --to published
   npm run content:publish -- --section destinations --key chiclayo --to published
   ```

   Publicar valida el documento completo: un bloque inválido, un tipo
   desconocido o una referencia rota impiden la publicación y el CLI lista cada
   motivo.

   No hay publicación masiva por CLI, y es deliberado: cada documento se
   publica por su clave. Con el catálogo completo son 72 documentos
   (32 localidades, 32 destinos, 3 servicios, 5 comodidades). Publicar en el
   orden localidades → comodidades → servicios → destinos evita avisos de
   referencia todavía no publicada.
5. Publicar el snapshot, primero en seco y luego de verdad:

   ```powershell
   npm run editorial:snapshot -- --publish --locale es-PE --operator "$env:USERNAME" --reason "corte Track B" --dry-run
   npm run editorial:snapshot -- --publish --locale es-PE --operator "$env:USERNAME" --reason "corte Track B"
   ```

   **Anotar en el acta**: versión (`vN`), `checksum` y `etag` que imprime el
   comando. Son la referencia para verificar el corte y para el rollback.
6. `npm run editorial:cutover-check` → los cuatro gates P0 en verde.
7. En `carrito-front/CarritoComprasFront/ClientApp`, descargar y verificar el
   snapshot:

   ```powershell
   npm run editorial:fetch
   node scripts/verify-editorial-snapshot.mjs
   ```

   El script npm `editorial:verify` lleva `--allow-missing` para que un
   checkout limpio compile sin snapshot. **En el corte real se quita esa
   bandera** del `package.json` del front (`"editorial:verify": "node
   scripts/verify-editorial-snapshot.mjs"`): a partir del corte, compilar sin
   snapshot válido es un fallo, no un caso tolerado.
8. Regenerar el cache flat y construir el artefacto:

   ```powershell
   npm run content:fetch
   npm run build:ci
   ```

   Ambos scripts del front empiezan por los dos gates de contenido:

   - `build` = `content:verify && editorial:verify && nuxt build &&
     seo:generate && copytowwwroot`;
   - `build:ci` = lo mismo **sin** `copytowwwroot` (no copia el artefacto a
     `wwwroot` del host .NET).

   El artefacto que se promueve a producción es el mismo que se probó.
9. Confirmar que `nav-destinos` y `nav-servicios` están activos (§12.5). En el
   dataset vigente **ya lo están** (`isActive: true` en el golden), así que este
   paso normalmente es una comprobación, no un cambio. Solo hay que ejecutar el
   `content:set` si alguien los apagó antes del corte; en ese caso, regenerar
   cache y artefacto después.
10. Desplegar el artefacto y ejecutar la verificación post-corte (§12.4).

### 12.4 Verificación post-corte

- `GET /v1/export/editorial/es-PE` devuelve la versión anotada en el paso 5 y su
  `ETag`; su `checksum` coincide con el del acta.
- `GET /v1/export/content-cache` devuelve **el mismo `ETag` y el mismo cuerpo**
  que antes del corte: publicar un snapshot editorial no mueve `contentVersion`
  (ADR-011).
- `npm run test:golden` en verde en este repositorio.
- `npm run editorial:cutover-check` en verde.
- En el front, comprobar a mano: `/destinos`, `/destinos/{slug}`,
  `/destinos/{padre}/{slug}`, `/servicios` y `/servicios/{slug}` responden con
  contenido; `/destino/{slug}` y `/servicio/{slug}` devuelven **301** a su URL
  canónica, y un slug inexistente cae en `/destinos` o `/servicios`.
- El menú muestra Destinos y Servicios (nav-links activos) y ninguna página
  editorial aparece vacía salvo las galerías sin derechos verificados, que es el
  comportamiento correcto.

**Límite conocido del 301.** El front se compila con `ssr: false` y preset
estático, así que `redirectCode: 301` es una navegación del router, no una
respuesta HTTP 301. El visitante acaba en la URL correcta, pero un buscador o un
enlace externo no ven la redirección permanente. Para que el 301 sea real, las
reglas `/destino/{slug} → /destinos/{slug}` y `/servicio/{slug} →
/servicios/{slug}` deben existir además en IIS/proxy. Es trabajo de la capa de
publicación, no de este repositorio, y conviene cerrarlo en la misma ventana.

### 12.5 `nav-destinos` y `nav-servicios`: encender y apagar

Los dos enlaces del menú son items de la colección flat `nav-links` y son el
interruptor de las dos secciones. Claves naturales:
`nav-links/es-PE/nav-destinos` y `nav-links/es-PE/nav-servicios`.

**Estado actual (2026-07-26):** ambos están `isActive: true` en
`content-cache.json` y, por tanto, en cualquier base importada desde el golden.
No existe ningún gating de rutas en el front: `/destinos` y `/servicios`
responden hoy. El corte no "quita" un gate; enciende el contenido detrás de dos
enlaces que ya están visibles.

**Apagar** (retirar ambas secciones del menú). JSON revisado, sin datos
personales, exactamente con esta forma:

```json
[
  {
    "collectionSlug": "nav-links",
    "localeCode": "es-PE",
    "slug": "nav-destinos",
    "sortOrder": 20,
    "isActive": false,
    "data": { "label": "Destinos", "to": "/destinos" }
  },
  {
    "collectionSlug": "nav-links",
    "localeCode": "es-PE",
    "slug": "nav-servicios",
    "sortOrder": 30,
    "isActive": false,
    "data": { "label": "Servicios", "to": "/servicios" }
  }
]
```

```powershell
$changeFile = Read-Host 'Ruta del JSON de nav-links revisado'
npm run content:set -- --section items --file $changeFile
```

**Encender**: el mismo JSON con `"isActive": true` y el mismo comando.

Detalles que evitan sorpresas:

- `content:set` sobre un item **ya publicado conserva su estado**: no hace falta
  `content:publish` después. Solo si el registro quedó en `draft` hay que
  publicarlo:
  `npm run content:publish -- --section items --key nav-links/es-PE/nav-destinos --to published`.
- No incluir `rowVersionToken`: lo deriva la revisión. Los valores de
  `sortOrder` y `data` deben ir completos: `content:set` reemplaza el registro,
  no lo parchea.
- Cada cambio confirmado incrementa `contentVersion` y renueva el `ETag` del
  export flat. Por eso, **sin redeploy de código** pero **sí** con refresco de
  contenido: `content:export` (o `content:fetch` desde el front) y build del
  artefacto de contenido. El front consume `content-cache.json` en build, no en
  runtime.
- Apagar los nav-links **no** apaga las rutas: `/destinos` y `/servicios` siguen
  respondiendo. Retiran el acceso desde el menú, que es lo que se necesita para
  un rollback rápido de visibilidad.

### 12.6 Rollback del corte

Tres palancas, de menor a mayor alcance. Ninguna borra datos: el contenido flat
de origen y todas las versiones del snapshot se conservan.

1. **Contenido editorial equivocado, con versión anterior disponible.**
   Revertir el snapshot a la versión validada anterior y regenerar el artefacto:

   ```powershell
   npm run editorial:snapshot -- --list --locale es-PE
   npm run editorial:snapshot -- --rollback v3 --locale es-PE --operator "$env:USERNAME" --reason "regresión en destinos"
   ```

   Revertir recalcula los hashes de la versión objetivo antes de activarla: si
   está corrupta, no se activa y el snapshot vigente no se toca. Después, en el
   front: `npm run editorial:fetch`, `node scripts/verify-editorial-snapshot.mjs`
   y build del artefacto.

2. **Primer corte, sin versión anterior a la que volver.** No existe snapshot
   previo que activar, así que el rollback es de visibilidad: apagar
   `nav-destinos` y `nav-servicios` (§12.5) y regenerar cache y artefacto. Eso
   retira el acceso desde el menú; las rutas siguen respondiendo con el estado
   vacío editorial. `editorial:cutover-check` avisa explícitamente cuando el
   locale tiene una sola versión almacenada.

   Volver a **servir las guías flat** es otra cosa y exige un artefacto del
   front anterior a la Fase 4: los índices `/destinos` y `/servicios` dejaron de
   leer las colecciones flat en esa fase, no en el corte. Los datos flat siguen
   en MongoDB, así que la vuelta atrás es posible, pero es un despliegue de
   código, no un cambio de contenido.

3. **Fallo del artefacto del front (build, assets, regresión de UI).**
   Restaurar el artefacto anterior probado en QA y **no** tocar el snapshot: el
   contenido publicado no es el problema y revertirlo añadiría una segunda
   variable a la incidencia.

Reglas duras del rollback:

- No borrar `editorial_snapshots`, las colecciones `editorial_*` ni las flat de
  origen. La retención (5 versiones por locale, con la activa y la anterior
  siempre protegidas) es lo que hace posible volver atrás.
- No reimportar el golden sobre una base poblada para "volver atrás": la
  importación inicial no es un mecanismo de rollback (§10).
- Todo `--rollback` exige `--operator` y `--reason` y queda registrado con el
  snapshot. Anotar en el acta la versión de la que se vino y a la que se fue.
- Tras cualquier rollback, repetir la verificación post-corte (§12.4),
  incluida la comprobación de que `/v1/export/content-cache` no se movió.
