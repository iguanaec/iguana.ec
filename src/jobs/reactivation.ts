// Reactivación por frecuencia del giro: "tu perrito lleva 6 semanas sin baño".
import type { Env } from '../env';
import type { Business } from '../db';
import { getNiche } from '../niches';
import { json } from '../lib/http';
import { sendOutreach } from './outreach';

const DAY = 86400_000;

export interface Candidate {
  customer_id: number; name: string; phone: string; service_name: string; days_since: number; message: string; whatsapp_link: string | null;
}

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{([\w.]+)\}/g, (_, key: string) => vars[key] ?? '').replace(/\s{2,}/g, ' ').trim();
}

export async function reactivationCandidates(env: Env, b: Business, limit = 50): Promise<Candidate[]> {
  const now = Date.now();
  const niche = getNiche(b.niche);
  const template = niche?.reactivationMessage ?? 'Hola {nombre}, ¡te extrañamos en {negocio}! ¿Te ayudo a agendar tu próximo {servicio}?';
  type Row = { id: number; first_name: string; last_name: string; phone: string; extra: string; last_reactivation_ts: number | null; service_name: string; cycle: number; last_ts: number };
  let rows: Row[];
  if (b.mode === 'ventas' || b.mode === 'pedidos') {
    // Comercio: clientes que no compran hace más de 60 días.
    rows = (await env.DB.prepare(
      `SELECT c.id, c.first_name, c.last_name, c.phone, c.extra, c.last_reactivation_ts, 'compra' AS service_name, 60 AS cycle, MAX(o.created_at) AS last_ts
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.business_id = ? AND o.status != 'cancelado' GROUP BY c.id HAVING last_ts < ? ORDER BY last_ts LIMIT ?`,
    ).bind(b.id, now - 60 * DAY, limit * 2).all<Row>()).results;
  } else {
    rows = (await env.DB.prepare(
      `SELECT c.id, c.first_name, c.last_name, c.phone, c.extra, c.last_reactivation_ts, s.name AS service_name, s.return_cycle_days AS cycle, MAX(a.start_ts) AS last_ts
         FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN services s ON s.id = a.service_id
        WHERE a.business_id = ? AND a.status IN ('completed','confirmed') AND a.start_ts < ? AND s.return_cycle_days IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM appointments f WHERE f.customer_id = c.id AND f.start_ts > ? AND f.status = 'confirmed')
        GROUP BY c.id, s.id HAVING last_ts < ? - cycle * ${DAY} ORDER BY last_ts LIMIT ?`,
    ).bind(b.id, now, now, now, limit * 2).all<Row>()).results;
  }
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    if (r.last_reactivation_ts && now - r.last_reactivation_ts < r.cycle * DAY) continue;
    seen.add(r.id);
    const extra = json<Record<string, string>>(r.extra, {});
    const vars: Record<string, string> = {
      nombre: r.first_name || '', servicio: r.service_name.toLowerCase(), dias: String(Math.floor((now - r.last_ts) / DAY)), negocio: b.name,
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`extra.${k}`, v])),
    };
    const message = fill(template, vars);
    out.push({
      customer_id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), phone: r.phone, service_name: r.service_name, days_since: Number(vars.dias), message,
      // Coexistencia: el dueño lo envía con un toque desde su propio WhatsApp, sin costo de plantilla.
      whatsapp_link: r.phone ? `https://wa.me/${r.phone}?text=${encodeURIComponent(message)}` : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Envío automático (solo si Iguana lo activó para el negocio y hay plantilla o ventana abierta). */
export async function runAutoReactivation(env: Env, b: Business) {
  if (!b.agent.autoReactivation) return 0;
  let sent = 0;
  for (const cand of await reactivationCandidates(env, b, 20)) {
    const r = await sendOutreach(env, b, cand.customer_id, cand.message,
      b.agent.reactivationTemplate ? { name: b.agent.reactivationTemplate, params: [cand.name || 'cliente', cand.service_name] } : undefined).catch(() => ({ sent: false }));
    if (r.sent) {
      sent++;
      await env.DB.prepare('UPDATE customers SET last_reactivation_ts = ? WHERE id = ?').bind(Date.now(), cand.customer_id).run();
    }
  }
  return sent;
}
