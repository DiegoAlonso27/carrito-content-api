import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors/app-error.js';
import { isClientIpAllowed } from '../../shared/security/ip-allowlist.js';

/**
 * Regla de admisión del editor. Con allowlist explícita manda `req.ip` (única
 * forma de admitir a un operador que llega por el proxy); con la allowlist
 * vacía —el default— NO basta `req.ip`.
 *
 * Motivo: `buildApp` fija `trustProxy: '127.0.0.1'`, así que en el despliegue
 * documentado (IIS/ARR en la misma máquina) el valor de `req.ip` proviene de
 * `X-Forwarded-For`. Un proxy que no anexe esa cabecera, o que reenvíe la del
 * cliente sin anexar, haría que CUALQUIER cliente externo apareciera como
 * `127.0.0.1` y pudiera publicar contenido. En `/docs` ese fallo solo dejaba
 * leer documentación; aquí deja escribir en `carrito_content`.
 *
 * En modo loopback se exige entonces el socket real en loopback y ninguna
 * cabecera de reenvío: exactamente el flujo previsto (el operador en la propia
 * máquina, sin pasar por el proxy). Con allowlist explícita un proxy mudo falla
 * CERRADO por sí solo — `req.ip` sería `127.0.0.1`, que no está en la lista.
 */
function isEditorClientAllowed(req: FastifyRequest, allowed: readonly string[]): boolean {
  if (allowed.length > 0) return isClientIpAllowed(req.ip, allowed);
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  return isClientIpAllowed(req.socket.remoteAddress ?? '', []);
}

/**
 * Instala la allowlist de IP del editor interno en el scope donde se llama.
 *
 * División de responsabilidades, deliberada:
 * - El interruptor (`INTERNAL_EDITOR_ENABLED`) NO se comprueba aquí. Con el
 *   flag apagado el bootstrap ni siquiera registra las rutas del editor, así
 *   que caen en el notFound handler estándar (404 con la envolvente del
 *   proyecto). Que este guard lo revalidara sería código muerto y daría la
 *   falsa impresión de que existe una segunda barrera.
 * - Este módulo solo responde «¿esta IP puede hablar con el editor ya
 *   encendido?». La regla de admisión es la compartida con `/docs`
 *   (`isClientIpAllowed`), no una copia local.
 *
 * El hook se añade al `scope` recibido, no a la instancia raíz: por
 * encapsulación de Fastify afecta SOLO a las rutas registradas en ese scope y
 * jamás al resto de la API.
 */
export function registerInternalEditorGuard(scope: FastifyInstance): void {
  // La allowlist se resuelve UNA vez al registrar: es configuración de arranque
  // (fail-fast en `loadConfig`) y no cambia en caliente; leerla por request
  // solo añadiría trabajo en el camino caliente.
  const allowed = scope.config.INTERNAL_EDITOR_ALLOWED_IPS_LIST;

  scope.addHook('onRequest', (req, _reply, done) => {
    if (isEditorClientAllowed(req, allowed)) {
      done();
      return;
    }
    // Sin la IP en el log: AGENTS.md prohíbe persistirla o registrarla. Se
    // registra el patrón de ruta y no `req.url`, porque el serializador del
    // proyecto descarta la query a propósito (puede llevar datos personales o
    // secretos) y este campo no pasa por él.
    req.log.warn(
      { route: req.routeOptions.url ?? '(desconocida)' },
      'acceso al editor interno bloqueado por allowlist',
    );
    // 403 aquí frente al 404 de `/docs`, y no es una inconsistencia: el editor
    // está apagado por defecto y su 404 ya significa «no existe». Una vez
    // encendido a propósito, un 403 explícito le dice al operador que su IP no
    // está en la allowlist, en vez de hacerle perseguir un 404 fantasma. No hay
    // nada que ocultar a esas alturas: encender el editor ya fue una decisión.
    // Se lanza el error para que el handler central arme la envolvente estándar
    // (`FORBIDDEN` es el código que ya usa `publicClientError` para 403). El
    // hook conserva la firma con `done` a propósito: Fastify solo trata como
    // asíncrono lo que devuelve una promesa, así que la rama permitida DEBE
    // llamar a `done()` o la petición quedaría colgada.
    throw new AppError('FORBIDDEN', 'Acceso denegado.', 403);
  });
}
