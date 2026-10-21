// Ahorro: respuestas sin IA, presupuesto mensual y medición de costo/retorno por negocio.
import type { Env } from '../env';
import type { Business } from '../db';
import { localDate } from '../lib/time';

export async function trackUsage(env: Env, business: Business, u: { input?: number; output?: number; calls?: number; free?: number; bookedCents?: number }) {
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cost = Math.round(input * Number(env.GEMINI_PRICE_INPUT || 0.25) + output * Number(env.GEMINI_PRICE_OUTPUT || 1.5));
  await env.DB.prepare(
    `INSERT INTO ai_usage (business_id, day, calls, free_replies, input_tokens, output_tokens, cost_micros, booked_cents)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(business_id, day) DO UPDATE SET calls = calls + ?3, free_replies = free_replies + ?4, input_tokens = input_tokens + ?5,
       output_tokens = output_tokens + ?6, cost_micros = cost_micros + ?7, booked_cents = booked_cents + ?8`,
  ).bind(business.id, localDate(Date.now(), business.timezone), u.calls ?? 0, u.free ?? 0, input, output, cost, u.bookedCents ?? 0).run();
}

export const recordBooked = (env: Env, business: Business, cents: number | null | undefined) =>
  cents ? trackUsage(env, business, { bookedCents: cents }) : Promise.resolve();

export async function budgetExceeded(env: Env, business: Business) {
  if (!(business.agent.monthlyBudgetUsd > 0)) return false;
  const month = localDate(Date.now(), business.timezone).slice(0, 7);
  const row = await env.DB.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS c FROM ai_usage WHERE business_id = ? AND day LIKE ?')
    .bind(business.id, `${month}%`).first<{ c: number }>();
  return (row?.c ?? 0) / 1e6 >= business.agent.monthlyBudgetUsd;
}

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Respuesta gratis si el mensaje es corto y coincide con una FAQ del dueño
 * (todas las palabras clave de la FAQ aparecen). Mensajes largos van a la IA.
 */
export function freeAnswer(business: Business, text: string): string | null {
  const t = norm(text);
  if (!t || t.split(' ').length > 12) return null;
  for (const faq of business.agent.faqs) {
    if (faq.keywords.length && faq.keywords.every((k) => t.includes(norm(k)))) return faq.answer;
  }
  return null;
}
