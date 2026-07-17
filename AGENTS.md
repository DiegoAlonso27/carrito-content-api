# AGENTS.md — Reglas centrales del proyecto

Fuente única de reglas para cualquier agente de IA o persona que trabaje en este
repositorio. Los archivos específicos de herramientas (CLAUDE.md, etc.) solo
referencian este documento.

## Qué es este proyecto

API independiente (Fastify 5 + TypeScript estricto + MongoDB, Node 22) para:
contenido editorial publicado, export compatible con `content-cache.json`
(consumido por `carrito-front` en build), formulario de contacto y Libro de
Reclamaciones (Perú). Monolito modular. Sin panel administrativo en fase 1.

- Plan por fases aprobado (F0–F8) y decisiones: registro del 2026-07-17.
- El archivo `content-cache.json` de la raíz es el contrato/golden del export
  y la fuente de la migración inicial. No modificarlo ni formatearlo.
- Requisitos funcionales de formularios heredados de
  `d:\PROYECTOS\c-sharp\carrito-front\docs\plans\formularios-backend-csharp.md`.

## Límites duros (no negociables)

- Nada de ventas, pagos, autenticación de clientes, tokens del sistema de
  ventas, ni integración con la BD de ventas.
- Prohibido introducir Redis, colas externas, microservicios, GraphQL,
  Kubernetes, CDN o infraestructura especulativa.
- El endpoint de reclamos permanece tras `FEATURE_COMPLAINTS_ENABLED=false`
  hasta que se cierre el gate legal (P1–P18); su activación es un cambio de
  configuración aprobado por el usuario, nunca un despliegue.
- Sin commits, push, ramas, tags ni cambios de historial sin autorización
  expresa del usuario en cada ocasión.

## Seguridad y privacidad

- Secretos solo en `.env` (fuera del repo en producción). Nunca en código,
  docs, logs ni tests.
- Los documentos de MongoDB nunca salen crudos: DTOs explícitos bajo `/v1`,
  sin `_id`. Los response schemas de Fastify son la barrera anti-fuga.
- Datos personales en `carrito_forms` (usuario Mongo propio), separados de
  `carrito_content`. No persistir IP/User-Agent (pendiente P7; si se aprueba:
  HMAC-SHA-256 con clave rotable).
- Logs estructurados sin datos personales; `redact` en headers sensibles.
  Los binarios de firma/adjuntos de reclamos jamás aparecen en logs, DTOs
  ni correos.
- Errores: envolvente `{ error: { code, message, requestId, details? } }`,
  sin stack traces ni detalles internos.
- Toda entrada externa se valida en el borde con TypeBox (JSON Schema).
- Fechas en ISO 8601 UTC.

## Código

- TypeScript estricto: sin `any`, sin `@ts-ignore` sin justificación, sin
  promesas sueltas, sin excepciones silenciosas.
- Módulos = plugins Fastify (`src/modules/*`); persistencia solo en `*.repo.ts`;
  sin capas triviales (content no lleva service).
- Dependencias nuevas requieren aprobación previa del usuario.
- Comentarios solo para decisiones, restricciones y riesgos no evidentes.
- Convenciones: archivos kebab-case con sufijo de rol; colecciones snake_case;
  índices `ux_`/`ix_`; Conventional Commits; trunk-based sobre `main`.

## Pruebas y cierre de tareas

- Cada funcionalidad incluye o actualiza pruebas (vitest +
  mongodb-memory-server). Nunca afirmar que una prueba pasó sin ejecutarla.
- El test de contrato golden-file del export (F2) es el gate central: si un
  cambio lo rompe, el cambio está mal salvo decisión explícita de contrato.
- Al cerrar un bloque: informar archivos creados/modificados, pruebas
  ejecutadas con resultados, pruebas no ejecutadas con motivo, riesgos y
  decisiones nuevas (registrar ADR en `docs/decisions/` si corresponde).

## Registro de errores y aprendizajes

- Cuando un modelo, agente o persona cometa un error relevante durante el
  trabajo, añadir aquí una regla breve y accionable para prevenir su
  repetición.
- Registrar el aprendizaje, no una transcripción del incidente: incluir qué
  evitar y la conducta correcta. Omitir culpables, conversaciones, datos
  personales, secretos, tokens, valores de `.env` y detalles internos.
- No registrar fallos transitorios ni preferencias aisladas; consolidar solo
  errores repetibles, de impacto o que revelen una restricción del proyecto.
- Si el aprendizaje es específico de una decisión arquitectónica, registrarlo
  también como ADR en `docs/decisions/` cuando corresponda.
