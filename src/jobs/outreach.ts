// Mensajes que inicia el negocio (recordatorios, lista de espera, reactivación).
// Meta solo permite texto libre dentro de las 24 h desde el último mensaje del cliente; fuera de eso, plantilla aprobada.
import type { Env } from '../env';
import type { Business } from '../db';
import { sendTemplate, sendText } from '../channels/meta';
import type { ChannelRow } from '../channels/types';

const DAY = 24 * 3600_000;

export async function sendOutreach(env: Env, business: Business, customerId: number, text: string, template?: { name: string; params: string[] }) {
  const conv = await env.DB.prepare(
    `SELECT cv.id, cv.contact_ref, cv.last_inbound_ts, cv.channel_id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
      WHERE cv.business_id = ? AND cv.customer_id = ? AND ch.status = 'active' ORDER BY cv.last_inbound_ts DESC LIMIT 1`,
  ).bind(business.id, customerId).first<{ id: number; contact_ref: string; last_inbound_ts: number; channel_id: number }>();
  if (!conv) return { sent: false, reason: 'sin_canal' as const };
  const channel = (await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(conv.channel_id).first<ChannelRow>())!;
  let externalId = '';
  if (Date.now() - conv.last_inbound_ts < DAY) {
    externalId = (await sendText(env, channel, conv.contact_ref, text))[0] ?? '';
  } else if (template?.name && channel.kind === 'whatsapp') {
    externalId = await sendTemplate(env, channel, conv.contact_ref, template.name, template.params);
  } else {
    return { sent: false, reason: 'fuera_de_ventana' as const };
  }
  await env.DB.prepare(
    "INSERT INTO messages (business_id, conversation_id, direction, author, text, external_id, answered, created_at) VALUES (?, ?, 'out', 'bot', ?, ?, 1, ?)",
  ).bind(business.id, conv.id, text, externalId || null, Date.now()).run();
  return { sent: true as const };
}
