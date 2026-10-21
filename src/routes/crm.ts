// Propiedades, prospectos, lista de espera y reactivación.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule } from '../auth';
import { getBusiness } from '../db';
import { propertyOut, type PropertyRow } from '../domain/leads';
import { reactivationCandidates } from '../jobs/reactivation';
import { bad, cents, int, money, notFound, str } from '../lib/http';
import { toLocalIso } from '../lib/time';

/* ---------- Propiedades ---------- */

export const properties = new Hono<AppEnv>();
properties.use('*', requireAuth, requireBusiness, requireModule('propiedades'));

const propertyIn = (b: Record<string, unknown>) => {
  const title = str(b.title, 200);
  const price = cents(b.price);
  if (!title || price == null) throw bad('La propiedad necesita título y precio.');
  return {
    title, price, operation: b.operation === 'arriendo' ? 'arriendo' : 'venta', type: str(b.type, 40) || 'casa', zone: str(b.zone, 120),
    bedrooms: int(b.bedrooms), bathrooms: int(b.bathrooms), area: int(b.area_m2), description: str(b.description, 2000), url: str(b.url, 500),
    status: ['disponible', 'reservada', 'vendida'].includes(String(b.status)) ? String(b.status) : 'disponible',
  };
};

properties.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM properties WHERE business_id = ? ORDER BY id DESC').bind(c.get('businessId')).all<PropertyRow>();
  return c.json(results.map(propertyOut));
});

properties.post('/', async (c) => {
  const p = propertyIn(await c.req.json());
  const row = await c.env.DB.prepare(
    `INSERT INTO properties (business_id, title, operation, type, zone, price_cents, bedrooms, bathrooms, area_m2, description, url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(c.get('businessId'), p.title, p.operation, p.type, p.zone, p.price, p.bedrooms, p.bathrooms, p.area, p.description, p.url, p.status).first<PropertyRow>();
  return c.json(propertyOut(row!));
});

properties.put('/:id', async (c) => {
  const p = propertyIn(await c.req.json());
  const row = await c.env.DB.prepare(
    `UPDATE properties SET title = ?, operation = ?, type = ?, zone = ?, price_cents = ?, bedrooms = ?, bathrooms = ?, area_m2 = ?, description = ?, url = ?, status = ?
      WHERE id = ? AND business_id = ? RETURNING *`,
  ).bind(p.title, p.operation, p.type, p.zone, p.price, p.bedrooms, p.bathrooms, p.area, p.description, p.url, p.status, int(c.req.param('id')), c.get('businessId'))
    .first<PropertyRow>();
  if (!row) throw notFound('Propiedad no encontrada.');
  return c.json(propertyOut(row));
});

properties.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM properties WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Prospectos ---------- */

export const leads = new Hono<AppEnv>();
leads.use('*', requireAuth, requireBusiness, requireModule('leads'));

const LEAD_STAGES = ['nuevo', 'calificado', 'visita', 'negociacion', 'ganado', 'perdido'];

leads.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, c.first_name, c.last_name, c.phone FROM leads l LEFT JOIN customers c ON c.id = l.customer_id
      WHERE l.business_id = ? ORDER BY l.score DESC, l.updated_at DESC LIMIT 500`,
  ).bind(b.id).all<Record<string, unknown> & { budget_cents: number | null; updated_at: number; created_at: number }>();
  return c.json(results.map((l) => ({
    ...l, customer_name: [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Sin nombre', budget: money(l.budget_cents),
    updated_at: toLocalIso(l.updated_at, b.timezone), created_at: toLocalIso(l.created_at, b.timezone),
  })));
});

leads.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.stage && !LEAD_STAGES.includes(body.stage)) throw bad('Etapa inválida.');
  const row = await c.env.DB.prepare(
    `UPDATE leads SET stage = COALESCE(?, stage), notes = COALESCE(?, notes), updated_at = ? WHERE id = ? AND business_id = ? RETURNING id`,
  ).bind(body.stage ?? null, body.notes != null ? str(body.notes, 2000) : null, Date.now(), int(c.req.param('id')), c.get('businessId')).first();
  if (!row) throw notFound('Prospecto no encontrado.');
  return c.json({ ok: true });
});

/* ---------- Lista de espera ---------- */

export const waitlist = new Hono<AppEnv>();
waitlist.use('*', requireAuth, requireBusiness, requireModule('lista_espera'));

waitlist.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const { results } = await c.env.DB.prepare(
    `SELECT w.*, c.first_name, c.last_name, c.phone, s.name AS service_name FROM waitlist w
       JOIN customers c ON c.id = w.customer_id LEFT JOIN services s ON s.id = w.service_id
      WHERE w.business_id = ? AND w.status IN ('waiting','offered') ORDER BY w.created_at`,
  ).bind(b.id).all<Record<string, unknown> & { offered_ts: number | null; created_at: number }>();
  return c.json(results.map((w) => ({
    ...w, customer_name: [w.first_name, w.last_name].filter(Boolean).join(' '), offered_at: w.offered_ts ? toLocalIso(w.offered_ts, b.timezone) : null,
    created_at: toLocalIso(w.created_at, b.timezone),
  })));
});

waitlist.delete('/:id', async (c) => {
  await c.env.DB.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ? AND business_id = ?").bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Reactivación: clientes que ya deberían volver ---------- */

export const reactivation = new Hono<AppEnv>();
reactivation.use('*', requireAuth, requireBusiness, requireModule('reactivar'));

reactivation.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  return c.json(await reactivationCandidates(c.env, b, 100));
});

reactivation.post('/:customerId/done', async (c) => {
  await c.env.DB.prepare('UPDATE customers SET last_reactivation_ts = ? WHERE id = ? AND business_id = ?')
    .bind(Date.now(), int(c.req.param('customerId')), c.get('businessId')).run();
  return c.json({ ok: true });
});
