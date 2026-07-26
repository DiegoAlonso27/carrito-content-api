# ADR-011: Modelo editorial por bloques (Track B)

**Estado:** aceptado
**Fecha:** 2026-07-26
**Fases:** Track B / Fase 2 (`editorial-api-model`)

## Contexto

El contrato editorial aprobado (`web-tc-docs/plan-editorial-web-tc/`, docs 02–05)
pide destinos compuestos por bloques reutilizables, con localidades, puntos de
embarque y servicios de transporte como entidades propias.

El modelo vigente es plano: `content_items` con un `data` libre por colección.
Es el que alimenta `content-cache.json` y su golden, que es el gate central del
proyecto y el contrato del soft-launch. No puede romperse.

## Decisión

### Convivencia, no sustitución

El modelo editorial vive en colecciones nuevas con prefijo `editorial_`
(`editorial_localities`, `editorial_destinations`, `editorial_boarding_points`,
`editorial_services`, `editorial_amenities`, `editorial_review_queue`) y con su
propio contador en `meta/_id:'editorial'`.

Consecuencia buscada: **una escritura editorial no altera `contentVersion` ni el
ETag del export flat**. El front sigue consumiendo el mismo artefacto hasta el
cutover.

### Estados

Los documentos nuevos usan los cinco estados del doc 02
(`draft → review → approved → published → archived`). Las colecciones flat
conservan sus tres (`draft | published | archived`): cambiarlas tocaría el
golden sin necesidad.

### Envelope de bloque

```jsonc
{
  "id": "…",            // estable de por vida
  "type": "destination-hero",
  "order": 10,
  "status": "review",
  "enabled": true,
  "responsive": { "desktop": true, "tablet": true, "mobile": true },
  "config":  { /* neutro al idioma: medios y referencias */ },
  "content": { "es-PE": { /* texto */ } }
}
```

`config` y `content` están separados a propósito: si la referencia a una imagen
viviera dentro de cada traducción, dos idiomas podrían apuntar a medios
distintos sin que nada lo detecte. Cuando un bloque tiene lista, `config.items`
y `content[locale].items` se emparejan **por índice** y la validación exige la
misma longitud.

`id` de bloque: UUID al crearlo a mano; determinista (`{destino}:{tipo}:{n}`)
cuando lo genera la migración, para que reejecutarla no cambie identidades.

### Catálogo de tipos v1

`destination-hero`, `destination-overview`, `destination-location`,
`destination-rich-text`, `destination-gallery`, `destination-attractions`,
`destination-practical-info`, `destination-tips`, `city-services`,
`transport-services`, `boarding-points`, `destination-faq`,
`related-destinations`, `alert`, `cta`.

`video`, `banner` y `accordion` quedan fuera de v1 (doc 05).

Reglas de composición:

- `full` admite todos; `short` no admite `rich-text`, `attractions`,
  `practical-info`, `tips` ni `faq` (doc 03).
- Bloques obligatorios en ambos: `destination-hero` y `destination-overview`.
- `transport-services` obliga a un `alert` habilitado (decisión D-G): sin él, el
  contenido editorial se lee como disponibilidad garantizada.

### Publicación

Se valida el **documento completo**, no el bloque editado. Un bloque
desconocido o inválido impide publicar el documento aunque esté deshabilitado.

Distinción deliberada entre error y aviso:

| Situación                                   | Resultado                          |
| ------------------------------------------- | ---------------------------------- |
| Referencia inexistente                      | error: no publica                  |
| Referencia existente pero no publicada      | aviso: se excluye del snapshot     |
| Medio sin `alt`                             | error: no publica                  |
| Medio con `rights: "unverified"`            | aviso: se excluye del snapshot     |
| Punto de embarque sin localidad o dirección | error: el punto no publica         |

Sin esa distinción, un punto de embarque con dirección sin verificar tumbaría la
página entera del destino, que es justo lo que la decisión P-04 evita.

### Invariante destino/punto

`BoardingPoint.isDestination` es `Type.Literal(false)` en TypeBox **y**
`enum: [false]` en el validador `$jsonSchema` de MongoDB. No es un booleano
editable: ni un script ni una escritura manual pueden convertir un punto de
embarque en destino.

### Migración

`editorial:migrate` toma el catálogo **anotado** de la Fase 1 y el contenido
flat, y:

- no borra ni modifica el origen (`content_items` queda intacto);
- no publica nada (todo entra en `review`/`draft`);
- manda a `editorial_review_queue` lo no clasificable, con motivo;
- para un destino sin guía genera solo hero + overview + location, con una
  frase geográfica derivada del catálogo, y lo deja `indexable: false`.

Esa última regla es el punto delicado: se genera *estructura* y un enunciado
factual, nunca copy de marketing. Un destino sin redacción propia no debe
competir en buscadores, y por eso nace no indexable.

## Consecuencias

- Dos modelos conviven hasta el cutover; el flat sigue siendo la verdad del
  front y el golden sigue siendo el gate.
- Publicar los 32 destinos exige redacción editorial: la migración deja
  documentos válidos, no documentos completos.
- Los medios heredados entran con derechos sin verificar y no se publican hasta
  que alguien los registre. Las galerías migradas se verán vacías hasta
  entonces: es el comportamiento correcto según el doc 04.
