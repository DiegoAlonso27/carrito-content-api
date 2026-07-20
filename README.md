# carrito-content-api

API independiente de contenido editorial y formularios para `carrito-front`,
construida con Fastify 5, TypeScript estricto, MongoDB y Node.js 22. El Libro
de Reclamaciones está implementado, pero permanece bloqueado hasta cerrar el
gate legal P1–P18.

Reglas vinculantes: [AGENTS.md](AGENTS.md). Contratos y operación:

- [Contrato HTTP](docs/api-contract.md)
- [Runbook operativo](docs/runbook.md)
- [Integración con carrito-front](docs/carrito-front-integration.md)
- [Cierre y backlog de F8](docs/f8-closure.md)
- [Decisiones arquitectónicas](docs/decisions/)

`content-cache.json` es la fuente de la migración inicial y el golden canónico
del export. No debe editarse, reformatearse ni usarse como destino de un CLI.

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
| `npm run indexes:obsolete`           | Reporte de solo lectura; nunca elimina índices.       |

## Límites de seguridad

- El export de build usa `X-Export-Key` solo servidor-a-servidor. La clave
  jamás se expone al navegador ni se guarda en una variable `NUXT_PUBLIC_*`.
- En producción, contenido y formularios usan credenciales Mongo distintas.
- Los logs no contienen bodies, IP, User-Agent, headers sensibles ni datos
  personales de los formularios.
- `FEATURE_COMPLAINTS_ENABLED=false` y
  `COMPLAINTS_LEGAL_GATE_CLEARED=false` permanecen sin cambios hasta una
  autorización expresa posterior al cierre P1–P18.
