# ADR-004: Fuente única del contrato `content-cache.json`

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Fases:** F2

## Contexto

AGENTS.md declara el `content-cache.json` de la raíz como contrato/golden del
export y fuente de la migración inicial. Existía una copia en
`test/contract/golden/` usada por el test de contrato, con riesgo de divergencia.

## Decisión

1. **Canónico:** `content-cache.json` en la raíz del repositorio.
2. **Copia contractual:** `test/contract/golden/content-cache.json` debe
   permanecer **byte-idéntica**; el test de contrato lo verifica en
   `beforeAll` y carga el golden desde la raíz.
3. **Cambios de contrato:** solo con decisión explícita; actualizar raíz y
   copia en el mismo cambio; no reformatear de paso.
4. **CLI `content-export`:** no puede escribir sobre ninguna de las dos rutas
   (ADR-002 / M5).

## Consecuencias

- Un cambio solo en la raíz rompe el gate de igualdad.
- Un cambio solo en la copia contractual también.
- La migración y el contrato comparten la misma fuente efectiva.
