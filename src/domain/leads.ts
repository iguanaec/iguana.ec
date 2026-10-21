// Prospectos (inmobiliaria, servicios profesionales) y propiedades.
import type { Env } from '../env';
import { money } from '../lib/http';

export type PropertyRow = {
  id: number; title: string; operation: string; type: string; zone: string; price_cents: number; bedrooms: number | null;
  bathrooms: number | null; area_m2: number | null; description: string; url: string; status: string;
};

export const propertyOut = (p: PropertyRow) => ({ ...p, price: money(p.price_cents) });

export async function searchProperties(env: Env, businessId: number, f: {
  operation?: string; type?: string; zone?: string; maxPrice?: number | null; minBedrooms?: number | null;
}, limit = 3) {
  const where = ["business_id = ?", "status = 'disponible'"];
  const args: unknown[] = [businessId];
  if (f.operation) { where.push('operation = ?'); args.push(f.operation); }
  if (f.type) { where.push('type LIKE ?'); args.push(`%${f.type}%`); }
  if (f.zone) { where.push('(zone LIKE ? OR title LIKE ? OR description LIKE ?)'); args.push(`%${f.zone}%`, `%${f.zone}%`, `%${f.zone}%`); }
  if (f.maxPrice) { where.push('price_cents <= ?'); args.push(Math.round(f.maxPrice * 100 * 1.1)); } // 10 % de margen
  if (f.minBedrooms) { where.push('bedrooms >= ?'); args.push(f.minBedrooms); }
  const { results } = await env.DB.prepare(`SELECT * FROM properties WHERE ${where.join(' AND ')} ORDER BY price_cents LIMIT ?`)
    .bind(...args, limit).all<PropertyRow>();
  return results;
}

/** Puntaje 0-100: presupuesto, forma de pago y urgencia definen qué tan caliente está el prospecto. */
export function scoreLead(l: { budget_cents?: number | null; financing?: string; timeline?: string; zone?: string; interest?: string }) {
  let score = 10;
  if (l.budget_cents) score += 25;
  if (l.financing && !/defin|no s/i.test(l.financing)) score += 20;
  if (l.zone) score += 10;
  if (l.interest) score += 10;
  const t = (l.timeline || '').toLowerCase();
  if (/inmediat|ya|urgente|este mes|1 mes|semana/.test(t)) score += 25;
  else if (/2|3|tres|dos|pronto/.test(t)) score += 15;
  else if (t) score += 5;
  return Math.min(100, score);
}

export async function upsertLead(env: Env, businessId: number, customerId: number | null, conversationId: number | null, data: {
  interest?: string; budget_cents?: number | null; zone?: string; financing?: string; timeline?: string; notes?: string;
}) {
  const existing = customerId
    ? await env.DB.prepare("SELECT * FROM leads WHERE business_id = ? AND customer_id = ? AND stage NOT IN ('ganado','perdido') ORDER BY id DESC LIMIT 1")
      .bind(businessId, customerId).first<Record<string, unknown>>()
    : null;
  const merged = {
    interest: data.interest || (existing?.interest as string) || '',
    budget_cents: data.budget_cents ?? (existing?.budget_cents as number | null) ?? null,
    zone: data.zone || (existing?.zone as string) || '',
    financing: data.financing || (existing?.financing as string) || '',
    timeline: data.timeline || (existing?.timeline as string) || '',
    notes: [existing?.notes, data.notes].filter(Boolean).join('\n').slice(-2000),
  };
  const score = scoreLead(merged);
  const stage = score >= 60 ? 'calificado' : 'nuevo';
  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      `UPDATE leads SET interest = ?, budget_cents = ?, zone = ?, financing = ?, timeline = ?, notes = ?, score = ?,
              stage = CASE WHEN stage = 'nuevo' THEN ? ELSE stage END, updated_at = ? WHERE id = ?`,
    ).bind(merged.interest, merged.budget_cents, merged.zone, merged.financing, merged.timeline, merged.notes, score, stage, now, existing.id).run();
    return { id: existing.id as number, score };
  }
  const row = await env.DB.prepare(
    `INSERT INTO leads (business_id, customer_id, conversation_id, interest, budget_cents, zone, financing, timeline, notes, score, stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(businessId, customerId, conversationId, merged.interest, merged.budget_cents, merged.zone, merged.financing, merged.timeline, merged.notes,
    score, stage, now, now).first<{ id: number }>();
  return { id: row!.id, score };
}
