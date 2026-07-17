import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../../shared/config/env.js';
import type { ComplaintDoc } from './complaints.types.js';

/**
 * Correo de constancia del reclamo (P2, §5.6).
 *
 * Adaptación al límite duro «sin colas» (AGENTS.md): NO hay worker de reintentos
 * ni hosted-service que sondee. El envío es best-effort inline tras persistir el
 * reclamo; el resultado se registra en el sub-documento `emailDispatch`. Si el
 * SMTP no está configurado (`COMPLAINTS_SMTP_HOST` vacío) el transporte es no-op
 * y el dispatch queda `pendiente` para reproceso operativo. El reclamo se
 * persiste SIEMPRE, envíe o no (el registro nunca depende del correo).
 *
 * El correo lleva la hoja + código + fecha + plazo; NUNCA el PNG de la firma ni
 * los binarios de adjuntos (solo sus metadatos), ni datos personales a logs.
 */

/** Versión/identificador de la plantilla; se persiste como evidencia. */
export const TEMPLATE_VERSION = 'constancia-v1';

export interface SendResult {
  delivered: boolean;
  templateVersion: string;
}

export interface ComplaintNotificationSender {
  send(complaint: ComplaintDoc): Promise<SendResult>;
}

/** Transporte no-op: no envía. El dispatch permanece `pendiente`. */
class NoopSender implements ComplaintNotificationSender {
  send(_complaint: ComplaintDoc): Promise<SendResult> {
    void _complaint;
    return Promise.resolve({ delivered: false, templateVersion: TEMPLATE_VERSION });
  }
}

class SmtpSender implements ComplaintNotificationSender {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  async send(complaint: ComplaintDoc): Promise<SendResult> {
    await this.transporter.sendMail({
      from: this.from,
      to: complaint.consumer.email,
      subject: `Constancia de reclamo ${complaint.complaintCode}`,
      text: buildReceiptText(complaint),
    });
    return { delivered: true, templateVersion: TEMPLATE_VERSION };
  }
}

/**
 * Construye el sender según configuración. Vacío ⇒ no-op (sin dependencia de
 * red). Las credenciales SMTP solo llegan por env (nunca en código/logs).
 */
export function createNotificationSender(config: AppConfig): ComplaintNotificationSender {
  if (config.COMPLAINTS_SMTP_HOST.length === 0 || config.COMPLAINTS_SMTP_FROM.length === 0) {
    return new NoopSender();
  }
  const transporter = nodemailer.createTransport({
    host: config.COMPLAINTS_SMTP_HOST,
    port: config.COMPLAINTS_SMTP_PORT,
    secure: config.COMPLAINTS_SMTP_SECURE,
    auth:
      config.COMPLAINTS_SMTP_USER.length > 0
        ? { user: config.COMPLAINTS_SMTP_USER, pass: config.COMPLAINTS_SMTP_PASSWORD }
        : undefined,
  });
  return new SmtpSender(transporter, config.COMPLAINTS_SMTP_FROM);
}

/**
 * Cuerpo de texto de la constancia. Incluye la hoja y los metadatos de firma y
 * adjuntos; jamás el PNG del trazo ni el binario de un adjunto.
 */
function buildReceiptText(c: ComplaintDoc): string {
  const lines = [
    `Constancia de presentación — Libro de Reclamaciones`,
    `Código: ${c.complaintCode}`,
    `Fecha de presentación (UTC): ${c.createdAtUtc.toISOString()}`,
    `Plazo de respuesta (UTC): ${c.responseDueAtUtc.toISOString()}`,
    `Estado: ${c.status}`,
    ``,
    `Proveedor: ${c.provider.legalName} (RUC ${c.provider.ruc})`,
    `Consumidor: ${c.consumer.firstName} ${c.consumer.lastNamePaternal}`,
    `Tipo: ${c.detail.type}`,
    `Motivo: ${c.detail.reason}`,
    ``,
    `Firma del consumidor: registrada (${c.signature.method}), hash ${c.signature.signedDocumentHash}`,
    `Adjuntos: ${String(c.attachments.length)}`,
  ];
  return lines.join('\n');
}
