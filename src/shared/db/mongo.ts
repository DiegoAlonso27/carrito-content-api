import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import type { AppConfig } from '../config/env.js';

export interface MongoContext {
  /** Contenido editorial (carrito_content). */
  contentClient: MongoClient;
  /** Datos personales de formularios (carrito_forms) — cliente propio. */
  formsClient: MongoClient;
  contentDb: Db;
  formsDb: Db;
}

/**
 * Dos `MongoClient` independientes (uno por base), no uno compartido: es lo
 * que permite que `carrito_forms` use credenciales propias (AGENTS.md:
 * "usuario Mongo propio" para datos personales) sin acoplar su ciclo de vida
 * al de `carrito_content`. Con `MONGO_URI_FORMS` vacío ambos apuntan a
 * `MONGO_URI` (conveniencia de desarrollo con un único mongod) — en
 * producción deben ser cuentas distintas.
 *
 * Falla rápido si ambas bases comparten nombre: sería anular por completo la
 * separación de datos personales, no una superposición parcial aceptable.
 *
 * Los clientes no conectan aquí: el driver conecta en la primera operación,
 * de modo que la API puede arrancar aunque MongoDB esté caído (liveness OK,
 * readiness 503) y recuperarse sola cuando vuelva.
 */
export function createMongoContext(config: AppConfig): MongoContext {
  if (config.MONGO_DB_CONTENT === config.MONGO_DB_FORMS) {
    throw new Error(
      'MONGO_DB_CONTENT y MONGO_DB_FORMS no pueden ser la misma base de datos ' +
        '(AGENTS.md: separación dura entre contenido y datos personales).',
    );
  }

  // Fallar rápido en health checks y requests en vez de colgar la respuesta.
  const clientOptions = { serverSelectionTimeoutMS: 2_000 };
  const contentClient = new MongoClient(config.MONGO_URI, clientOptions);
  // Vacío solo permitido fuera de producción (validado en loadConfig).
  const formsUri = config.MONGO_URI_FORMS.length > 0 ? config.MONGO_URI_FORMS : config.MONGO_URI;
  const formsClient = new MongoClient(formsUri, clientOptions);

  return {
    contentClient,
    formsClient,
    contentDb: contentClient.db(config.MONGO_DB_CONTENT),
    formsDb: formsClient.db(config.MONGO_DB_FORMS),
  };
}

/** Ping a ambas bases; lanza si alguna no responde (usado por readiness). */
export async function pingMongo(ctx: MongoContext): Promise<void> {
  await ctx.contentDb.command({ ping: 1 });
  await ctx.formsDb.command({ ping: 1 });
}

export async function closeMongo(ctx: MongoContext): Promise<void> {
  const results = await Promise.allSettled([ctx.contentClient.close(), ctx.formsClient.close()]);
  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount > 0) {
    throw new Error(`No se pudieron cerrar todos los clientes MongoDB (${String(failedCount)}).`);
  }
}
