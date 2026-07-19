# carrito-content-api

API independiente (Fastify + TypeScript + MongoDB) que entrega el contenido editorial
publicado a `carrito-front`, expone el export compatible con `content-cache.json`
para el build del front, y recibe los formularios de contacto y el Libro de
Reclamaciones (este último se activa solo tras la validación legal).

Reglas del proyecto para personas y agentes: ver [AGENTS.md](AGENTS.md).
Decisiones y plan por fases: `docs/decisions/` (ADRs, desde F1).

## Requisitos

- Node.js >= 22 (LTS)
- MongoDB local para desarrollo con datos reales (las pruebas usan
  `mongodb-memory-server` y no requieren instalación)

## Puesta en marcha

```bash
npm install
copy .env.example .env   # ajustar valores locales
npm run setup:contact     # una vez: colección contact_messages
npm run dev              # servidor con recarga
```

Verificación rápida:

```bash
curl http://127.0.0.1:3000/health/live    # 200 siempre que el proceso viva
curl http://127.0.0.1:3000/health/ready   # 200 solo si MongoDB responde
```

## Formulario de contacto (F5)

- `POST /v1/contact` — activo por defecto (`FEATURE_CONTACT_ENABLED=true`).
- Kill-switch: `FEATURE_CONTACT_ENABLED=false`.
- En producción hace falta `MONGO_URI_FORMS` distinto de `MONGO_URI` (ADR-003).
- Aprovisionar índices/validador con `npx tsx scripts/forms/setup-contact.ts`
  (cuenta con DDL; el runtime no crea la colección).

## Scripts

| Comando                              | Descripción                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `npm run dev`                        | desarrollo con recarga (tsx watch)                                 |
| `npm test`                           | pruebas (vitest; la primera corrida descarga el binario de mongod) |
| `npm run typecheck`                  | verificación de tipos estricta                                     |
| `npm run lint` / `npm run format`    | linting y formato                                                  |
| `npm run build` / `npm start`        | build a `dist/` y arranque de producción                           |
| `npm run setup:contact`              | aprovisiona contacto con una cuenta Mongo de migración             |
| `npm run setup:complaints`           | aprovisiona reclamos; no activa el gate legal                      |
| `npm run migrate:cache -- --dry-run` | valida la migración inicial sin escribir                           |

## Seguridad

- `.env` nunca se versiona; en producción vive fuera del repo (`CARRITO_ENV_FILE`).
- MongoDB solo escucha en `127.0.0.1` y nunca se expone a Internet.
- Los datos personales (contacto/reclamos) viven en una base separada del
  contenido editorial, con credenciales propias.

Operación, despliegue, health checks, permisos y cierre ordenado:
[`docs/runbook.md`](docs/runbook.md).
