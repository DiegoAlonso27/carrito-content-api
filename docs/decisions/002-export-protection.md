# ADR-002: Protección y serialización del export `/v1/export/content-cache`

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Actualizado:** 2026-07-17 (barrera Fastify 200 sin serializer personalizado)  
**Fases:** F2–F3

## Contexto

El export debe ser byte-compatible con `content-cache.json`. AGENTS.md exige
que los response schemas de Fastify sean la barrera anti-fuga en `/v1`.

## Decisión

1. **Headers TypeBox** (`x-export-key`, `if-none-match`).
2. **Response schemas:** `200: contentCacheSchema`, `304`, `401`.
3. **Cuerpo 200:** la ruta devuelve el objeto del cache; Fastify lo serializa
   con el serializer compilado desde `contentCacheSchema` (sin
   `reply.serializer()` personalizado). El builder (`ExportService`) valida
   además con TypeCompiler antes de cachear.
4. El **test de contrato golden** demuestra que esa serialización conserva
   el orden de claves y el cuerpo byte-compatible (salvo `generatedAtUtc`).
5. **API keys:** máx. 2; cada una ≥ 32 caracteres; vacío = 401.
6. **Golden:** raíz canónica; copia contractual byte-idéntica; CLI no
   sobrescribe ninguna.

## Consecuencias

- La barrera anti-fuga runtime es el response schema Fastify (cumple AGENTS.md).
- Si un cambio de schema/serializer rompe el orden, falla el gate golden.
- TypeCompiler en el builder sigue como defensa en profundidad previa al cache.
