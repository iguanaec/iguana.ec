// Procesa un mensaje entrante: cliente, conversación, coexistencia, medios y aviso al Durable Object.
import type { Env } from '../env';
import { getBusiness, type Business } from '../db';
import { understandMedia } from '../agent/gemini';
import { trackUsage } from '../agent/economy';
import { toB64 } from '../lib/crypto';
import { downloadMedia } from './meta';
import type { ChannelRow, InboundEvent } from './types';

export async function findChannel(env: Env, kind: string, externalId: string) {
  return env.DB.prepare("SELECT * FROM channels WHERE kind = ? AND external_id = ? AND status = 'active'").bind(kind, externalId).first<ChannelRow>();
}

export interface ConversationRow {
  id: number; business_id: number; channel_id: number | null; customer_id: number | null; kind: string; contact_ref: string; contact_name: string;
  is_owner: number; stage: string; bot_paused_until: number; pause_reason: string; summary: string; summary_upto_id: number; last_inbound_ts: number;
}

/** Busca o crea cliente + conversación para un contacto de un canal. */
export async function ensureConversation(env: Env, business: Business, kind: string, channelId: number | null, contactRef: string, contactName = '') {
  const existing = await env.DB.prepare('SELECT * FROM conversations WHERE business_id = ? AND kind = ? AND contact_ref = ?')
    .bind(business.id, kind, contactRef).first<ConversationRow>();
  const phone = kind === 'whatsapp' ? contactRef.replace(/\D/g, '') : '';
  // El modo dueño se recalcula siempre: si el dueño quita un número, ese chat pierde las herramientas de dueño.
  const isOwnerNow = phone && business.agent.ownerPhones.includes(phone) ? 1 : 0;
  if (existing) {
    if (kind !== 'test' && existing.is_owner !== isOwnerNow) {
      await env.DB.prepare('UPDATE conversations SET is_owner = ? WHERE id = ?').bind(isOwnerNow, existing.id).run();
      existing.is_owner = isOwnerNow;
    }
    if (contactName && !existing.contact_name) await env.DB.prepare('UPDATE conversations SET contact_name = ? WHERE id = ?').bind(contactName, existing.id).run();
    return existing;
  }
  let customer = phone
    ? await env.DB.prepare('SELECT id FROM customers WHERE business_id = ? AND phone = ? LIMIT 1').bind(business.id, phone).first<{ id: number }>()
    : null;
  if (!customer) {
    const [first, ...rest] = contactName.trim().split(/\s+/);
    customer = await env.DB.prepare(
      'INSERT INTO customers (business_id, first_name, last_name, phone, contact_channel, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    ).bind(business.id, first || '', rest.join(' '), phone, kind, Date.now()).first<{ id: number }>();
  }
  return (await env.DB.prepare(
    `INSERT INTO conversations (business_id, channel_id, customer_id, kind, contact_ref, contact_name, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_id, kind, contact_ref) DO UPDATE SET contact_name = contact_name RETURNING *`,
  ).bind(business.id, channelId, customer!.id, kind, contactRef, contactName, isOwnerNow, Date.now()).first<ConversationRow>())!;
}

/** Devuelve el id de la conversación si el bot debe responder; null si no. */
export async function processInbound(env: Env, event: InboundEvent): Promise<{ businessId: number; conversationId: number } | null> {
  const channel = await findChannel(env, event.kind, event.channelExternalId);
  if (!channel) return null;
  const business = await getBusiness(env, channel.business_id);
  if (!business || business.status === 'suspended') return null;
  const conv = await ensureConversation(env, business, event.kind, channel.id, event.contactRef, event.contactName);
  const now = Date.now();

  const inserted = await env.DB.prepare(
    `INSERT INTO messages (business_id, conversation_id, direction, author, text, media_type, external_id, answered, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
  ).bind(business.id, conv.id, event.echo ? 'out' : 'in', event.echo ? 'owner' : 'customer', event.text ?? '', event.media?.type ?? null,
    event.externalId, event.echo ? 1 : 0, event.ts || now).first<{ id: number }>();
  if (!inserted) return null; // duplicado (Meta reintenta webhooks)

  if (event.echo) {
    // Coexistencia inteligente: el dueño tomó la conversación desde su celular → el bot se calla un rato.
    const until = now + business.settings.coexistencePauseMinutes * 60000;
    await env.DB.batch([
      env.DB.prepare("UPDATE conversations SET bot_paused_until = ?, pause_reason = 'owner_reply', last_message_ts = ?, unread = 0 WHERE id = ?").bind(until, now, conv.id),
      env.DB.prepare("UPDATE messages SET answered = 1 WHERE conversation_id = ? AND direction = 'in' AND answered = 0").bind(conv.id),
    ]);
    return null;
  }

  if (event.media && (event.media.type === 'audio' || event.media.type === 'image') && env.GEMINI_API_KEY) {
    try {
      const file = await downloadMedia(env, channel, event.media);
      const insight = await understandMedia(env, event.media.type, file.mime, toB64(file.bytes));
      await trackUsage(env, business, { ...insight.usage, calls: 1 });
      const text = insight.kind === 'transcript'
        ? `[Nota de voz] ${insight.text}${event.text ? `\n${event.text}` : ''}`
        : `${insight.text}${event.text ? `\n${event.text}` : ''}`;
      await env.DB.prepare('UPDATE messages SET text = ? WHERE id = ?').bind(text, inserted.id).run();
      if (insight.kind === 'receipt') await createPaymentProof(env, business, conv, inserted.id, insight);
    } catch (err) {
      console.error('media', (err as Error).message);
      if (!event.text) await env.DB.prepare('UPDATE messages SET text = ? WHERE id = ?').bind(`[${event.media.type === 'audio' ? 'Nota de voz' : 'Foto'} que no se pudo procesar]`, inserted.id).run();
    }
  } else if (event.media && !event.text) {
    await env.DB.prepare('UPDATE messages SET text = ? WHERE id = ?').bind(`[${event.media.type} adjunto]`, inserted.id).run();
  }

  await env.DB.prepare('UPDATE conversations SET last_message_ts = ?, last_inbound_ts = ?, unread = unread + 1 WHERE id = ?').bind(now, now, conv.id).run();
  return { businessId: business.id, conversationId: conv.id };
}

/** Comprobante detectado → queda pendiente para que el dueño lo apruebe con un toque. */
async function createPaymentProof(env: Env, business: Business, conv: ConversationRow, messageId: number,
  r: { amount: number | null; bank: string; reference: string }) {
  let appointmentId: number | null = null;
  let orderId: number | null = null;
  if (conv.customer_id) {
    const order = await env.DB.prepare("SELECT id FROM orders WHERE business_id = ? AND customer_id = ? AND status NOT IN ('cancelado') AND paid_cents < total_cents ORDER BY id DESC LIMIT 1")
      .bind(business.id, conv.customer_id).first<{ id: number }>();
    if (order) orderId = order.id;
    else {
      const appt = await env.DB.prepare(
        "SELECT id FROM appointments WHERE business_id = ? AND customer_id = ? AND status != 'cancelled' AND paid_cents < COALESCE(price_cents, 0) ORDER BY ABS(start_ts - ?) LIMIT 1",
      ).bind(business.id, conv.customer_id, Date.now()).first<{ id: number }>();
      appointmentId = appt?.id ?? null;
    }
  }
  await env.DB.prepare(
    `INSERT INTO payment_proofs (business_id, conversation_id, message_id, customer_id, appointment_id, order_id, amount_cents, bank, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(business.id, conv.id, messageId, conv.customer_id, appointmentId, orderId, r.amount != null ? Math.round(r.amount * 100) : null, r.bank, r.reference, Date.now()).run();
}
