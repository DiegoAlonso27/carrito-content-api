import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import type { AppConfig } from '../config/env.js';

export interface MongoContext {
  client: MongoClient;
  /** Contenido editorial (carrito_content). */
  contentDb: Db;
  /** Datos personales de formularios (carrito_forms) — separación dura del contenido. */
  formsDb: Db;
}

/**
 * Crea el cliente sin conectar: el driver conecta al ejecutar la primera
 * operación, de modo que la API puede arrancar aunque MongoDB esté caído
 * (liveness OK, readiness 503) y recuperarse sola cuando vuelva.
 */
export function createMongoContext(config: AppConfig): MongoContext {
  const client = new MongoClient(config.MONGO_URI, {
    // Fallar rápido en health checks y requests en vez de colgar la respuesta.
    serverSelectionTimeoutMS: 2_000,
  });
  return {
    client,
    contentDb: client.db(config.MONGO_DB_CONTENT),
    formsDb: client.db(config.MONGO_DB_FORMS),
  };
}

/** Ping a ambas bases; lanza si alguna no responde (usado por readiness). */
export async function pingMongo(ctx: MongoContext): Promise<void> {
  await ctx.contentDb.command({ ping: 1 });
  await ctx.formsDb.command({ ping: 1 });
}

export async function closeMongo(ctx: MongoContext): Promise<void> {
  await ctx.client.close();
}
