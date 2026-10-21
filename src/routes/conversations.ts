import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule, requireRole } from '../auth';
import { getBusiness } from '../db';
import { sendText } from '../channels/meta';
import type { ChannelRow } from '../channels/types';
import { ensureConversation, type ConversationRow } from '../channels/inbound';
import { runConversation } from '../agent/run';
import { bad, cents, forbidden, int, money, notFound, str } from '../lib/http';
import { toLocalIso } from '../lib/time';

/* ---------- Bandeja ---------- */

export const conversations = new Hono<AppEnv>();
conversations.use('*', requireAuth, requireBusiness, requireModule('mensajeria'));

conversations.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const { results } = await c.env.DB.prepare(
    `SELECT cv.id, cv.kind, cv.contact_ref, cv.contact_name, cv.is_owner, cv.stage, cv.bot_paused_until, cv.pause_reason, cv.unread, cv.last_message_ts,
            cv.customer_id, cu.first_name, cu.last_name, cu.phone,
            (SELECT text FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_text,
            (SELECT author FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_author,
            (SELECT COUNT(*) FROM payment_proofs p WHERE p.conversation_id = cv.id AND p.status = 'pending') AS pending_proofs
       FROM conversations cv LEFT JOIN customers cu ON cu.id = cv.customer_id
      WHERE cv.business_id = ? AND cv.kind != 'test' ORDER BY cv.last_message_ts DESC LIMIT 300`,
  ).bind(b.id).all<Record<string, unknown> & { bot_paused_until: number; last_message_ts: number }>();
  const now = Date.now();
  return c.json(results.map((r) => ({
    ...r,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.contact_name || r.contact_ref,
    bot_active: r.bot_paused_until <= now,
    bot_paused_until: r.bot_paused_until > now ? toLocalIso(r.bot_paused_until, b.timezone) : null,
    last_message_at: r.last_message_ts ? toLocalIso(r.last_message_ts, b.timezone) : null,
  })));
});

async function loadConversation(c: { env: AppEnv['Bindings']; get: (k: 'businessId') => number }, id: number) {
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND business_id = ?').bind(id, c.get('businessId')).first<ConversationRow>();
  if (!conv) throw notFound('Conversación no encontrada.');
  return conv;
}

conversations.get('/:id/messages', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const conv = await loadConversation(c, int(c.req.param('id'))!);
  const before = int(c.req.query('before')) ?? Number.MAX_SAFE_INTEGER;
  const { results } = await c.env.DB.prepare(
    'SELECT id, direction, author, text, media_type, created_at FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 60',
  ).bind(conv.id, before).all<{ created_at: number }>();
  await c.env.DB.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').bind(conv.id).run();
  return c.json({
    conversation: { id: conv.id, kind: conv.kind, summary: conv.summary, stage: conv.stage, bot_active: conv.bot_paused_until <= Date.now(), pause_reason: conv.pause_reason, customer_id: conv.customer_id },
    // Ventana de 24 h de Meta: fuera de ella solo se puede escribir con plantilla.
    can_reply: conv.kind === 'test' || Date.now() - conv.last_inbound_ts < 24 * 3600_000,
    messages: results.reverse().map((m) => ({ ...m, created_at: toLocalIso(m.created_at, b.timezone) })),
  });
});

/** Respuesta escrita desde el panel: sale por el canal y pausa al bot (una persona tomó la conversación). */
conversations.post('/:id/reply', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const conv = await loadConversation(c, int(c.req.param('id'))!);
  const body = await c.req.json().catch(() => ({}));
  const text = str(body.text, 4000);
  if (!text) throw bad('Escribe un mensaje.');
  if (conv.kind !== 'test' && Date.now() - conv.last_inbound_ts > 24 * 3600_000) {
    throw bad('Pasaron más de 24 horas desde el último mensaje del cliente. Meta solo permite escribirle con una plantilla aprobada.');
  }
  let externalId: string | null = null;
  if (conv.channel_id) {
    const channel = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ? AND business_id = ?').bind(conv.channel_id, b.id).first<ChannelRow>();
    if (!channel || channel.status !== 'active') throw bad('El canal de esta conversación está desconectado.');
    externalId = (await sendText(c.env, channel, conv.contact_ref, text))[0] || null;
  }
  const author = c.get('user').role === 'staff' ? 'staff' : 'owner';
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO messages (business_id, conversation_id, direction, author, text, external_id, answered, created_at) VALUES (?, ?, 'out', ?, ?, ?, 1, ?)")
      .bind(b.id, conv.id, author, text, externalId, Date.now()),
    c.env.DB.prepare("UPDATE conversations SET bot_paused_until = MAX(bot_paused_until, ?), pause_reason = 'manual', last_message_ts = ?, unread = 0 WHERE id = ?")
      .bind(Date.now() + b.settings.coexistencePauseMinutes * 60000, Date.now(), conv.id),
  ]);
  return c.json({ ok: true });
});

/** Encender/apagar el bot en una conversación. */
conversations.post('/:id/bot', async (c) => {
  const conv = await loadConversation(c, int(c.req.param('id'))!);
  const body = await c.req.json().catch(() => ({}));
  const active = body.active !== false;
  await c.env.DB.prepare('UPDATE conversations SET bot_paused_until = ?, pause_reason = ? WHERE id = ?')
    .bind(active ? 0 : Date.now() + 365 * 86400_000, active ? '' : 'manual', conv.id).run();
  return c.json({ ok: true, bot_active: active });
});

conversations.post('/:id/stage', async (c) => {
  const conv = await loadConversation(c, int(c.req.param('id'))!);
  const body = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare('UPDATE conversations SET stage = ? WHERE id = ?').bind(str(body.stage, 40) || 'nuevo', conv.id).run();
  return c.json({ ok: true });
});

/* ---------- Comprobantes leídos por la IA ---------- */

export const proofs = new Hono<AppEnv>();
proofs.use('*', requireAuth, requireBusiness, requireRole('admin'));

proofs.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, cu.first_name, cu.last_name FROM payment_proofs p LEFT JOIN customers cu ON cu.id = p.customer_id
      WHERE p.business_id = ? AND p.status = ? ORDER BY p.id DESC LIMIT 100`,
  ).bind(b.id, c.req.query('status') || 'pending').all<Record<string, unknown> & { amount_cents: number | null; created_at: number }>();
  return c.json(results.map((p) => ({
    ...p, amount: money(p.amount_cents), customer_name: [p.first_name, p.last_name].filter(Boolean).join(' '), created_at: toLocalIso(p.created_at, b.timezone),
  })));
});

proofs.post('/:id/approve', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const proof = await c.env.DB.prepare("SELECT * FROM payment_proofs WHERE id = ? AND business_id = ? AND status = 'pending'").bind(int(c.req.param('id')), b.id)
    .first<{ id: number; amount_cents: number | null; appointment_id: number | null; order_id: number | null }>();
  if (!proof) throw notFound('Comprobante no encontrado.');
  const body = await c.req.json().catch(() => ({}));
  const amount = cents(body.amount) ?? proof.amount_cents;
  if (!amount) throw bad('Indica el monto del comprobante.');
  const appointmentId = int(body.appointment_id) ?? proof.appointment_id;
  const orderId = int(body.order_id) ?? proof.order_id;
  const statements = [
    c.env.DB.prepare("UPDATE payment_proofs SET status = 'approved', amount_cents = ? WHERE id = ?").bind(amount, proof.id),
    c.env.DB.prepare("INSERT INTO payments (business_id, appointment_id, order_id, amount_cents, method, source, created_at) VALUES (?, ?, ?, ?, 'Transferencia', 'comprobante', ?)")
      .bind(b.id, appointmentId, orderId, amount, Date.now()),
  ];
  if (appointmentId) statements.push(c.env.DB.prepare('UPDATE appointments SET paid_cents = paid_cents + ? WHERE id = ? AND business_id = ?').bind(amount, appointmentId, b.id));
  if (orderId) {
    statements.push(c.env.DB.prepare(
      `UPDATE orders SET paid_cents = paid_cents + ?1, status = CASE WHEN paid_cents + ?1 >= total_cents AND status IN ('nuevo','confirmado') THEN 'pagado' ELSE status END
        WHERE id = ?2 AND business_id = ?3`,
    ).bind(amount, orderId, b.id));
  }
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

proofs.post('/:id/reject', async (c) => {
  await c.env.DB.prepare("UPDATE payment_proofs SET status = 'rejected' WHERE id = ? AND business_id = ?").bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Probador del agente (sin canal real) ---------- */

export const agentTest = new Hono<AppEnv>();
agentTest.use('*', requireAuth, requireBusiness, requireModule('asistente'));

agentTest.post('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  const asOwner = body.asOwner === true;
  if (asOwner && c.get('user').role === 'staff') throw forbidden();
  const ref = `test:${c.get('user').id}:${asOwner ? 'owner' : 'customer'}`;
  if (body.reset === true) {
    await c.env.DB.prepare("DELETE FROM conversations WHERE business_id = ? AND kind = 'test' AND contact_ref = ?").bind(b.id, ref).run();
    return c.json({ ok: true, replies: [] });
  }
  const text = str(body.message, 2000);
  if (!text) throw bad('Escribe un mensaje de prueba.');
  const conv = await ensureConversation(c.env, b, 'test', null, ref, body.name ? str(body.name, 80) : 'Cliente de prueba');
  if (Boolean(conv.is_owner) !== asOwner) await c.env.DB.prepare('UPDATE conversations SET is_owner = ? WHERE id = ?').bind(asOwner ? 1 : 0, conv.id).run();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO messages (business_id, conversation_id, direction, author, text, created_at) VALUES (?, ?, 'in', 'customer', ?, ?)").bind(b.id, conv.id, text, now),
    c.env.DB.prepare('UPDATE conversations SET last_message_ts = ?, last_inbound_ts = ?, bot_paused_until = 0 WHERE id = ?').bind(now, now, conv.id),
  ]);
  const result = await runConversation(c.env, b.id, conv.id);
  return c.json({ ok: true, ...result });
});
