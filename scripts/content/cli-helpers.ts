import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { loadConfig } from '../../src/shared/config/env.js';
import { sections } from '../../src/modules/content/content-write.service.js';
import type { SectionName } from '../../src/modules/content/content-write.service.js';

/** Conexión de los CLIs editoriales (usa la config/.env local). */
export async function withContentDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const client = new MongoClient(config.MONGO_URI);
  try {
    return await fn(client.db(config.MONGO_DB_CONTENT));
  } finally {
    await client.close();
  }
}

export function parseSection(value: string | undefined): SectionName {
  if (value !== undefined && value in sections) return value as SectionName;
  console.error(
    `ERROR: --section debe ser uno de: ${Object.keys(sections).join(', ')} (recibido: ${value ?? '(vacío)'})`,
  );
  process.exit(2);
}
