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
