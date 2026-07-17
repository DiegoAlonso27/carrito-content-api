# CLAUDE.md

Las reglas del proyecto viven en [AGENTS.md](AGENTS.md) — leerlo antes de
trabajar. Este archivo solo contiene adaptaciones específicas de Claude Code:

- Ejecutar pruebas con `npm test` (la primera corrida descarga el binario de
  mongod para mongodb-memory-server; puede tardar).
- `npm run typecheck` y `npm run lint` deben quedar verdes antes de cerrar
  cualquier tarea.
- No commitear ni pushear sin autorización expresa del usuario (regla dura,
  ver AGENTS.md).
