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

`X-Export-Key` es una credencial servidor-a-servidor exclusiva del build. No
se guarda en el repositorio, no se entrega al navegador y nunca se publica como
`NUXT_PUBLIC_*`.

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
- items: 83.

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
de error sanitizadas; no contienen query string, headers, IP ni cuerpos.

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

   `build` y `build:ci` ejecutan `content:verify && editorial:verify && nuxt
   build`. El artefacto que se promueve a producción es el mismo que se probó.
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
