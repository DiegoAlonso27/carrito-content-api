# carrito-content-api

API independiente de contenido editorial y formularios para `carrito-front`,
construida con Fastify 5, TypeScript estricto, MongoDB y Node.js 22. El Libro
de Reclamaciones está implementado, pero permanece bloqueado hasta cerrar el
gate legal P1–P18.

Reglas vinculantes: [AGENTS.md](AGENTS.md). Contratos y operación:

- [Contrato HTTP](docs/api-contract.md)
- [Runbook operativo](docs/runbook.md)
- [Paridad de validaciones front ↔ API](docs/validation-parity.md)
- [Integración con carrito-front](docs/carrito-front-integration.md)
- [Cierre de F8 (documento histórico)](docs/f8-closure.md)
- [Decisiones arquitectónicas](docs/decisions/)

`content-cache.json` es la fuente de la migración inicial y el golden canónico
del export. **No se edita a mano, no se reformatea y nunca es el destino de un
CLI** (`content:export` escribe siempre en otra ruta). Eso no significa que sea
inmutable: se **sincroniza** cuando se publica contenido editorial, en un
commit de contenido dedicado que en el mismo cambio actualiza los conteos de
`test/integration/import-cache.test.ts`. Dejar ese test en rojo hace que la
siguiente tarea no pueda distinguir un fallo propio de uno heredado
(AGENTS.md — Lecciones). Su copia contractual
`test/contract/golden/content-cache.json` debe quedar byte-idéntica: eso es lo
que comprueba `npm run test:golden`.

## Requisitos

- Node.js 22 o posterior.
- npm con instalación reproducible mediante `npm ci`.
- MongoDB accesible para operación real. Importación, lectura y export toleran
  standalone; las mutaciones editoriales requieren replica set.
- Las pruebas usan MongoDB efímero mediante `mongodb-memory-server`.

## Arranque local

```powershell
npm ci
Copy-Item .env.example .env
npm run setup:contact
npm run migrate:cache -- --dry-run
npm run migrate:cache
npm run dev
```

Antes de ejecutar una importación real, revisar las URI y nombres de base del
`.env`. La importación escribe en `MONGO_DB_CONTENT`; no debe apuntarse a una
base poblada sin revisión operativa.

Verificación rápida, en otra terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

`/health/ready` comprueba tanto `carrito_content` como `carrito_forms`, incluso
si contacto y reclamos están desactivados.

## Comandos

| Comando                              | Uso                                                   |
| ------------------------------------ | ----------------------------------------------------- |
| `npm run dev`                        | Servidor local con recarga.                           |
| `npm run build` / `npm start`        | Compilar y ejecutar el artefacto de producción.       |
| `npm run typecheck`                  | TypeScript estricto sin emitir archivos.              |
| `npm run lint`                       | Reglas ESLint del proyecto.                           |
| `npm run format`                     | Comprobar formato sin escribir.                       |
| `npm run format:write`               | Aplicar el formato Prettier al repositorio.           |
| `npm test`                           | Suite completa de Vitest.                             |
| `npm run test:golden`                | Gate F2 del export contra el golden.                  |
| `npm run setup:contact`              | Validador e índices de `contact_messages`.            |
| `npm run setup:complaints`           | Aprovisiona reclamos sin habilitar el endpoint.       |
| `npm run migrate:cache -- --dry-run` | Preflight del golden sin escribir.                    |
| `npm run migrate:cache`              | Importación inicial idempotente con verificación.     |
| `npm run content:status`             | Resumen o listado del estado editorial.               |
| `npm run content:set`                | Crear o editar contenido; nuevo contenido nace draft. |
| `npm run content:publish`            | Cambiar entre draft, published y archived.            |
| `npm run content:export`             | Export local a una ruta distinta de los golden.       |
| `npm run editorial:migrate`          | Migración flat → modelo por bloques; no publica nada. |
| `npm run editorial:validate`         | Valida el grafo editorial sin escribir.               |
| `npm run editorial:snapshot`         | Publica, lista o revierte snapshots del export v2.    |
| `npm run editorial:cutover-check`    | Informe de gates P0 del corte Track B; solo lectura.  |
| `npm run indexes:obsolete`           | Reporte de solo lectura; nunca elimina índices.       |

## Límites de seguridad

- El export de build usa `X-Export-Key` solo servidor-a-servidor. La clave
  jamás se expone al navegador ni se guarda en una variable `NUXT_PUBLIC_*`.
- En producción, contenido y formularios usan credenciales Mongo distintas.
- Los logs no contienen bodies, IP, User-Agent, headers sensibles ni datos
  personales de los formularios. Los 5xx sí registran frames de stack
  sanitizados (sin el `message`); ver runbook §11.
- La aplicación emite logs estructurados solo por stdout; el despliegue debe
  configurar NSSM/IIS para capturar, rotar y retener los archivos.
- Dos superficies condicionales, ambas con allowlist de IP de igualdad exacta
  (sin CIDR ni rangos):
  - `/docs*` (`DOCS_ENABLED`, default `auto`): OpenAPI y Swagger UI, solo
    lectura. `auto` significa **encendida en `NODE_ENV=development` y apagada
    en producción**. La allowlist solo se evalúa en producción: allí responde
    `404` a quien no esté en ella; fuera de producción no se aplica.
  - `/internal/*` (`INTERNAL_EDITOR_ENABLED`): editor editorial **de
    escritura**, sin autenticación de usuario; guardar publica de inmediato.
    Con el flag apagado no se registra ninguna ruta. Ver runbook.
- `FEATURE_COMPLAINTS_ENABLED=false` y
  `COMPLAINTS_LEGAL_GATE_CLEARED=false` permanecen sin cambios hasta una
  autorización expresa posterior al cierre P1–P18.
