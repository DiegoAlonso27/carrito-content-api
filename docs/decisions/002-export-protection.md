# ADR-002: Protección y serialización del export `/v1/export/content-cache`

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Fases:** F2–F3

## Contexto

El export debe ser byte-compatible con `content-cache.json` (orden de claves y
arrays). AGENTS.md exige response schemas TypeBox en `/v1` como barrera
anti-fuga. `fast-json-stringify` (serializer por schema de Fastify) no
garantiza el mismo orden de claves que `JSON.stringify` del objeto construido
por los mappers.

## Decisión

1. **Headers TypeBox** en la ruta (`x-export-key`, `if-none-match`) y schemas
   de respuesta para **304** y **401**.
2. **Cuerpo 200:** se valida la forma con `contentCacheSchema` (TypeCompiler)
   en `ExportService.build` antes de cachear; se serializa con
   `JSON.stringify` del objeto de los mappers; se envía como string JSON ya
   formado. No se aplica response schema Fastify al 200.
3. **API keys:** máximo 2 claves; cada una ≥ 32 caracteres; vacío = endpoint
   deshabilitado (401).
4. **Golden:** la raíz `content-cache.json` es canónica; la copia en
   `test/contract/golden/` debe ser byte-idéntica (gate de prueba). El CLI
   `content-export` rechaza escribir sobre cualquiera de esas dos rutas.

## Consecuencias

- El gate golden sigue siendo la prueba de contrato.
- Cualquier campo nuevo debe entrar por mappers + `contentCacheSchema` o el
  builder falla antes de servir.
- OpenAPI del 200 documenta la forma vía el schema compartido en código; la
  ruta HTTP no re-serializa el cuerpo.
