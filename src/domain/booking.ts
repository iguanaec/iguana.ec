// Agenda: disponibilidad real, creación, reprogramación y cancelación.
// Lo usan tanto el panel como el agente de IA, así ambos aplican las mismas reglas.
import type { Env } from '../env';
import type { Business } from '../db';
import { bad, notFound } from '../lib/http';
import { addDays, localDate, localToUtc, toLocalIso, weekdayOf } from '../lib/time';

export interface ServiceRow {
  id: number; name: string; duration_minutes: number; price_cents: number | null; enabled: number; capacity: number; return_cycle_days: number | null;
}

export async function getService(env: Env, businessId: number, serviceId: number) {
  const s = await env.DB.prepare('SELECT * FROM services WHERE id = ? AND business_id = ?').bind(serviceId, businessId).first<ServiceRow>();
  if (!s) throw notFound('Servicio no encontrado.');
  return s;
}

/** Busca un servicio por id o por nombre aproximado (lo que diga el cliente). */
export async function findService(env: Env, businessId: number, ref: string | number | undefined) {
  const { results } = await env.DB.prepare('SELECT * FROM services WHERE business_id = ? AND enabled = 1 ORDER BY id').bind(businessId).all<ServiceRow>();
  if (!results.length) return null;
  if (ref == null || ref === '') return results.length === 1 ? results[0] : null;
  const asId = Number(ref);
  if (Number.isInteger(asId) && asId > 0) return results.find((s) => s.id === asId) ?? null;
  const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const q = norm(String(ref));
  return results.find((s) => norm(s.name) === q) ?? results.find((s) => norm(s.name).includes(q) || q.includes(norm(s.name))) ?? null;
}

type Busy = { start_ts: number; end_ts: number; service_id: number | null };

async function busyBetween(env: Env, businessId: number, from: number, to: number, excludeId = 0) {
  const [appts, blocks] = await env.DB.batch<Busy>([
    env.DB.prepare(`SELECT start_ts, end_ts, service_id FROM appointments
                    WHERE business_id = ? AND status IN ('confirmed','completed') AND start_ts < ? AND end_ts > ? AND id != ?`)
      .bind(businessId, to, from, excludeId),
    env.DB.prepare('SELECT start_ts, end_ts, NULL AS service_id FROM time_blocks WHERE business_id = ? AND start_ts < ? AND end_ts > ?').bind(businessId, to, from),
  ]);
  return { appts: appts.results, blocks: blocks.results };
}

function fits(business: Business, service: ServiceRow, start: number, busy: { appts: Busy[]; blocks: Busy[] }) {
  const end = start + service.duration_minutes * 60000;
  if (busy.blocks.some((b) => b.start_ts < end && b.end_ts > start)) return false;
  // Clases/cupos grupales cuentan solo su servicio; lo demás comparte el personal disponible.
  const group = service.capacity > 1;
  const capacity = group ? service.capacity : business.settings.parallelCapacity;
  const overlapping = busy.appts.filter((a) => a.start_ts < end && a.end_ts > start && (!group || a.service_id === service.id)).length;
  return overlapping < capacity;
}

/** Horarios libres de un día (YYYY-MM-DD en la zona del negocio). */
export async function slotsForDay(env: Env, business: Business, service: ServiceRow, date: string, excludeId = 0, nowTs = Date.now()) {
  const s = business.settings;
  const tz = business.timezone;
  if (s.closedDates.includes(date)) return [];
  const hours = s.businessHours.find((h) => h.day === weekdayOf(date));
  if (!hours?.enabled) return [];
  const open = localToUtc(date, hours.start, tz);
  const close = localToUtc(date, hours.end, tz);
  const earliest = nowTs + s.minimumBookingNoticeMinutes * 60000;
  const latest = nowTs + s.maximumAdvanceBookingDays * 86400_000;
  const duration = service.duration_minutes * 60000;
  const busy = await busyBetween(env, business.id, open, close, excludeId);
  const slots: number[] = [];
  for (let t = open; t + duration <= close; t += s.slotIntervalMinutes * 60000) {
    if (t < earliest || t > latest) continue;
    if (fits(business, service, t, busy)) slots.push(t);
  }
  return slots;
}

/** Próximos horarios libres a partir de una fecha (para ofrecer 3 opciones rápidas). */
export async function nextSlots(env: Env, business: Business, service: ServiceRow, fromDate: string, count = 3, maxDays = 14) {
  const out: number[] = [];
  for (let i = 0; i < maxDays && out.length < count; i++) {
    const day = await slotsForDay(env, business, service, addDays(fromDate, i));
    // Repartir: no ofrecer 3 horarios pegados del mismo día si hay más días.
    const step = Math.max(1, Math.floor(day.length / count));
    for (let k = 0; k < day.length && out.length < count; k += step) out.push(day[k]);
  }
  return out;
}

export interface NewAppointment {
  customerId: number | null;
  serviceId: number;
  startTs: number;
  origin: string;
  kind?: 'cita' | 'visita';
  propertyId?: number | null;
  notes?: string;
  /** El panel puede forzar un horario fuera de las reglas (el dueño manda). */
  force?: boolean;
}

export async function createAppointment(env: Env, business: Business, input: NewAppointment) {
  if (!Number.isFinite(input.startTs)) throw bad('Fecha u hora inválida.');
  const service = await getService(env, business.id, input.serviceId);
  if (!input.force) {
    const date = localDate(input.startTs, business.timezone);
    const free = await slotsForDay(env, business, service, date);
    if (!free.includes(input.startTs)) throw bad('Ese horario ya no está disponible.');
  }
  const end = input.startTs + service.duration_minutes * 60000;
  const row = await env.DB.prepare(
    `INSERT INTO appointments (business_id, customer_id, service_id, property_id, kind, start_ts, end_ts, status, origin, price_cents, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?) RETURNING id`,
  ).bind(business.id, input.customerId, service.id, input.propertyId ?? null, input.kind ?? 'cita', input.startTs, end, input.origin,
    service.price_cents, input.notes ?? '', Date.now()).first<{ id: number }>();
  if (input.customerId) {
    // Si estaba en lista de espera para ese servicio, ya consiguió cupo.
    await env.DB.prepare("UPDATE waitlist SET status = 'booked' WHERE business_id = ? AND customer_id = ? AND status IN ('waiting','offered')")
      .bind(business.id, input.customerId).run();
  }
  return { id: row!.id, service, startTs: input.startTs, endTs: end };
}

export async function rescheduleAppointment(env: Env, business: Business, id: number, startTs: number, serviceId?: number, force = false) {
  const appt = await env.DB.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?').bind(id, business.id)
    .first<{ id: number; service_id: number; start_ts: number; status: string }>();
  if (!appt) throw notFound('Cita no encontrada.');
  const service = await getService(env, business.id, serviceId || appt.service_id);
  if (!force) {
    // La propia cita no cuenta como ocupada al buscar el nuevo horario.
    const free = await slotsForDay(env, business, service, localDate(startTs, business.timezone), id);
    if (!free.includes(startTs)) throw bad('Ese horario ya no está disponible.');
  }
  await env.DB.prepare(
    `UPDATE appointments SET start_ts = ?, end_ts = ?, service_id = ?, price_cents = ?, status = 'confirmed', reminder_sent = 0 WHERE id = ?`,
  ).bind(startTs, startTs + service.duration_minutes * 60000, service.id, service.price_cents, id).run();
  await queueWaitlistOffer(env, business, appt.service_id, appt.start_ts);
  return { id, service, startTs };
}

export async function cancelAppointment(env: Env, business: Business, id: number) {
  const appt = await env.DB.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND business_id = ? AND status != 'cancelled' RETURNING service_id, start_ts")
    .bind(id, business.id).first<{ service_id: number; start_ts: number }>();
  if (!appt) throw notFound('Cita no encontrada o ya cancelada.');
  await queueWaitlistOffer(env, business, appt.service_id, appt.start_ts);
  return appt;
}

/**
 * Relleno de huecos: cuando se libera un cupo, marca al primero de la lista de espera para ofrecérselo.
 * El envío lo hace el cron (respeta la ventana de 24 h de Meta).
 */
async function queueWaitlistOffer(env: Env, business: Business, serviceId: number, startTs: number) {
  if (startTs < Date.now()) return;
  const date = localDate(startTs, business.timezone);
  await env.DB.prepare(
    `UPDATE waitlist SET status = 'offered', offered_ts = ?, notified = 0
      WHERE id = (SELECT id FROM waitlist WHERE business_id = ? AND status = 'waiting'
                    AND (service_id IS NULL OR service_id = ?) AND (desired_date IS NULL OR desired_date = ?)
                  ORDER BY created_at LIMIT 1)`,
  ).bind(startTs, business.id, serviceId, date).run();
}

export function paymentStatus(price: number | null, paid: number) {
  if (paid <= 0) return 'unpaid';
  return price != null && paid >= price ? 'paid' : 'partial';
}

export type AppointmentJoined = {
  id: number; customer_id: number | null; service_id: number | null; property_id: number | null; kind: string; start_ts: number; end_ts: number;
  status: string; origin: string; price_cents: number | null; paid_cents: number; notes: string;
  first_name: string | null; last_name: string | null; phone: string | null; telegram_username: string | null; service_name: string | null;
};

export const APPOINTMENT_SELECT = `
  SELECT a.*, c.first_name, c.last_name, c.phone, c.telegram_username, s.name AS service_name
    FROM appointments a
    LEFT JOIN customers c ON c.id = a.customer_id
    LEFT JOIN services s ON s.id = a.service_id`;

/** Forma que espera el panel. */
export function appointmentOut(a: AppointmentJoined, tz: string) {
  return {
    id: a.id, customer_id: a.customer_id, customer_name: [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Sin nombre',
    service_id: a.service_id, service_name: a.service_name ?? 'Servicio', kind: a.kind, property_id: a.property_id,
    start_at: toLocalIso(a.start_ts, tz), end_at: toLocalIso(a.end_ts, tz), status: a.status, origin: a.origin,
    phone: a.phone ? `${a.phone}@c.us` : '', telegram_username: a.telegram_username ?? '',
    price_cents: a.price_cents, paid_cents: a.paid_cents, payment_status: paymentStatus(a.price_cents, a.paid_cents), notes: a.notes,
  };
}
