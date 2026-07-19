# Runbook operativo

Este documento cubre la operación de `carrito-content-api` sin ampliar el
alcance funcional F0–F7. `AGENTS.md` y los ADR de `docs/decisions/` siguen
siendo vinculantes.

## Configuración y secretos

- Producción debe inyectar `CARRITO_ENV_FILE` apuntando a un archivo fuera del
  repositorio y de la release. Si la ruta explícita no existe, el proceso no
  arranca.
- Copiar los nombres y valores seguros desde `.env.example`; nunca copiar
  secretos a código, documentación, tests, logs ni comandos registrados.
- `MONGO_URI` y `MONGO_URI_FORMS` deben usar usuarios Mongo distintos en
  producción. La API valida que las URI sean distintas, pero un operador debe
  comprobar también usuarios y privilegios reales.
- `CORS_ORIGINS` solo admite orígenes exactos `http(s)://host[:puerto]`. Vacío
  mantiene CORS cerrado; `*` está prohibido.
- `FEATURE_COMPLAINTS_ENABLED=false` y
  `COMPLAINTS_LEGAL_GATE_CLEARED=false` permanecen así hasta una autorización
  explícita posterior al cierre P1–P18.

## Privilegios MongoDB

Usar cuentas distintas para migración y runtime:

- Migración de contenido: DDL y escritura sobre `carrito_content`.
- Runtime de contenido: lectura sobre colecciones editoriales y `meta`.
- Migración de formularios: DDL sobre `carrito_forms`.
- Runtime de contacto: `find`/`insert` en `contact_messages`, sin DDL.
- Runtime de reclamos, cuando el gate legal sea habilitado: `find`/`insert` y
  actualización acotada de `emailDispatch` en `complaints`, sin DDL.

Verificar en producción que MongoDB solo sea accesible desde la red necesaria;
no exponer el puerto a Internet.

## Aprovisionamiento

Ejecutar con la cuenta de migración correspondiente, nunca con la cuenta del
runtime:

```text
npm run setup:contact
npm run setup:complaints
```

El segundo comando solo prepara colección, validador e índices. No habilita el
Libro de Reclamaciones ni modifica sus flags.

Reporte de índices obsoletos conocidos, de solo lectura:

```text
npm run indexes:obsolete
```

El reporte nunca ejecuta `dropIndex`. Los scripts de setup tampoco eliminan
índices: si detectan uno obsoleto, solo imprimen su nombre para que el operador
decida posteriormente.

Migración inicial de contenido:

```text
npm run migrate:cache -- --dry-run
npm run migrate:cache
```

La verificación post-importación está activa por defecto. No modificar ni usar
como destino `content-cache.json` ni su copia contractual.

## Health checks

- `GET /health/live`: `200` si el proceso puede responder; no toca MongoDB.
- `GET /health/ready`: `200` solo si responden `carrito_content` y
  `carrito_forms`; ante cualquier fallo devuelve `503 SERVICE_NOT_READY` sin
  detalles internos.

El balanceador o IIS/ARR debe usar readiness para decidir si enruta tráfico y
liveness únicamente para detectar un proceso bloqueado. La confianza en
`X-Forwarded-For` está restringida a `127.0.0.1`; ampliar ese límite requiere
una decisión operativa explícita.

## Arranque y cierre

Antes de publicar una release:

```text
npm run typecheck
npm run lint
npm test
npm run build
```

El servicio atiende `SIGINT` y `SIGTERM` de forma idempotente: deja de aceptar
tráfico y espera el cierre de ambos clientes MongoDB. Un fallo de cierre marca
el código de salida como error; si el cierre no termina en 10 segundos, fuerza
la salida con código 1. Los fallos internos conservan frames de código para
diagnóstico, pero nunca la primera línea del stack que contiene `message`.

## Incidentes y rollback

1. Retirar la instancia del balanceador si readiness falla.
2. Correlacionar por `x-request-id`; no solicitar ni copiar cuerpos de
   formularios, headers de autenticación, IP o User-Agent a logs.
3. Corregir configuración o restaurar la release anterior sin cambiar datos ni
   flags legales.
4. Para contenido, verificar el export contra el golden antes de reabrir
   tráfico. La importación es idempotente y `--verify` es el comportamiento por
   defecto.
5. No ejecutar `dropIndex`, borrados de bases ni otras operaciones destructivas
   sin revisión y autorización operativa explícitas.

La rotación de `EXPORT_API_KEYS` admite como máximo dos claves simultáneas:
agregar la nueva, actualizar el consumidor y retirar la anterior. Nunca
registrar las claves durante la verificación.
