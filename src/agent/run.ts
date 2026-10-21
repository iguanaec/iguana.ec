// Turno del agente para una conversación: lee lo pendiente, decide (FAQ gratis o Gemini + herramientas) y responde.
import type { Env } from '../env';
import { getBusiness, type Business } from '../db';
import { generate, type Content } from './gemini';
import { buildSystemPrompt } from './prompt';
import { declarationsFor, runTool, type ToolContext } from './tools';
import { budgetExceeded, freeAnswer, trackUsage } from './economy';
import { sendText } from '../channels/meta';
import type { ChannelRow } from '../channels/types';
import type { ConversationRow } from '../channels/inbound';
import { json } from '../lib/http';

const HISTORY = 8;          // mensajes previos que se envían tal cual
const SUMMARIZE_AFTER = 24; // mensajes sin resumir que disparan un resumen
const MAX_TOOL_ROUNDS = 4;
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', test: 'el chat de prueba' };

type Msg = { id: number; direction: 'in' | 'out'; author: string; text: string; created_at: number };

export interface RunResult { replies: string[]; skipped?: string }

async function deliver(env: Env, business: Business, conv: ConversationRow, text: string) {
  let externalId: string | null = null;
  if (conv.kind !== 'test' && conv.channel_id) {
    const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ? AND business_id = ?').bind(conv.channel_id, business.id).first<ChannelRow>();
    if (!channel || channel.status !== 'active') throw new Error('Canal desconectado.');
    const ids = await sendText(env, channel, conv.contact_ref, text);
    externalId = ids[0] || null;
  }
  await env.DB.prepare(
    "INSERT INTO messages (business_id, conversation_id, direction, author, text, external_id, answered, created_at) VALUES (?, ?, 'out', 'bot', ?, ?, 1, ?)",
  ).bind(business.id, conv.id, text, externalId, Date.now()).run();
}

async function pause(env: Env, convId: number, reason: string, minutes = 60 * 24 * 365) {
  await env.DB.prepare('UPDATE conversations SET bot_paused_until = ?, pause_reason = ? WHERE id = ?').bind(Date.now() + minutes * 60000, reason, convId).run();
}

export async function runConversation(env: Env, businessId: number, conversationId: number): Promise<RunResult> {
  const business = await getBusiness(env, businessId);
  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND business_id = ?').bind(conversationId, businessId).first<ConversationRow>();
  if (!business || !conv) return { replies: [], skipped: 'not_found' };

  const { results: pending } = await env.DB.prepare(
    "SELECT id, direction, author, text, created_at FROM messages WHERE conversation_id = ? AND direction = 'in' AND answered = 0 ORDER BY id",
  ).bind(conv.id).all<Msg>();
  if (!pending.length) return { replies: [] };
  const markAnswered = () => env.DB.prepare(`UPDATE messages SET answered = 1 WHERE id IN (${pending.map(() => '?').join(',')})`).bind(...pending.map((m) => m.id)).run();

  // El bot no habla si: IA apagada, negocio suspendido, conversación tomada por una persona.
  if (!business.ai_enabled || business.status === 'suspended') { await markAnswered(); return { replies: [], skipped: 'disabled' }; }
  if (conv.bot_paused_until > Date.now()) { await markAnswered(); return { replies: [], skipped: conv.pause_reason || 'paused' }; }
  if (business.settings.aiMode !== 'owner' && conv.is_owner && conv.kind !== 'test') {
    // Modo dueño desactivado: los mensajes del dueño no se procesan como cliente.
    await markAnswered();
    return { replies: [], skipped: 'owner_mode_off' };
  }

  const query = pending.map((m) => m.text).join('\n');

  // 1) Respuesta gratis (FAQ del dueño) para un único mensaje corto.
  if (pending.length === 1 && !conv.is_owner) {
    const answer = freeAnswer(business, query);
    if (answer) {
      await deliver(env, business, conv, answer);
      await markAnswered();
      await trackUsage(env, business, { free: 1 });
      return { replies: [answer] };
    }
  }

  // 2) Presupuesto mensual agotado → pasa a humano (y no gasta más).
  if (await budgetExceeded(env, business)) {
    await pause(env, conv.id, 'budget', 60);
    await markAnswered();
    return { replies: [], skipped: 'budget' };
  }

  // 3) Gemini con historial corto + resumen.
  const firstPending = pending[0].id;
  const { results: prevDesc } = await env.DB.prepare(
    'SELECT id, direction, author, text, created_at FROM messages WHERE conversation_id = ? AND id < ? AND id > ? ORDER BY id DESC LIMIT ?',
  ).bind(conv.id, firstPending, conv.summary_upto_id, HISTORY).all<Msg>();
  const history = [...prevDesc].reverse();

  const customer = conv.customer_id
    ? await env.DB.prepare('SELECT first_name, last_name, extra FROM customers WHERE id = ?').bind(conv.customer_id).first<{ first_name: string; last_name: string; extra: string }>()
    : null;
  const system = await buildSystemPrompt(env, business, {
    channel: CHANNEL_LABEL[conv.kind] ?? conv.kind, isOwner: conv.is_owner === 1, query,
    customer: customer ? { name: `${customer.first_name} ${customer.last_name}`.trim(), extra: json(customer.extra, {}) } : null,
  });

  const contents: Content[] = [];
  if (conv.summary) contents.push({ role: 'user', parts: [{ text: `[Resumen de la conversación anterior: ${conv.summary}]` }] }, { role: 'model', parts: [{ text: 'Entendido.' }] });
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'model';
    const text = m.author === 'owner' || m.author === 'staff' ? `[${m.author === 'owner' ? 'El dueño' : 'El equipo'} respondió]: ${m.text}` : m.text;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '[Inicio de la conversación]' }] });
  const userText = pending.map((m) => m.text).join('\n');
  const last = contents[contents.length - 1];
  if (last?.role === 'user') last.parts.push({ text: userText });
  else contents.push({ role: 'user', parts: [{ text: userText }] });

  const ctx: ToolContext = {
    env, business, conversationId: conv.id, customerId: conv.customer_id, isOwner: conv.is_owner === 1, origin: conv.kind === 'test' ? 'chat' : conv.kind,
  };
  const tools = declarationsFor(business, ctx.isOwner);
  let usage = { input: 0, output: 0, calls: 0 };
  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const r = await generate(env, { system, contents, tools, maxOutputTokens: 350 });
    usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output, calls: usage.calls + 1 };
    if (!r.calls.length) { reply = r.text; break; }
    contents.push(r.content); // incluye las "thought signatures" que Gemini 3 exige devolver
    const responses = [];
    for (const call of r.calls) {
      const result = await runTool(ctx, call.name, call.args);
      responses.push({ functionResponse: { name: call.name, id: call.id, response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
    if (round === MAX_TOOL_ROUNDS - 1) reply = r.text;
  }
  await trackUsage(env, business, usage);

  if (!reply) reply = ctx.handoff ? 'Te comunico con una persona del equipo, en breve te responden. 🙌' : 'Disculpa, ¿me lo puedes repetir con otras palabras?';
  await deliver(env, business, conv, reply);
  await markAnswered();
  await env.DB.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').bind(conv.id).run();
  if (ctx.handoff) await pause(env, conv.id, 'handoff');

  await maybeSummarize(env, business, conv).catch((err) => console.error('summary', (err as Error).message));
  return { replies: [reply] };
}

/** Resumen rodante: comprime lo viejo para no reenviar toda la conversación en cada llamada. */
async function maybeSummarize(env: Env, business: Business, conv: ConversationRow) {
  const { results } = await env.DB.prepare('SELECT id, direction, author, text FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .bind(conv.id, conv.summary_upto_id).all<Msg>();
  if (results.length < SUMMARIZE_AFTER) return;
  const old = results.slice(0, results.length - HISTORY);
  const transcript = old.map((m) => `${m.direction === 'in' ? 'Cliente' : m.author === 'bot' ? 'Asistente' : 'Negocio'}: ${m.text}`).join('\n');
  const r = await generate(env, {
    contents: [{ role: 'user', parts: [{ text: `Resumen previo: ${conv.summary || '(ninguno)'}\n\nNuevos mensajes:\n${transcript}\n\nEscribe un resumen actualizado en máximo 5 líneas: datos del cliente, qué quiere, qué se acordó (citas, pedidos, precios) y pendientes.` }] }],
    maxOutputTokens: 220, temperature: 0.2,
  });
  await trackUsage(env, business, { ...r.usage, calls: 1 });
  if (r.text) await env.DB.prepare('UPDATE conversations SET summary = ?, summary_upto_id = ? WHERE id = ?').bind(r.text.slice(0, 1500), old[old.length - 1].id, conv.id).run();
}
