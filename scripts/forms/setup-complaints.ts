/**
 * Aprovisiona la colección `complaints` en `carrito_forms`: validador
 * $jsonSchema, índices únicos de idempotencia (`submissionId`) y de código
 * (`complaintCode`), e índice por fecha. Idempotente.
 *
 * Uso:
 *   npx tsx scripts/forms/setup-complaints.ts
 *
 * Pensado para una cuenta de migración (permisos DDL), DISTINTA de la cuenta
 * de ejecución del servidor, que solo necesita INSERT/SELECT/UPDATE acotado
 * sobre `complaints` (mismo patrón de dos cuentas que contacto; el servidor
 * jamás ejecuta esta migración — ver complaints.repo.ts).
 *
 * NOTA: aprovisionar la colección NO habilita el Libro de Reclamaciones. El
 * endpoint sigue detrás de FEATURE_COMPLAINTS_ENABLED=false hasta cerrar el
 * gate legal P1–P18 (AGENTS.md; ADR-007).
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../../src/shared/config/env.js';
import { ensureComplaintsSetup } from '../../src/modules/complaints/complaints.repo.js';

const config = loadConfig();
const uri = config.MONGO_URI_FORMS.length > 0 ? config.MONGO_URI_FORMS : config.MONGO_URI;
const client = new MongoClient(uri);

try {
  const db = client.db(config.MONGO_DB_FORMS);
  await ensureComplaintsSetup(db);
  console.log(`OK: ${config.MONGO_DB_FORMS}.complaints listo (validador e índices aplicados).`);
} finally {
  await client.close();
}
