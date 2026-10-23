# ADR-015: content-api fuera de uso; el contenido editorial vive a mano en `carrito-front`

**Estado:** aceptado (temporal)
**Fecha:** 2026-10-17
**Fases:** operación — contrato compartido con `carrito-front`

## Contexto

Por ahora `carrito-content-api` no se está usando para el contenido editorial.
`carrito-front` versiona su `content-cache.json` y el usuario lo edita a mano
(ADR-0035 de `carrito-front`, que registra la decisión completa).

## Decisión

- El export `/v1/export/content-cache` y el `content-cache.json` de raíz de
  este repo **no son fuente de verdad** mientras dure esta situación: pueden
  estar desfasados respecto al JSON del front.
- No regenerar el JSON del front desde esta API ni migrar su contenido sin
  decisión explícita del usuario.
- El código, los tests y el contrato del export no cambian; la API sigue
  siendo válida cuando se reactive.
- Los endpoints de formularios (`/v1/contact`, `/v1/complaints`) siguen
  siendo los que consume el navegador del front (ADR-0011 de `carrito-front`);
  si la API no está desplegada, esos formularios no funcionan.

## Consecuencias

- Al reactivar: reconciliar primero el JSON editado a mano del front con la
  base/golden de esta API (ver ADR-0035 de `carrito-front`) y registrar un ADR
  que reemplace a este.
