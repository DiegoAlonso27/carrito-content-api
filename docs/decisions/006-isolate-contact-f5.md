# ADR-006: Formulario de contacto (F5) y kill-switch operativo

**Estado:** aceptado — F5 cerrado  
**Fecha:** 2026-07-17  
**Fases:** F5

## Contexto

Durante la remediación F1–F4, M8 aisló el endpoint de contacto
(`FEATURE_CONTACT_ENABLED=false`) para no mezclar F5 en la línea base
auditada. El módulo ya implementaba el contrato heredado
(`formularios-backend-csharp.md` § POST /api/contactos).

## Decisión (cierre F5)

1. **F5 cerrado:** `POST /v1/contact` forma parte de la API.
2. **`FEATURE_CONTACT_ENABLED` default `true`.** `false` queda como
   kill-switch operativo (análogo al patrón de gates por config de
   AGENTS.md), no como “fase pendiente”.
3. Con contacto habilitado en **producción**, `MONGO_URI_FORMS` es
   obligatorio y distinto de `MONGO_URI` (ADR-003).
4. DDL de `contact_messages` solo vía `scripts/forms/setup-contact.ts`
   (cuenta de migración); el runtime no ejecuta DDL (contact.repo.ts).
5. Sin panel admin en fase 1: alta pública + campos `isViewed` /
   `viewedAtUtc` / `viewedBy` preparados para lectura posterior.

## Consecuencias

- Arranque local / test con default: contacto activo.
- Desactivar contacto en un entorno: `FEATURE_CONTACT_ENABLED=false`.
- Producción con contacto: fallar rápido si faltan credenciales forms.
