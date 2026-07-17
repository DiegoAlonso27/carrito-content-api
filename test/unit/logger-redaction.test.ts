import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from '../../src/shared/logging/logger.js';
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

  it('la lista de redacción cubre headers sensibles', () => {
    const options = buildLoggerOptions(makeTestConfig());
    if (typeof options === 'boolean') throw new Error('logger options no es objeto');

    const redact = options.redact;
    const paths = Array.isArray(redact) ? redact : (redact?.paths ?? []);
    expect(paths).toContain('req.headers.authorization');
    expect(paths).toContain('req.headers.cookie');
  });
});
