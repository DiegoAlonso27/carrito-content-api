# Paridad de validaciones front ↔ API (contacto y Libro de Reclamaciones)

Matriz de paridad entre el front (`carrito-front/CarritoComprasFront/ClientApp`)
y esta API, con los gaps detectados en la revisión del 2026-07-25 y la
especificación del contrato de teléfono por país (ADR-010). Este documento es
la **especificación de implementación** de esa revisión; el contrato público
vigente es `docs/api-contract.md`.

Convención: «front» = validación cliente (`app/utils/contactValidation.ts`,
`app/utils/complaintValidation.ts`); «API» = TypeBox en el borde + reglas de
negocio de ruta. Todo con el gate de reclamos cerrado
(`FEATURE_COMPLAINTS_ENABLED=false`); los cambios de reclamos se prueban con
el flag activo solo en tests.

## 1. Contacto — `POST /v1/contact`

Campos alineados 1:1 (sin acción): `submissionId` (UUID v4 + índice único),
`nombreApellidos` 3–200 sin controles, `correo` ≤ 254, `dni`
`[A-Za-z0-9]{8,12}`, `mensaje` 10–2000 multilínea, `aceptaTerminos` literal
`true`, honeypot `website`, trim previo a validar, `bodyLimit` 32 KiB, rate
limit por env, `additionalProperties: false`.

Divergencia no accionable: el front valida el correo con una regex simple y la
API con `format: 'email'` de Ajv (más estricto); el 400 de la API ya se mapea
al campo en el front.

| Campo | Antes | Ahora (este cambio) |
| --- | --- | --- |
| `telefonoPais` | no existía | **nuevo, obligatorio**: `^[A-Z]{2}$` y presente en el catálogo vendorizado |
| `telefono` | charset `[0-9+()\-\s]{6,25}` + 6–15 dígitos normalizados | charset sin `+`: `^[0-9()\-\s]{4,25}$`; dígitos según el país (ver §3) |

Persistencia en `contact_messages`: `telefono` (solo dígitos), `telefonoPais`
(ISO2), `telefonoPrefijo` (snapshot, p. ej. `"+51"`). Registros históricos con
la forma antigua no se migran.

## 2. Libro de Reclamaciones — `POST /v1/complaints`

Campos alineados 1:1 (sin acción): `documentType`, `documentNumber`,
`firstName`/`lastNamePaternal` 2–100, `lastNameMaternal` nullable 1–100,
`address` 5–300, `email` (misma regex en ambos lados), `birthDate` opcional y
pasada, apoderado todo-o-null + obligatorio si menor de 18 (ambos lados),
`service.type`, `description` 3–500, `reason`/`province`/`terminal` 1–100,
`incidentDate` opcional y no futura, `detail`/`consumerRequest` 10–4000,
`confirmation` literal `true`. Server-only presentes: honeypot dual (payload y
parte multipart), rate limit, PNG de firma (magia + decodificación + trazo),
sniff mágico de adjuntos, nombre de archivo seguro, idempotencia por
`submissionId`, sin IP/UA.

Gaps corregidos por este cambio (antes explotables por curl saltándose el
front):

| # | Gap | Regla nueva en la API | Clave de error |
| --- | --- | --- | --- |
| G1 | `claimedAmount` aceptaba > 2 decimales; la hoja canónica firma `toFixed(2)` ⇒ hash ≠ dato persistido | si no es null: `abs(v*100 - round(v*100)) > 1e-9` ⇒ 400 «máximo 2 decimales» (regla de negocio; no `multipleOf` por errores de coma flotante) | `service.claimedAmount` |
| G2 | reclamo sin comprobante era aceptado (solo se prohibía en queja) | con `detail.type === 'reclamo'`: `voucherType`, `voucherSeries` y `voucherNumber` no-null | `detail.voucherType` / `detail.voucherSeries` / `detail.voucherNumber` |
| G3 | formato SUNAT solo en UI | en reclamo: serie `/^[FBCE][A-Z0-9]{3}$/i` (se normaliza a MAYÚSCULAS en la ruta tras validar, antes de canónico/persistencia — espejo de `normalizeSunatSeries` del front); correlativo `/^\d{1,8}$/` | `detail.voucherSeries` / `detail.voucherNumber` |
| G4 | `gender` permitía null; front y contrato heredado §4 lo exigen | `Type.Union([Literal('M'), Literal('F')])` sin null; `ConsumerInput.gender: 'M' \| 'F'` | `consumer.gender` |
| R1 | teléfono 6–15 sin país | `consumer.phoneCountry` nuevo obligatorio (ISO2 ∈ catálogo) + `consumer.phone` según país (§3) | `consumer.phoneCountry` / `consumer.phone` |

Persistencia en el documento del reclamo: `consumer.phone` (solo dígitos),
`consumer.phoneCountry` (ISO2), `consumer.phoneDialCode` (snapshot `"+51"`).
`phoneDialCode` **no** aparece en la constancia (el response schema no lo
declara: barrera anti-fuga), pero **sí** entra a la hoja canónica firmada.

Hoja canónica (`complaints.signature.ts`): dentro de `consumer`, las claves
nuevas van inmediatamente después de `phone` y en este orden exacto:
`..., phone, phoneCountry, phoneDialCode, email, birthDate, gender`.
`DOCUMENT_VERSION` permanece `'1'` (nunca existió una hoja firmada: el gate
estuvo cerrado desde siempre).

## 3. Regla de teléfono por país (compartida por ambos formularios)

Helper única de la API: `src/shared/validation/country-phone.ts`, sobre el
catálogo `src/shared/validation/phone-prefixes.ts` (ADR-010).

Entrada: `iso2` (ya validado por forma `^[A-Z]{2}$`) + número crudo (charset
`^[0-9()\-\s]{4,25}$`, ya recortado). Pasos:

1. `iso2` debe existir en el catálogo ⇒ si no, 400 en la clave del país.
2. Normalizar el número a solo dígitos.
3. Longitud según país:
   - `PE` (estructural): `^9\d{8}$` (celular) o `^(1\d{7}|[4-8]\d{7})$` (fijo).
   - Overlay curado (min–max dígitos): `VE` 10, `AR` 10, `CL` 9, `CO` 10,
     `EC` 9, `MX` 10, `BO` 8, `BR` 10–11, `US` 10, `CN` 11.
   - Resto: 4–14 dígitos y `len(dialDigits) + len(número) ≤ 15` (E.164).
4. Salida: `{ iso2, dialCode: '+' + dialDigits, nationalNumber }`; se persiste
   eso, nunca el crudo.

El front implementa la misma regla en `app/utils/phonePrefixes.ts` (helpers)
sobre `app/data/phonePrefixes.ts` (catálogo espejo). Selector: por país
(no por código: `+1` es compartido), default Perú y Perú primero en la lista,
resto en orden alfabético `nameES`.

## 4. Proceso de venta (fuera de esta API)

El checkout muestra el selector pero **mantiene su contrato**: `Telefono` =
dígitos nacionales, catálogo limitado a los 11 países curados de
`phoneCountries.ts` (incluye `PE` 9/9, estricto celular — no se relaja: flujo
transaccional conservador) y `phoneCountry` solo en el estado del front.
Propuesta futura para el dueño del sistema de ventas: campo `TelefonoPais`
versionado en el payload de venta. Ver ADR-010 §5.

## 5. Decisiones declaradas y pendientes legales (sin acción de código)

- `birthDate` e `incidentDate` siguen opcionales (front y API coinciden; el
  §4 heredado es ambiguo). Hacerlas obligatorias es decisión del gate legal
  P1–P18.
- `voucherType` sigue texto libre 1–20 (los catálogos de comprobante, motivo,
  provincia y terminal están pendientes — §10/P10 del plan heredado).
- Queja con `claimedAmount` numérico sigue permitida (§4: opcional en queja);
  el front lo fuerza a null en queja, la API no lo prohíbe.
- Comprobante obligatorio en reclamo y `gender ∈ {M, F}` son espejo del
  front + §4; se reconfirman con legal antes de activar el gate (el default
  del flag sigue `false`).
