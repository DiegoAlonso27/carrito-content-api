# ADR-003: Separación de credenciales de formularios en producción

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Fases:** F1 / F5

## Contexto

AGENTS.md exige datos personales en `carrito_forms` con usuario Mongo propio,
separado de `carrito_content`. En desarrollo local es práctico un único mongod
y reutilizar `MONGO_URI`.

## Decisión

- Con **`FEATURE_CONTACT_ENABLED=true`** (default tras cierre F5) y
  `NODE_ENV=production`, `MONGO_URI_FORMS` es obligatorio y distinto de
  `MONGO_URI`.
- Con contacto desactivado (kill-switch) no se exige `MONGO_URI_FORMS`
  aunque el entorno sea producción.
- En development/test se permite `MONGO_URI_FORMS` vacío (reutiliza
  `MONGO_URI`).
- `MONGO_DB_CONTENT` y `MONGO_DB_FORMS` nunca pueden ser el mismo nombre
  (cualquier entorno).

## Consecuencias

- Un despliegue de producción mal configurado no arranca.
- Tests y desarrollo local pueden omitir `MONGO_URI_FORMS`.
