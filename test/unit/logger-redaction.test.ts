import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from '../../src/shared/logging/logger.js';
import { safeErrorLog } from '../../src/shared/logging/logger.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * El serializador `req` por defecto de Fastify incluye `remoteAddress`/
 * `remotePort`: la IP es dato personal y no debe aparecer en logs (AGENTS.md).
 * Se verifica que el serializador propio del proyecto solo emite id/método/ruta.
 */
describe('buildLoggerOptions — serializador de request sin IP', () => {
  it('el serializador req no expone remoteAddress ni remotePort', () => {
    const options = buildLoggerOptions(makeTestConfig());
    if (typeof options === 'boolean') throw new Error('logger options no es objeto');

    const reqSerializer = options.serializers?.['req'] as
      ((r: unknown) => Record<string, unknown>) | undefined;
    expect(typeof reqSerializer).toBe('function');

    const serialized = reqSerializer?.({
      id: 'req-1',
      method: 'POST',
      url: '/v1/complaints',
      ip: '198.51.100.7',
      socket: { remoteAddress: '198.51.100.7', remotePort: 54321 },
    });

    const asJson = JSON.stringify(serialized);
    expect(asJson).not.toContain('198.51.100.7');
    expect(asJson).not.toContain('54321');
    expect(asJson).not.toContain('remoteAddress');
    expect(serialized).toEqual({ id: 'req-1', method: 'POST', url: '/v1/complaints' });
  });

  it('descarta la query string (puede llevar datos personales o secretos)', () => {
    const options = buildLoggerOptions(makeTestConfig());
    if (typeof options === 'boolean') throw new Error('logger options no es objeto');

    const reqSerializer = options.serializers?.['req'] as
      ((r: unknown) => Record<string, unknown>) | undefined;

    const serialized = reqSerializer?.({
      id: 'req-2',
      method: 'GET',
      url: '/v1/complaints?email=ana.perez@example.test&token=secreto',
    });

    expect(serialized?.['url']).toBe('/v1/complaints');
    const asJson = JSON.stringify(serialized);
    expect(asJson).not.toContain('ana.perez@example.test');
    expect(asJson).not.toContain('secreto');
    expect(asJson).not.toContain('?');
  });

  it('conserva la ruta cuando no hay query string', () => {
    const options = buildLoggerOptions(makeTestConfig());
    if (typeof options === 'boolean') throw new Error('logger options no es objeto');

    const reqSerializer = options.serializers?.['req'] as
      ((r: unknown) => Record<string, unknown>) | undefined;

    const serialized = reqSerializer?.({ id: 'req-3', method: 'GET', url: '/health/ready' });
    expect(serialized?.['url']).toBe('/health/ready');
  });

  it('la salida real no contiene headers, IP, query ni datos de un error', async () => {
    const options = buildLoggerOptions(makeTestConfig({ LOG_LEVEL: 'info' }));
    if (typeof options === 'boolean') throw new Error('logger options no es objeto');

    const lines: string[] = [];
    const app = Fastify({
      logger: {
        ...options,
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    try {
      app.log.info(
        {
          req: {
            id: 'req-real-1',
            method: 'GET',
            url: '/v1/export/content-cache?token=query-secreto',
            headers: {
              authorization: 'Bearer auth-secreto',
              cookie: 'session=cookie-secreta',
              'x-export-key': 'export-key-secreta',
            },
            ip: '198.51.100.9',
            socket: { remoteAddress: '198.51.100.9', remotePort: 54321 },
          },
          error: safeErrorLog(new Error('Nombre Personal En Error'), {
            includeStackFrames: true,
          }),
        },
        'prueba de privacidad',
      );
    } finally {
      await app.close();
    }

    const output = lines.join('');
    expect(output).toContain('prueba de privacidad');
    expect(output).toContain('/v1/export/content-cache');
    expect(output).toContain('logger-redaction.test');
    for (const forbidden of [
      'query-secreto',
      'auth-secreto',
      'cookie-secreta',
      'export-key-secreta',
      '198.51.100.9',
      '54321',
      'Nombre Personal En Error',
      'session=',
      'authorization',
      'x-export-key',
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });
});
