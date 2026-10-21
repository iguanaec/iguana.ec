import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule } from '../auth';
import { getBusiness } from '../db';
import {
  APPOINTMENT_SELECT, appointmentOut, cancelAppointment, createAppointment, getService, rescheduleAppointment, slotsForDay,
  type AppointmentJoined,
} from '../domain/booking';
import { bad, cents, int, notFound, str } from '../lib/http';
import { localDate, localToUtc, parseDateTime, toLocalIso, addDays } from '../lib/time';

const appointments = new Hono<AppEnv>();
appointments.use('*', requireAuth, requireBusiness, requireModule('calendario'));

appointments.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const includeCancelled = c.req.query('include_cancelled') === 'true';
  // Por defecto: 120 días atrás y 120 adelante (suficiente para calendario e inicio).
  const today = localDate(Date.now(), b.timezone);
  const from = localToUtc(c.req.query('from') || addDays(today, -120), '00:00', b.timezone);
  const to = localToUtc(addDays(c.req.query('to') || addDays(today, 120), 1), '00:00', b.timezone);
  const { results } = await c.env.DB.prepare(
    `${APPOINTMENT_SELECT} WHERE a.business_id = ? AND a.start_ts >= ? AND a.start_ts < ? ${includeCancelled ? '' : "AND a.status != 'cancelled'"} ORDER BY a.start_ts`,
  ).bind(b.id, from, to).all<AppointmentJoined>();
  return c.json(results.map((a) => appointmentOut(a, b.timezone)));
});

appointments.get('/availability', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const service = await getService(c.env, b.id, int(c.req.query('service_id')) ?? 0);
  const date = c.req.query('date') || localDate(Date.now(), b.timezone);
  const slots = await slotsForDay(c.env, b, service, date, int(c.req.query('exclude')) ?? 0);
  return c.json({ date, slots: slots.map((t) => toLocalIso(t, b.timezone)) });
});

appointments.post('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  let customerId = int(body.customer_id);
  if (!customerId && body.customer_name) {
    const [first, ...rest] = str(body.customer_name, 120).split(/\s+/);
    const row = await c.env.DB.prepare('INSERT INTO customers (business_id, first_name, last_name, phone, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(b.id, first, rest.join(' '), str(body.phone, 32).replace(/\D/g, ''), Date.now()).first<{ id: number }>();
    customerId = row!.id;
  }
  if (customerId) {
    const own = await c.env.DB.prepare('SELECT 1 FROM customers WHERE id = ? AND business_id = ?').bind(customerId, b.id).first();
    if (!own) throw notFound('Cliente no encontrado.');
  }
  const appt = await createAppointment(c.env, b, {
    customerId, serviceId: int(body.service_id) ?? 0, startTs: parseDateTime(body.start_at, b.timezone), origin: 'admin',
    kind: body.kind === 'visita' ? 'visita' : 'cita', propertyId: int(body.property_id), notes: str(body.notes, 1000), force: body.force === true,
  });
  return c.json({ ok: true, id: appt.id });
});

appointments.post('/:id/payment', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const id = int(c.req.param('id'))!;
  const body = await c.req.json().catch(() => ({}));
  const amount = cents(body.amount);
  if (!amount) throw bad('Escribe el monto cobrado.');
  const row = await c.env.DB.prepare('UPDATE appointments SET paid_cents = paid_cents + ? WHERE id = ? AND business_id = ? RETURNING id')
    .bind(amount, id, b.id).first();
  if (!row) throw notFound('Cita no encontrada.');
  await c.env.DB.prepare('INSERT INTO payments (business_id, appointment_id, amount_cents, method, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(b.id, id, amount, str(body.method, 40) || 'Efectivo', Date.now()).run();
  return c.json({ ok: true });
});

appointments.post('/:id/cancel', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  await cancelAppointment(c.env, b, int(c.req.param('id'))!);
  return c.json({ ok: true });
});

appointments.post('/:id/reschedule', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  await rescheduleAppointment(c.env, b, int(c.req.param('id'))!, parseDateTime(body.start_at, b.timezone), int(body.service_id) ?? undefined, body.force === true);
  return c.json({ ok: true });
});

appointments.post('/:id/status', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  if (!['confirmed', 'completed', 'no_show'].includes(body.status)) throw bad('Estado inválido.');
  const row = await c.env.DB.prepare('UPDATE appointments SET status = ? WHERE id = ? AND business_id = ? RETURNING id')
    .bind(body.status, int(c.req.param('id')), b.id).first();
  if (!row) throw notFound('Cita no encontrada.');
  return c.json({ ok: true });
});

/* Bloqueos de horario (vacaciones, almuerzo, imprevistos). */
appointments.get('/blocks', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const { results } = await c.env.DB.prepare('SELECT * FROM time_blocks WHERE business_id = ? AND end_ts > ? ORDER BY start_ts LIMIT 200')
    .bind(b.id, Date.now()).all<{ id: number; start_ts: number; end_ts: number; reason: string }>();
  return c.json(results.map((r) => ({ id: r.id, start_at: toLocalIso(r.start_ts, b.timezone), end_at: toLocalIso(r.end_ts, b.timezone), reason: r.reason })));
});

appointments.post('/blocks', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  const start = parseDateTime(body.start_at, b.timezone);
  const end = parseDateTime(body.end_at, b.timezone);
  if (!(end > start)) throw bad('El bloqueo debe terminar después de empezar.');
  await c.env.DB.prepare('INSERT INTO time_blocks (business_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?)').bind(b.id, start, end, str(body.reason, 200)).run();
  return c.json({ ok: true });
});

appointments.delete('/blocks/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM time_blocks WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

export default appointments;
