import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule, requireRole } from '../auth';
import { getBusiness, invalidateBusiness, type Settings } from '../db';
import { bad, cents, int, money, notFound, str } from '../lib/http';
import { localDate } from '../lib/time';

const app = () => {
  const h = new Hono<AppEnv>();
  h.use('*', requireAuth, requireBusiness);
  return h;
};
export const settings = app();
export const services = app();
export const aiDocuments = app();
export const agentConfig = app();

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/* ---------- Ajustes (horario, reglas de reserva, perfil del negocio) ---------- */

settings.get('/', async (c) => c.json((await getBusiness(c.env, c.get('businessId')))!.settings));

settings.put('/', requireRole('admin'), async (c) => {
  const current = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  const prev = current.settings;
  const tz = str(body.businessTimezone, 60) || prev.businessTimezone;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw bad('Zona horaria inválida.'); }
  const profile = { ...prev.businessProfile, ...(body.businessProfile || {}) };
  const settings: Settings = {
    aiMode: body.aiMode === 'owner' ? 'owner' : 'client',
    appointmentDurationMinutes: clamp(body.appointmentDurationMinutes, 5, 600, prev.appointmentDurationMinutes),
    businessTimezone: tz,
    slotIntervalMinutes: clamp(body.slotIntervalMinutes, 5, 240, prev.slotIntervalMinutes),
    minimumBookingNoticeMinutes: clamp(body.minimumBookingNoticeMinutes, 0, 10080, prev.minimumBookingNoticeMinutes),
    maximumAdvanceBookingDays: clamp(body.maximumAdvanceBookingDays, 1, 365, prev.maximumAdvanceBookingDays),
    closedDates: Array.isArray(body.closedDates) ? body.closedDates.filter((d: string) => DATE.test(d)).slice(0, 200) : prev.closedDates,
    businessHours: Array.isArray(body.businessHours)
      ? [0, 1, 2, 3, 4, 5, 6].map((day) => {
        const h = body.businessHours.find((x: { day: number }) => Number(x.day) === day) || {};
        const start = TIME.test(h.start) ? h.start : '09:00';
        const end = TIME.test(h.end) ? h.end : '18:00';
        if (h.enabled && start >= end) throw bad('La hora de cierre debe ser después de la de apertura.');
        return { day, enabled: h.enabled === true, start, end };
      })
      : prev.businessHours,
    parallelCapacity: clamp(body.parallelCapacity, 1, 100, prev.parallelCapacity),
    coexistencePauseMinutes: clamp(body.coexistencePauseMinutes, 5, 1440, prev.coexistencePauseMinutes),
    businessProfile: {
      businessName: str(profile.businessName, 120) || current.name,
      communicationStyle: ['formal', 'semiformal', 'friend'].includes(profile.communicationStyle) ? profile.communicationStyle : 'semiformal',
      preferredTone: str(profile.preferredTone, 300),
      greeting: str(profile.greeting, 300),
      address: str(profile.address, 300),
      contactPhone: str(profile.contactPhone, 40),
      cancellationPolicy: str(profile.cancellationPolicy, 500),
      arrivalInstructions: str(profile.arrivalInstructions, 500),
      generalNotes: str(profile.generalNotes, 1500),
      acceptedPaymentMethods: Array.isArray(profile.acceptedPaymentMethods) ? profile.acceptedPaymentMethods.map((m: unknown) => str(m, 40)).slice(0, 10) : [],
      paymentInstructions: str(profile.paymentInstructions, 600),
    },
  };
  await c.env.DB.prepare('UPDATE businesses SET name = ?, timezone = ?, settings = ? WHERE id = ?')
    .bind(settings.businessProfile.businessName, tz, JSON.stringify(settings), current.id).run();
  await invalidateBusiness(c.env, current.id);
  return c.json(settings);
});

/* ---------- Servicios ---------- */

type ServiceRow = { id: number; name: string; description: string; duration_minutes: number; price_cents: number | null; enabled: number; return_cycle_days: number | null; capacity: number };
const serviceOut = (s: ServiceRow) => ({
  id: s.id, name: s.name, description: s.description, duration_minutes: s.duration_minutes, price: money(s.price_cents),
  enabled: s.enabled === 1, return_cycle_days: s.return_cycle_days, capacity: s.capacity,
});

services.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM services WHERE business_id = ? ORDER BY id').bind(c.get('businessId')).all<ServiceRow>();
  return c.json(results.map(serviceOut));
});

function serviceIn(body: Record<string, unknown>) {
  const name = str(body.name, 120);
  if (!name) throw bad('El servicio necesita un nombre.');
  return {
    name, description: str(body.description, 500), duration: clamp(body.duration_minutes, 5, 1440, 60), price: cents(body.price),
    enabled: body.enabled === false ? 0 : 1,
    cycle: body.return_cycle_days === '' || body.return_cycle_days == null ? null : clamp(body.return_cycle_days, 1, 730, 30),
    capacity: clamp(body.capacity, 1, 500, 1),
  };
}

services.post('/', requireRole('admin'), async (c) => {
  const s = serviceIn(await c.req.json());
  const row = await c.env.DB.prepare(
    `INSERT INTO services (business_id, name, description, duration_minutes, price_cents, enabled, return_cycle_days, capacity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(c.get('businessId'), s.name, s.description, s.duration, s.price, s.enabled, s.cycle, s.capacity).first<ServiceRow>();
  return c.json(serviceOut(row!));
});

services.put('/:id', requireRole('admin'), async (c) => {
  const s = serviceIn(await c.req.json());
  const row = await c.env.DB.prepare(
    `UPDATE services SET name = ?, description = ?, duration_minutes = ?, price_cents = ?, enabled = ?, return_cycle_days = ?, capacity = ?
     WHERE id = ? AND business_id = ? RETURNING *`,
  ).bind(s.name, s.description, s.duration, s.price, s.enabled, s.cycle, s.capacity, int(c.req.param('id')), c.get('businessId')).first<ServiceRow>();
  if (!row) throw notFound('Servicio no encontrado.');
  return c.json(serviceOut(row));
});

services.delete('/:id', requireRole('admin'), async (c) => {
  await c.env.DB.prepare('DELETE FROM services WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Conocimiento del asistente ---------- */

const MAX_DOC_CHARS = 20_000;
const MAX_DOCS = 10;

aiDocuments.get('/', requireModule('asistente'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, mime_type, size_bytes, created_at FROM ai_documents WHERE business_id = ? ORDER BY id DESC')
    .bind(c.get('businessId')).all<{ created_at: number }>();
  return c.json(results.map((d) => ({ ...d, created_at: new Date(d.created_at).toISOString().slice(0, 19).replace('T', ' ') })));
});

aiDocuments.post('/', requireRole('admin'), requireModule('asistente'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 200);
  const mime = str(body.mimeType, 100) || 'text/plain';
  let content = String(body.content ?? '');
  if (mime !== 'application/pdf' && content.length > 500_000) throw bad('El documento es demasiado grande.');
  if (!name || !content) throw bad('El documento está vacío.');
  if (mime === 'application/pdf') {
    if (content.length > 2.8 * 1024 * 1024) throw bad('El PDF supera los 2 MB.');
    // Los PDF se convierten a texto una sola vez con Gemini (más barato que enviarlos en cada mensaje).
    const { extractPdfText } = await import('../agent/gemini');
    content = await extractPdfText(c.env, content);
  }
  content = content.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').slice(0, MAX_DOC_CHARS);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_documents WHERE business_id = ?').bind(c.get('businessId')).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_DOCS) throw bad(`Puedes tener hasta ${MAX_DOCS} documentos. Elimina uno para subir otro.`);
  const doc = await c.env.DB.prepare(
    'INSERT INTO ai_documents (business_id, name, mime_type, content, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, size_bytes',
  ).bind(c.get('businessId'), name, mime, content, content.length, Date.now()).first();
  return c.json(doc);
});

aiDocuments.delete('/:id', requireRole('admin'), async (c) => {
  await c.env.DB.prepare('DELETE FROM ai_documents WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Configuración del agente que sí edita el dueño ---------- */

agentConfig.get('/config', requireModule('asistente'), async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  return c.json({
    faqs: b.agent.faqs, ownerPhones: b.agent.ownerPhones, aiEnabled: b.ai_enabled,
    // Solo lectura para el dueño:
    niche: b.niche, mode: b.mode, locked: b.locked, monthlyBudgetUsd: b.agent.monthlyBudgetUsd,
  });
});

agentConfig.put('/config', requireRole('admin'), requireModule('asistente'), async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const body = await c.req.json().catch(() => ({}));
  const agent = { ...b.agent };
  if (Array.isArray(body.faqs)) {
    agent.faqs = body.faqs.slice(0, 40).map((f: { keywords?: unknown; answer?: unknown }) => ({
      keywords: (Array.isArray(f.keywords) ? f.keywords : String(f.keywords ?? '').split(','))
        .map((k: unknown) => str(k, 60).toLowerCase()).filter(Boolean).slice(0, 10),
      answer: str(f.answer, 800),
    })).filter((f: { keywords: string[]; answer: string }) => f.keywords.length && f.answer);
  }
  if (Array.isArray(body.ownerPhones)) {
    agent.ownerPhones = body.ownerPhones.map((p: unknown) => String(p).replace(/\D/g, '')).filter((p: string) => p.length >= 8).slice(0, 5);
  }
  await c.env.DB.prepare('UPDATE businesses SET agent_config = ? WHERE id = ?').bind(JSON.stringify(agent), b.id).run();
  if (typeof body.aiEnabled === 'boolean') {
    await c.env.DB.prepare('UPDATE businesses SET ai_enabled = ? WHERE id = ?').bind(body.aiEnabled ? 1 : 0, b.id).run();
  }
  await invalidateBusiness(c.env, b.id);
  return c.json({ ok: true });
});

/** Medidor de retorno: cuánto costó la IA y cuánto agendó/vendió. */
agentConfig.get('/usage', requireModule('asistente'), async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const today = localDate(Date.now(), b.timezone);
  const month = today.slice(0, 7);
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(free_replies),0) AS free_replies,
            COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(cost_micros),0) AS cost_micros, COALESCE(SUM(booked_cents),0) AS booked_cents
       FROM ai_usage WHERE business_id = ? AND day LIKE ?`,
  ).bind(b.id, `${month}%`).first<Record<string, number>>();
  const cost = (row?.cost_micros ?? 0) / 1e6;
  return c.json({
    month, calls: row?.calls ?? 0, freeReplies: row?.free_replies ?? 0, inputTokens: row?.input_tokens ?? 0, outputTokens: row?.output_tokens ?? 0,
    costUsd: cost, bookedUsd: (row?.booked_cents ?? 0) / 100, budgetUsd: b.agent.monthlyBudgetUsd,
    budgetUsedPct: b.agent.monthlyBudgetUsd > 0 ? Math.round((cost / b.agent.monthlyBudgetUsd) * 100) : 0,
  });
});

