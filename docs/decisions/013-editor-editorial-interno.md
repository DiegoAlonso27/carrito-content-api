# ADR-013: Editor editorial interno opt-in tras allowlist de IP

**Estado:** aceptado
**Fecha:** 2026-07-29 (registro; implementación en el repo desde 2026-07-28)
**Fases:** posterior a Track B — endurecimiento operativo

## Contexto

Hasta ahora **toda** escritura sobre `carrito_content` entraba por los CLI
privilegiados de `scripts/content/` (modelo de publicación de
[ADR-005](005-publication-model.md), consistencia transaccional de
[ADR-001](001-editorial-write-consistency.md)). La superficie HTTP era de solo
lectura: contenido público, export autenticado ([ADR-002](002-export-protection.md),
[ADR-012](012-export-editorial-v2.md)) y los dos formularios, que escriben en
`carrito_forms` —otra base— y nunca en el contenido editorial.

Eso significa que cambiar una frase de copy exigía acceso a la máquina, al
repositorio, a la cuenta de «Operador editorial» y un ciclo de CLI. Es la
fricción correcta para tocar la topología del contenido (colecciones, locales,
assets, referencias); es demasiada para los textos, las páginas y los ajustes
que cambian a diario.

Al mismo tiempo, este repositorio no quiere ser un CMS: no hay gestión de
usuarios, ni sesiones, ni roles, y añadirlos por un editor de copy sería
construir la mitad de un producto distinto.

## Decisión

La API sirve un **editor editorial interno** bajo `/internal/*`. Es la
**primera superficie HTTP de escritura sobre `carrito_content`** del proyecto,
y por eso se define por sus restricciones antes que por sus funciones:

1. **Apagado por defecto y, apagado, inexistente.** `INTERNAL_EDITOR_ENABLED`
   tiene default `false` (`src/shared/config/env.ts:186`). Con el flag apagado,
   `src/app.ts:103-114` **no registra** el plugin: no hay rutas que desactivar,
   y `/internal/edit` cae en el notFound estándar con la envolvente del
   proyecto. Ni siquiera un `404` distinto delata que la funcionalidad existe.
2. **Admisión por allowlist de IP, la misma que `/docs`.**
   `isClientIpAllowed` (`src/shared/security/ip-allowlist.ts:32-36`) es el
   único juez de las dos superficies internas, en un solo módulo para que no
   diverjan. Con `INTERNAL_EDITOR_ALLOWED_IPS` vacío —el default
   (`env.ts:192`)— rige **modo loopback estricto**: se exige socket loopback
   real y se **rechaza de plano cualquier petición que traiga
   `X-Forwarded-For`**, aunque el socket sea `127.0.0.1`
   (`src/modules/internal-editor/internal-editor.guard.ts:22-26`). El motivo es
   concreto: `buildApp` fija `trustProxy: '127.0.0.1'`, así que detrás de un
   proxy en la misma máquina `req.ip` se calcula desde esa cabecera; un proxy
   que la reenvíe sin anexar convertiría a cualquier cliente de Internet en
   loopback. En `/docs` ese fallo dejaba leer documentación; aquí dejaría
   escribir contenido publicado.
3. **`403`, no `404`, una vez encendido**
   (`internal-editor.guard.ts:64-74`). `/docs` oculta su existencia porque
   ocultarla es gratis; el editor ya fue encendido por una decisión explícita,
   así que un `403` le dice al operador que su IP no está en la lista en vez de
   hacerle perseguir un `404` fantasma.
4. **CSP propia por nonce, sin relajar helmet.** La página se sirve con
   `<style>`/`<script>` embebidos, que la CSP global de `@fastify/helmet`
   bloquearía. En vez de aflojar la política para toda la API, cada respuesta de
   `/internal/edit` genera un nonce y publica su propia cabecera
   `content-security-policy` con `default-src 'none'`
   (`internal-editor.routes.ts:37-54,300-314`). No se usa `'unsafe-inline'`:
   habría autorizado también cualquier inyección que llegara a colarse en el
   HTML.
5. **Persistencia reutilizada, sin DDL en runtime.** El editor no habla con
   Mongo directamente: llama a `setRecords` de `content-write.ts` y hereda sus
   validaciones, su sanitización de HTML y sus invariantes de publicación. Lo
   invoca con **`ensureSetup: false`** (`internal-editor.routes.ts:379-386`;
   `src/modules/content/content-write.ts:349-361`), de modo que la cuenta Mongo
   del proceso en ejecución **nunca necesita privilegios de esquema**.
6. **Guardar es publicar.** Los `PUT` pasan `{ publish: true }`: el cambio queda
   `published` de inmediato y sube `contentVersion`, lo que invalida el ETag del
   contenido público y el del export de build. No hay borrador ni previsualización
   en esta superficie.
7. **Control de concurrencia optimista.** El cuerpo lleva
   `expectedContentVersion` (`internal-editor.routes.ts:241-255`) y un valor
   desfasado se rechaza con `409 CONTENT_VERSION_CONFLICT` (`:369-376`); el
   `GET` lee la versión **antes** que los documentos, para que la ventana de
   carrera falle cerrada (`:329-342`). Sin esto, dos pestañas abiertas se pisan
   en silencio.
8. **Excluida deliberadamente del spec OpenAPI.** Todas sus rutas se registran
   con `schema: { hide: true }` (`internal-editor.routes.ts:296-359`) y la
   descripción del spec lo declara en prosa (`src/docs/openapi.ts:91-100`). Ver
   [ADR-009](009-openapi-docs.md).
9. **Superficie mínima: `texts`, `pages` y `settings`.** Nada más
   (`internal-editor.routes.ts:161-183`). `locales`, `collections`, `assets` e
   `items` siguen siendo territorio exclusivo de los CLI: tocan la topología del
   contenido y un error ahí rompe el bundle entero.

Complementos de la misma decisión: `cors: false` en todas las rutas del editor
(`internal-editor.routes.ts:289-294`) —`@fastify/cors` está envuelto en
`fastify-plugin` y, sin esto, reflejaría `Access-Control-Allow-Origin` para
cualquier origen de `CORS_ORIGINS`, dejando que un XSS del sitio público leyera
secciones completas desde el navegador del operador—, y un presupuesto propio
de **30 `PUT`/min por IP** (`:345-351`). Operación documentada en
[runbook.md §2 «Editor editorial interno»](../runbook.md).

## Alternativas consideradas

- **Autenticación de usuario (login, sesiones, roles)** — descartada: es
  construir un CMS. Traería almacenamiento de credenciales, recuperación de
  contraseña, expiración de sesión y un modelo de permisos, todo para un editor
  que un solo operador usa desde la máquina del servidor. La barrera elegida es
  la red, no la identidad, y eso se declara sin eufemismos en las consecuencias.
- **Exponer todas las secciones** (`locales`, `collections`, `assets`, `items`)
  — descartada: son la topología del contenido. Un `slug` mal escrito en
  `collections` o una referencia rota en `items` no degrada una página, invalida
  el bundle completo que consume `carrito-front`. Esa clase de cambio merece la
  fricción del CLI y su revisión.
- **Responder `404` en vez de `403` a una IP no permitida** (como hace `/docs`)
  — descartada: coherente en apariencia, inútil en la práctica. Encender el
  editor ya reveló la decisión; el `404` solo le costaría tiempo al operador
  legítimo que se equivocó de IP, sin ocultar nada a quien ya sabe que existe.
- **`ensureSetup: true`** (DDL idempotente en cada escritura, como en los CLI) —
  descartada: obligaría a que la cuenta Mongo del proceso —la que queda
  conectada de forma continua, no la de una invocación puntual de CLI— tenga
  privilegios de esquema sobre `carrito_content`. El DDL pertenece a la
  migración y a los CLI, que corren bajo demanda con la cuenta privilegiada.

## Consecuencias

- **Publicar desde el editor desincroniza los goldens, y nada lo detecta solo.**
  El contenido queda actualizado en `carrito_content`, pero el
  `content-cache.json` canónico de la raíz de este repositorio
  ([ADR-004](004-content-cache-golden-source.md)) y el `content-cache.json`
  **versionado** de `carrito-front` (ADR-0010 de `carrito-front`) siguen
  reflejando el estado anterior hasta que alguien reexporte y **commitee** en
  ambos repos. El gate de igualdad del golden no avisa: no ha cambiado ningún
  archivo. El procedimiento está en el runbook (§2, «Después de publicar»), y
  ejecutarlo es una obligación operativa, no una recomendación.
- **La única barrera efectiva es la red.** No hay autenticación de usuario: quien
  alcance el editor puede publicar. Por eso `INTERNAL_EDITOR_ALLOWED_IPS` vacío
  **detrás de un proxy** es una configuración de riesgo —el modo loopback
  estricto la neutraliza rechazando `X-Forwarded-For`, pero eso significa que el
  editor simplemente no funcionará a través del proxy, y la tentación será
  ensanchar la lista hasta que «funcione»—. El arranque emite un `warn` cuando
  el flag está encendido en producción (`src/app.ts:104-112`), y ese aviso es
  toda la señal automática que existe.
- **La allowlist compara por igualdad exacta.** Sin CIDR, sin rangos, sin
  wildcards (`src/shared/security/ip-allowlist.ts:32-36`; lo único que
  normaliza es la forma IPv4-mapeada-en-IPv6). Una red de operadores con IP
  dinámica no se puede expresar aquí: hay que enumerar direcciones o usar túnel
  SSH hasta loopback.
- **La cuenta Mongo del runtime sube de privilegio mientras el editor esté
  encendido.** Deja de bastar la cuenta de solo lectura de «Runtime de
  contenido»: necesita lectura/escritura continua sobre las colecciones
  editoriales de `carrito_content` (runbook §3). No necesita DDL, y eso es
  precisamente lo que compra el punto 5 de la decisión.
- **Escribir exige replica set.** Las escrituras son transacciones
  multi-documento ([ADR-001](001-editorial-write-consistency.md)): contra un
  Mongo standalone el editor responde `503` al guardar, aunque la lectura de las
  secciones siga funcionando.
- **El spec deja de ser el inventario completo de la superficie HTTP** mientras
  el editor esté encendido (ver [ADR-009](009-openapi-docs.md)). Es el precio
  aceptado de no publicar un mapa de la superficie de escritura.
- Positivas: editar copy deja de exigir repositorio y CLI; el editor hereda
  íntegras las validaciones y la sanitización de los CLI, así que no abre un
  segundo camino con reglas propias; apagarlo es un flag y un reinicio, y no
  deja rutas residuales.
