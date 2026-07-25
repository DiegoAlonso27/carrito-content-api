# ADR-010: Teléfono con país en campo aparte (contacto y Libro)

**Estado:** aceptado — en implementación
**Fecha:** 2026-07-25
**Fases:** endurecimiento post-F5/F6 (paridad de validaciones front/API)

## Contexto

El contrato heredado (`formularios-backend-csharp.md` §4) validaba el teléfono
como «6–15 dígitos con separadores visuales», sin noción de país. El producto
decidió que todos los campos de teléfono del sitio (contáctanos, Libro de
Reclamaciones y datos de cliente del proceso de venta) ofrezcan un **selector
de prefijo internacional** y validen el número **según el país elegido**.

El checkout del front ya tenía la mecánica a medias: un catálogo curado de 11
países con `minDigits`/`maxDigits` (`ClientApp/app/utils/phoneCountries.ts`) y
validación por país en `validateCheckoutPassenger`, pero sin selector en UI
(el código «+51» estaba fijo).

## Decisión

1. **Campo de país separado, no E.164 combinado.** El cliente envía el país
   como **ISO2** y el número como **solo dígitos nacionales**:
   - Contacto: `telefonoPais` (`"PE"`) + `telefono` (`"987654321"`).
   - Reclamos: `consumer.phoneCountry` + `consumer.phone`.

   Se descartó el formato combinado `+51987654321` porque obliga a un parseo
   por longest-match en el servidor y porque el prefijo solo no identifica al
   país (`+1` es compartido por EEUU, Canadá y el Caribe NANP), mientras que
   la regla de longitud es del país.

2. **Catálogo vendorizado, sin paquete compartido.** La lista de países y
   prefijos proviene de un snapshot fijo del gist
   <https://gist.github.com/eduardolat/b2a252d17b17363fab0974bb0634d259>
   (2026-07-25, 248 entradas), normalizado a 245 entradas marcables
   (`dialDigits` solo dígitos; se excluyen territorios sin código). Vive
   duplicado a propósito en ambos repos (decisión previa: sin paquete
   compartido front/API):
   - API: `src/shared/validation/phone-prefixes.ts`
   - Front: `ClientApp/app/data/phonePrefixes.ts`

   El gist no declara licencia; son datos factuales ITU-T (nombres + códigos).
   No se descarga en build: ante cambios se regeneran ambas copias desde el
   mismo snapshot.

3. **Validación por país en dos capas.** El gist no trae longitudes; la regla
   de longitud sale de un **overlay curado** (heredado del checkout) con
   **fallback E.164 genérico** para el resto:
   - Perú (`PE`), regla estructural: celular = 9 dígitos empezando en 9;
     fijo = 8 dígitos empezando en 1 (Lima) o 4–8 (provincias). No se
     enumera el catálogo exacto de códigos de área OSIPTEL (frágil ante
     reasignaciones).
   - Overlay: `VE` 10, `AR` 10, `CL` 9, `CO` 10, `EC` 9, `MX` 10, `BO` 8,
     `BR` 10–11, `US` 10, `CN` 11.
   - Fallback: 4–14 dígitos nacionales y `len(dialDigits) + len(número) ≤ 15`
     (límite E.164).

4. **Persistencia con snapshot del prefijo.** Se guarda ISO2 + dígitos
   nacionales + el prefijo resuelto al momento del alta
   (`telefonoPrefijo` / `consumer.phoneDialCode`, p. ej. `"+51"`). Si el
   catálogo cambiara, el registro histórico no se reinterpreta. En reclamos,
   `phoneCountry` y `phoneDialCode` entran a la hoja canónica firmada;
   `DOCUMENT_VERSION` permanece en `'1'` porque nunca existió una hoja
   firmada bajo la forma anterior (el gate estuvo cerrado desde siempre).

5. **El sistema de ventas no cambia.** El checkout muestra el selector pero
   sigue enviando `Telefono` = dígitos nacionales (el BFF C# es passthrough y
   el comportamiento aguas abajo con otros formatos es desconocido). Su
   selector se limita a los 11 países curados hasta que el dueño del sistema
   de ventas confirme soporte para un campo `TelefonoPais` versionado. Un SMS
   a un número extranjero seguirá sin funcionar: ya es así hoy.

6. **Desviación registrada del contrato heredado.** La regla «6–15 dígitos»
   de `formularios-backend-csharp.md` §4 queda reemplazada por este contrato.
   `docs/api-contract.md` es el contrato vigente.

## Consecuencias

- Cambio de forma del body de contacto (campo nuevo obligatorio
  `telefonoPais`): un front desplegado antes que la API recibe 400 por campo
  desconocido (`additionalProperties: false`). Orden de despliegue: API
  primero o juntos. Para reclamos no hay riesgo operativo: el gate sigue
  cerrado (`FEATURE_COMPLAINTS_ENABLED=false`).
- Los registros históricos de `contact_messages` (dígitos sin país) no se
  migran; la lectura futura debe tolerar ambas formas.
- Números extranjeros pasan a ser válidos en contacto y Libro (resuelve la
  tensión con `documentType = Pasaporte` señalada en la revisión de paridad).
