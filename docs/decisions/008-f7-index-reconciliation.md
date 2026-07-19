# ADR-008: Índices alineados con consultas y reconciliación no destructiva

**Estado:** aceptado  
**Fecha:** 2026-07-19  
**Fases:** F7

## Contexto

La revisión transversal F7 encontró tres índices que no correspondían a
consultas runtime:

- `ix_items_col_locale_status_sort` comenzaba por `collectionSlug`, pero el
  bundle consulta items por `localeCode + status`; el filtro por colección y
  el orden contractual se aplican después en memoria.
- `ix_contact_messages_created_at` e `ix_complaints_created_at` anticipaban
  listados de un panel administrativo fuera de fase 1.

Los índices pueden existir ya en entornos aprovisionados. Eliminarlos desde un
setup idempotente convertiría una actualización rutinaria en DDL destructivo
sin revisión del operador.

## Decisión

1. Reemplazar la creación de `ix_items_col_locale_status_sort` por
   `ix_items_locale_status`, que coincide con la consulta pública real.
2. Dejar de crear los índices por `createdAtUtc` de contacto y reclamos hasta
   que exista una consulta aprobada que los justifique.
3. Mantener el ordenamiento en memoria: forma parte de la construcción
   determinista que protege el contrato golden F2.
4. La reconciliación solo detecta y reporta los nombres obsoletos conocidos.
   Ningún runtime, setup ni reporte ejecuta `dropIndex`.
5. El operador decide cualquier eliminación tras revisar uso, entorno y plan
   de rollback. Ejecutar DDL real queda fuera de F7.

## Consecuencias

- Instalaciones nuevas reciben únicamente índices vinculados a consultas
  actuales y conservan la convención `ux_`/`ix_`.
- Instalaciones existentes pueden mantener temporalmente índices redundantes;
  `npm run indexes:obsolete` permite identificarlos sin modificar la base.
- Un futuro panel administrativo deberá justificar sus consultas e índices en
  su propia fase; no hereda índices especulativos de F7.
- El gate golden sigue siendo obligatorio cuando cambie cualquier superficie
  compartida de contenido.
