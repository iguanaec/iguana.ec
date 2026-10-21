import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule } from '../auth';
import { getBusiness } from '../db';
import { APPOINTMENT_SELECT, appointmentOut, type AppointmentJoined } from '../domain/booking';
import { getNiche } from '../niches';
import { bad, int, json, notFound, str } from '../lib/http';

const customers = new Hono<AppEnv>();
customers.use('*', requireAuth, requireBusiness, requireModule('clientes'));

type CustomerRow = {
  id: number; first_name: string; last_name: string; phone: string; cedula_ruc: string; address: string;
  telegram_username: string; contact_channel: string; extra: string; appointment_count?: number;
};

export const customerOut = (c: CustomerRow) => ({
  id: c.id, first_name: c.first_name, last_name: c.last_name, full_name: `${c.first_name} ${c.last_name}`.trim(),
  phone: c.phone, cedula_ruc: c.cedula_ruc, address: c.address, telegram_username: c.telegram_username,
  contact_channel: c.contact_channel, extra: json<Record<string, string>>(c.extra, {}), appointment_count: c.appointment_count ?? 0,
});

customers.get('/', async (c) => {
  const q = str(c.req.query('q'), 80);
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id AND a.status != 'cancelled') AS appointment_count
       FROM customers c WHERE c.business_id = ?
       ${q ? "AND (c.first_name || ' ' || c.last_name LIKE ? OR c.phone LIKE ?)" : ''}
      ORDER BY c.first_name, c.last_name LIMIT 2000`,
  ).bind(c.get('businessId'), ...(q ? [like, like] : [])).all<CustomerRow>();
  return c.json(results.map(customerOut));
});

/** Solo se guardan los campos extra definidos por el giro. */
async function readCustomer(c: { env: AppEnv['Bindings'] }, businessId: number, body: Record<string, unknown>) {
  const business = (await getBusiness(c.env, businessId))!;
  const fields = getNiche(business.niche)?.customerFields ?? [];
  const rawExtra = (body.extra && typeof body.extra === 'object' ? body.extra : {}) as Record<string, unknown>;
  const extra: Record<string, string> = {};
  for (const f of fields) if (rawExtra[f.key] != null && rawExtra[f.key] !== '') extra[f.key] = str(rawExtra[f.key], 200);
  const first = str(body.first_name, 80);
  if (!first) throw bad('Escribe el nombre del cliente.');
  return {
    first, last: str(body.last_name, 80), phone: str(body.phone, 32).replace(/\D/g, ''), cedula: str(body.cedula_ruc, 20),
    address: str(body.address, 300), extra: JSON.stringify(extra),
  };
}

customers.post('/', async (c) => {
  const v = await readCustomer(c, c.get('businessId'), await c.req.json());
  const row = await c.env.DB.prepare(
    `INSERT INTO customers (business_id, first_name, last_name, phone, cedula_ruc, address, extra, contact_channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(c.get('businessId'), v.first, v.last, v.phone, v.cedula, v.address, v.extra, v.phone ? 'whatsapp' : '', Date.now()).first<CustomerRow>();
  return c.json(customerOut(row!));
});

customers.get('/:id', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const id = int(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').bind(id, b.id).first<CustomerRow>();
  if (!row) throw notFound('Cliente no encontrado.');
  const [appts, orders, conv] = await c.env.DB.batch([
    c.env.DB.prepare(`${APPOINTMENT_SELECT} WHERE a.customer_id = ? AND a.business_id = ? ORDER BY a.start_ts DESC LIMIT 100`).bind(id, b.id),
    c.env.DB.prepare('SELECT id, status, total_cents, paid_cents, created_at FROM orders WHERE customer_id = ? AND business_id = ? ORDER BY id DESC LIMIT 50').bind(id, b.id),
    c.env.DB.prepare('SELECT id, kind FROM conversations WHERE customer_id = ? AND business_id = ? ORDER BY last_message_ts DESC LIMIT 1').bind(id, b.id),
  ]);
  return c.json({
    ...customerOut(row),
    appointments: (appts.results as AppointmentJoined[]).map((a) => appointmentOut(a, b.timezone)),
    orders: orders.results,
    conversation: conv.results[0] ?? null,
  });
});

customers.put('/:id', async (c) => {
  const v = await readCustomer(c, c.get('businessId'), await c.req.json());
  const row = await c.env.DB.prepare(
    `UPDATE customers SET first_name = ?, last_name = ?, phone = ?, cedula_ruc = ?, address = ?, extra = ?
      WHERE id = ? AND business_id = ? RETURNING *`,
  ).bind(v.first, v.last, v.phone, v.cedula, v.address, v.extra, int(c.req.param('id')), c.get('businessId')).first<CustomerRow>();
  if (!row) throw notFound('Cliente no encontrado.');
  return c.json(customerOut(row));
});

customers.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM customers WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

export default customers;
