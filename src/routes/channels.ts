// Conexión de canales con UN botón: Embedded Signup (WhatsApp, incluida coexistencia) y Facebook Login (IG + Messenger).
// El cliente nunca copia tokens ni entra a su Business Manager.
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { requireAuth, requireBusiness, requireRole } from '../auth';
import { graph, parseWebhook, verifySignature } from '../channels/meta';
import { encrypt } from '../lib/crypto';
import { ApiError, bad, int, str } from '../lib/http';

export const channels = new Hono<AppEnv>();
channels.use('*', requireAuth, requireBusiness);

channels.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, kind, external_id, display_name, coexistence, status, created_at FROM channels WHERE business_id = ? ORDER BY id',
  ).bind(c.get('businessId')).all();
  return c.json({
    channels: results,
    // Datos públicos para lanzar el SDK de Facebook desde el panel.
    meta: { appId: c.env.META_APP_ID ?? '', waConfigId: c.env.META_WA_CONFIG_ID ?? '', pagesConfigId: c.env.META_PAGES_CONFIG_ID ?? '', graphVersion: c.env.META_GRAPH_VERSION },
  });
});

async function metaFetch<T>(env: Env, path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(graph(env, path), { ...init, headers });
  const data = await res.json<T & { error?: { message?: string } }>().catch(() => ({}) as T & { error?: { message?: string } });
  if (!res.ok) throw new ApiError(502, `Meta: ${data.error?.message ?? res.status}`);
  return data;
}

async function exchangeCode(env: Env, code: string) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new ApiError(500, 'Falta configurar la app de Meta (META_APP_ID / META_APP_SECRET).');
  const q = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code });
  const data = await metaFetch<{ access_token: string }>(env, `oauth/access_token?${q}`);
  return data.access_token;
}

async function upsertChannel(env: Env, businessId: number, ch: {
  kind: string; externalId: string; pageId?: string | null; wabaId?: string | null; name: string; token: string; coexistence?: boolean;
}) {
  if (!env.ENCRYPTION_KEY) throw new ApiError(500, 'Falta configurar ENCRYPTION_KEY.');
  const taken = await env.DB.prepare("SELECT business_id FROM channels WHERE kind = ? AND external_id = ? AND status = 'active'").bind(ch.kind, ch.externalId).first<{ business_id: number }>();
  if (taken && taken.business_id !== businessId) throw bad('Esta cuenta ya está conectada a otro negocio en Iguana.');
  await env.DB.prepare(
    `INSERT INTO channels (business_id, kind, external_id, page_id, waba_id, display_name, token_enc, coexistence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(kind, external_id) DO UPDATE SET business_id = excluded.business_id, page_id = excluded.page_id, waba_id = excluded.waba_id,
       display_name = excluded.display_name, token_enc = excluded.token_enc, coexistence = excluded.coexistence, status = 'active'`,
  ).bind(businessId, ch.kind, ch.externalId, ch.pageId ?? null, ch.wabaId ?? null, ch.name, await encrypt(env.ENCRYPTION_KEY, ch.token), ch.coexistence ? 1 : 0, Date.now()).run();
}

/**
 * Paso final del Embedded Signup de WhatsApp. El panel envía el `code` y los ids que devuelve la ventana de Meta.
 * Coexistencia (por defecto): el número sigue funcionando en la app WhatsApp Business del celular.
 */
channels.post('/whatsapp/embedded-signup', requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = str(body.code, 2000);
  const wabaId = str(body.waba_id, 40);
  const phoneId = str(body.phone_number_id, 40);
  if (!code || !wabaId || !phoneId) throw bad('Faltan datos de Meta. Vuelve a intentar la conexión.');
  const coexistence = body.coexistence !== false;
  const token = await exchangeCode(c.env, code);

  // Recibir webhooks de esta cuenta en nuestra app.
  await metaFetch(c.env, `${wabaId}/subscribed_apps`, { method: 'POST', token });
  const phone = await metaFetch<{ display_phone_number?: string; verified_name?: string }>(c.env, `${phoneId}?fields=display_phone_number,verified_name`, { token });

  if (coexistence) {
    // Sincroniza contactos e historial de la app (Meta lo exige en las primeras 24 h).
    for (const sync_type of ['smb_app_state_sync', 'history']) {
      await metaFetch(c.env, `${phoneId}/smb_app_data`, { method: 'POST', token, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type }) })
        .catch((err) => console.error('smb_app_data', sync_type, (err as Error).message));
    }
  } else {
    // Número nuevo (solo API): se registra con un PIN de verificación en dos pasos generado aquí.
    const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    await metaFetch(c.env, `${phoneId}/register`, { method: 'POST', token, body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
  }

  const name = [phone.verified_name, phone.display_phone_number].filter(Boolean).join(' · ') || 'WhatsApp';
  await upsertChannel(c.env, c.get('businessId'), { kind: 'whatsapp', externalId: phoneId, wabaId, name, token, coexistence });
  return c.json({ ok: true, channel: { kind: 'whatsapp', display_name: name, coexistence } });
});

/** Facebook Login for Business: conecta la página (Messenger) y su Instagram profesional vinculado. */
channels.post('/pages/connect', requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = str(body.code, 2000);
  if (!code) throw bad('Falta el código de Meta.');
  const shortToken = await exchangeCode(c.env, code);
  const q = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: c.env.META_APP_ID!, client_secret: c.env.META_APP_SECRET!, fb_exchange_token: shortToken });
  const { access_token: userToken } = await metaFetch<{ access_token: string }>(c.env, `oauth/access_token?${q}`);
  const pages = await metaFetch<{ data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    c.env, 'me/accounts?fields=id,name,access_token,instagram_business_account{id,username}', { token: userToken },
  );
  const wanted = str(body.page_id, 40);
  const selected = pages.data.filter((p) => !wanted || p.id === wanted);
  if (!selected.length) throw bad('No encontramos páginas de Facebook con permiso. Revisa que seas administrador de la página.');
  const connected: { kind: string; display_name: string }[] = [];
  for (const page of selected.slice(0, 5)) {
    await metaFetch(c.env, `${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes`, { method: 'POST', token: page.access_token });
    await upsertChannel(c.env, c.get('businessId'), { kind: 'messenger', externalId: page.id, pageId: page.id, name: page.name, token: page.access_token });
    connected.push({ kind: 'messenger', display_name: page.name });
    if (page.instagram_business_account) {
      const ig = page.instagram_business_account;
      await upsertChannel(c.env, c.get('businessId'), { kind: 'instagram', externalId: ig.id, pageId: page.id, name: ig.username ? `@${ig.username}` : page.name, token: page.access_token });
      connected.push({ kind: 'instagram', display_name: ig.username ? `@${ig.username}` : page.name });
    }
  }
  return c.json({ ok: true, connected });
});

channels.delete('/:id', requireRole('admin'), async (c) => {
  await c.env.DB.prepare("UPDATE channels SET status = 'disconnected' WHERE id = ? AND business_id = ?").bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Webhook único de Meta (WhatsApp, Instagram, Messenger) ---------- */

export const webhooks = new Hono<AppEnv>();

webhooks.get('/meta', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  if (mode === 'subscribe' && token && c.env.META_VERIFY_TOKEN && token === c.env.META_VERIFY_TOKEN) return c.text(c.req.query('hub.challenge') ?? '');
  return c.text('Forbidden', 403);
});

webhooks.post('/meta', async (c) => {
  const raw = await c.req.arrayBuffer();
  if (!(await verifySignature(c.env, raw, c.req.header('X-Hub-Signature-256')))) return c.text('Invalid signature', 401);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.text('Bad JSON', 400); }
  const events = parseWebhook(c.env, payload);
  // Responder rápido a Meta: el trabajo pesado va a la cola.
  for (let i = 0; i < events.length; i += 100) {
    await c.env.INBOUND.sendBatch(events.slice(i, i + 100).map((body) => ({ body })));
  }
  return c.text('EVENT_RECEIVED');
});
