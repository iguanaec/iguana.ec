// Tareas programadas. Cada 15 min: recordatorios y lista de espera. Diario: resumen al dueño y reactivación.
import type { Env } from '../env';
import { getBusiness, type Business } from '../db';
import { humanDateTime, localDate } from '../lib/time';
import { money } from '../lib/http';
import { dashboardData } from '../routes/money';
import { sendText } from '../channels/meta';
import type { ChannelRow } from '../channels/types';
import { sendOutreach } from './outreach';
import { runAutoReactivation } from './reactivation';

const HOUR = 3600_000;

async function activeBusinesses(env: Env) {
  const { results } = await env.DB.prepare("SELECT id FROM businesses WHERE status != 'suspended' AND ai_enabled = 1").all<{ id: number }>();
  return results.map((r) => r.id);
}

async function reminders(env: Env, b: Business) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.customer_id, a.start_ts, s.name AS service_name, c.first_name FROM appointments a
       JOIN customers c ON c.id = a.customer_id LEFT JOIN services s ON s.id = a.service_id
      WHERE a.business_id = ? AND a.status = 'confirmed' AND a.reminder_sent = 0 AND a.start_ts BETWEEN ? AND ? AND a.created_at < ?
      LIMIT 100`,
  ).bind(b.id, now + 2 * HOUR, now + 24 * HOUR, now - HOUR).all<{ id: number; customer_id: number; start_ts: number; service_name: string; first_name: string }>();
  for (const a of results) {
    const when = humanDateTime(a.start_ts, b.timezone);
    const text = `Hola ${a.first_name || ''} 👋 te recordamos tu ${a.service_name ?? 'cita'} en ${b.name} el ${when}. Responde "confirmo" o escríbenos si necesitas cambiarla.`.replace(/\s{2,}/g, ' ');
    const r = await sendOutreach(env, b, a.customer_id, text,
      b.agent.reminderTemplate ? { name: b.agent.reminderTemplate, params: [a.first_name || 'cliente', a.service_name ?? 'cita', when] } : undefined)
      .catch((err) => { console.error('reminder', (err as Error).message); return { sent: false }; });
    await env.DB.prepare('UPDATE appointments SET reminder_sent = ? WHERE id = ?').bind(r.sent ? 1 : 2, a.id).run();
  }
}

async function waitlistOffers(env: Env, b: Business) {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.customer_id, w.offered_ts, c.first_name, s.name AS service_name FROM waitlist w
       JOIN customers c ON c.id = w.customer_id LEFT JOIN services s ON s.id = w.service_id
      WHERE w.business_id = ? AND w.status = 'offered' AND w.notified = 0 AND w.offered_ts > ? LIMIT 50`,
  ).bind(b.id, Date.now() + HOUR).all<{ id: number; customer_id: number; offered_ts: number; first_name: string; service_name: string | null }>();
  for (const w of results) {
    const text = `¡Hola ${w.first_name || ''}! Se liberó un cupo${w.service_name ? ` para ${w.service_name}` : ''} el ${humanDateTime(w.offered_ts, b.timezone)}. ¿Te lo reservo? Responde "sí" y lo aparto.`.replace(/\s{2,}/g, ' ');
    const r = await sendOutreach(env, b, w.customer_id, text).catch(() => ({ sent: false }));
    // Si no se pudo (fuera de ventana), vuelve a la cola de espera para el próximo hueco.
    await env.DB.prepare(r.sent ? 'UPDATE waitlist SET notified = 1 WHERE id = ?' : "UPDATE waitlist SET status = 'waiting', offered_ts = NULL WHERE id = ?").bind(w.id).run();
  }
}

/** El dueño recibe su resumen por WhatsApp si escribió al número del negocio en las últimas 24 h. */
async function ownerDailySummary(env: Env, b: Business) {
  const today = localDate(Date.now(), b.timezone);
  const yesterday = localDate(Date.now() - 24 * HOUR, b.timezone);
  const { results: convs } = await env.DB.prepare(
    "SELECT cv.id, cv.contact_ref, cv.channel_id FROM conversations cv WHERE cv.business_id = ? AND cv.is_owner = 1 AND cv.last_inbound_ts > ? AND cv.channel_id IS NOT NULL",
  ).bind(b.id, Date.now() - 23 * HOUR).all<{ id: number; contact_ref: string; channel_id: number }>();
  if (!convs.length) return;
  const d = await dashboardData(env, b, yesterday, yesterday);
  const agenda = await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE business_id = ? AND status = 'confirmed' AND start_ts BETWEEN ? AND ?")
    .bind(b.id, Date.now(), Date.now() + 24 * HOUR).first<{ n: number }>();
  const proofs = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_proofs WHERE business_id = ? AND status = 'pending'").bind(b.id).first<{ n: number }>();
  const text = [
    `☀️ Buenos días. Resumen de ayer en ${b.name}:`,
    `💵 Cobrado $${money(d.summary.income_cents)} · Gastos $${money(d.summary.expenses_cents)} · Ganancia $${money(d.summary.profit_cents)}`,
    `📌 Por cobrar: $${money(d.summary.outstanding_cents)}`,
    `📅 Hoy (${today}) tienes ${agenda?.n ?? 0} citas.`,
    proofs?.n ? `🧾 ${proofs.n} comprobante(s) por aprobar en el panel.` : '',
  ].filter(Boolean).join('\n');
  for (const conv of convs) {
    const channel = await env.DB.prepare("SELECT * FROM channels WHERE id = ? AND status = 'active'").bind(conv.channel_id).first<ChannelRow>();
    if (!channel) continue;
    await sendText(env, channel, conv.contact_ref, text).catch((err) => console.error('summary', (err as Error).message));
  }
}

export async function runCron(env: Env, cron: string) {
  const daily = cron === '0 13 * * *';
  for (const id of await activeBusinesses(env)) {
    const b = await getBusiness(env, id);
    if (!b) continue;
    try {
      if (daily) {
        await ownerDailySummary(env, b);
        await runAutoReactivation(env, b);
      } else {
        if (b.modules.includes('calendario')) await reminders(env, b);
        if (b.modules.includes('lista_espera')) await waitlistOffers(env, b);
      }
    } catch (err) {
      console.error('cron', id, (err as Error).message);
    }
  }
  // Limpieza: sesiones vencidas.
  if (daily) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
}
