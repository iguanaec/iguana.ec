import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { api, env, mockGemini, openAllWeek, registerBusiness } from './helpers';
import { parseWebhook } from '../src/channels/meta';
import { processInbound } from '../src/channels/inbound';
import { notifyConversation } from '../src/conversation-do';
import { hmacSha256Hex } from '../src/lib/crypto';
import { runCron } from '../src/jobs/cron';

let mock: ReturnType<typeof mockGemini> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

let phoneSeq = 1000;
async function connectWhatsApp(token: string) {
  const phoneId = `PHONE${phoneSeq++}`;
  // La ventana de Meta devuelve code + waba_id + phone_number_id; el resto lo hace el servidor.
  const meta = mockGemini([]);
  const r = await api('/api/channels/whatsapp/embedded-signup', { body: { code: 'CODE', waba_id: 'WABA1', phone_number_id: phoneId }, token });
  meta.restore();
  return { r, phoneId, calls: meta.meta() };
}

const waText = (phoneId: string, from: string, id: string, text: string, name = 'Lucía Pérez') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId, display_phone_number: '593900000000' },
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }],
});

describe('WhatsApp con coexistencia', () => {
  it('Embedded Signup: canjea el código, suscribe la cuenta y sincroniza la app (coexistencia)', async () => {
    const { token } = await registerBusiness('peluqueria');
    const { r, calls } = await connectWhatsApp(token);
    expect(r.status).toBe(200);
    expect(r.data.channel.coexistence).toBe(true);
    const urls = calls.map((c) => c.meta as string);
    expect(urls.some((u) => u.includes('oauth/access_token'))).toBe(true);
    expect(urls.some((u) => u.includes('WABA1/subscribed_apps'))).toBe(true);
    expect(urls.filter((u) => u.includes('smb_app_data'))).toHaveLength(2);
    expect(urls.some((u) => u.includes('/register'))).toBe(false); // no se re-registra el número
    const list = await api('/api/channels', { token });
    expect(list.data.channels[0]).toMatchObject({ kind: 'whatsapp', coexistence: 1 });
    expect(JSON.stringify(list.data)).not.toContain('token_enc');
    const row = await env.DB.prepare('SELECT token_enc FROM channels ORDER BY id DESC LIMIT 1').first<{ token_enc: string }>();
    expect(row!.token_enc).not.toContain('messages'); // cifrado, no el token plano
  });

  it('webhook: rechaza firmas inválidas y acepta las válidas', async () => {
    const body = JSON.stringify(waText('PHONEX', '593911111111', 'wamid.sig', 'hola'));
    const bad = await fetchWebhook(body, 'sha256=deadbeef');
    expect(bad.status).toBe(401);
    const good = await fetchWebhook(body, `sha256=${await hmacSha256Hex('app-secret', body)}`);
    expect(good.status).toBe(200);
    const verify = await api('/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
    expect(verify.data).toBe(42);
  });

  it('mensaje entrante → cliente + conversación; el eco del dueño pausa al bot', async () => {
    const { token, businessId } = await registerBusiness('barberia');
    const { phoneId } = await connectWhatsApp(token);
    const [ev] = parseWebhook(env, waText(phoneId, '593922222222', 'wamid.A1', '¿Tienen turno hoy?'));
    const target = await processInbound(env, ev);
    expect(target?.businessId).toBe(businessId);
    // Duplicado (Meta reintenta) → se ignora.
    expect(await processInbound(env, ev)).toBeNull();
    const customers = (await api('/api/customers', { token })).data;
    expect(customers[0]).toMatchObject({ first_name: 'Lucía', phone: '593922222222' });

    // El dueño contesta desde la app WhatsApp Business de su celular (smb_message_echoes).
    const echo = parseWebhook(env, {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'smb_message_echoes', value: {
        metadata: { phone_number_id: phoneId },
        message_echoes: [{ from: '593900000000', to: '593922222222', id: 'wamid.E1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Sí, a las 4' } }],
      } }] }],
    });
    expect(echo[0].echo).toBe(true);
    await processInbound(env, echo[0]);
    const inbox = (await api('/api/conversations', { token })).data;
    expect(inbox[0].bot_active).toBe(false);
    expect(inbox[0].pause_reason).toBe('owner_reply');

    // Con el bot pausado, el siguiente mensaje no llama a Gemini.
    mock = mockGemini([{ text: 'no' }]);
    const t2 = await processInbound(env, parseWebhook(env, waText(phoneId, '593922222222', 'wamid.A2', 'perfecto'))[0]);
    const { runConversation } = await import('../src/agent/run');
    const res = await runConversation(env, t2!.businessId, t2!.conversationId);
    expect(res.skipped).toBe('owner_reply');
    expect(mock.gemini()).toHaveLength(0);
  });

  it('ráfaga de mensajes = una sola llamada a Gemini y una sola respuesta por WhatsApp', async () => {
    const { token } = await registerBusiness('unas');
    const { phoneId } = await connectWhatsApp(token);
    let target: { businessId: number; conversationId: number } | null = null;
    for (const [i, text] of ['hola', 'quiero uñas', 'en gel', 'para el sábado', '¿precio?'].entries()) {
      target = await processInbound(env, parseWebhook(env, waText(phoneId, '593933333333', `wamid.B${i}`, text))[0]);
      await notifyConversation(env, target!.businessId, target!.conversationId);
    }
    mock = mockGemini([{ text: 'Uñas en gel $15. ¿A qué hora el sábado?' }]);
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${target!.businessId}:${target!.conversationId}`));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(mock.gemini()).toHaveLength(1);
    const userTurn = mock.gemini()[0].contents.at(-1).parts.map((p: { text: string }) => p.text).join(' ');
    expect(userTurn).toContain('¿precio?');
    expect(userTurn).toContain('hola');
    const sent = mock.meta().filter((m) => String(m.meta).includes(`${phoneId}/messages`));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).text.body).toContain('$15');
    await runInDurableObject(stub, async (_i, state) => expect(await state.storage.get('firstAt')).toBeUndefined());
  });

  it('nota de voz se transcribe y un comprobante queda pendiente de aprobación', async () => {
    const { token } = await registerBusiness('peluqueria');
    await openAllWeek(token);
    const { phoneId } = await connectWhatsApp(token);
    const audio = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: '593944444444', profile: { name: 'Pedro' } }],
        messages: [
          { from: '593944444444', id: 'wamid.V1', timestamp: '1700000000', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg' } },
          { from: '593944444444', id: 'wamid.I1', timestamp: '1700000001', type: 'image', image: { id: 'MEDIA2', mime_type: 'image/jpeg' } },
        ],
      } }] }],
    };
    const evs = parseWebhook(env, audio);
    mock = mockGemini([
      { text: 'Quiero un corte para mañana' },
      { text: '{"receipt":true,"amount":8,"bank":"Pichincha","reference":"12345"}' },
    ]);
    // La descarga del medio devuelve URL y luego bytes.
    const t = await processInbound(env, evs[0]);
    await processInbound(env, evs[1]);
    const msgs = (await api(`/api/conversations/${t!.conversationId}/messages`, { token })).data.messages;
    expect(msgs[0].text).toBe('[Nota de voz] Quiero un corte para mañana');
    expect(msgs[1].text).toContain('comprobante de pago por $8.00');
    const proofs = (await api('/api/payment-proofs', { token })).data;
    expect(proofs[0]).toMatchObject({ amount: 8, bank: 'Pichincha', status: 'pending' });
    expect((await api(`/api/payment-proofs/${proofs[0].id}/approve`, { body: {}, token })).status).toBe(200);
    expect((await api('/api/payment-proofs', { token })).data).toHaveLength(0);
  });
});

describe('trabajos automáticos', () => {
  it('cupo liberado → se ofrece al primero de la lista de espera', async () => {
    const { token } = await registerBusiness('peluqueria');
    await openAllWeek(token);
    const { phoneId } = await connectWhatsApp(token);
    const svc = (await api('/api/services', { token })).data[0];
    // Cliente que escribió hoy (ventana de 24 h abierta) y quedó en lista de espera.
    const t = await processInbound(env, parseWebhook(env, waText(phoneId, '593955555555', 'wamid.W1', 'avísame si hay cupo'))[0]);
    const conv = await env.DB.prepare('SELECT customer_id FROM conversations WHERE id = ?').bind(t!.conversationId).first<{ customer_id: number }>();
    await env.DB.prepare('INSERT INTO waitlist (business_id, customer_id, service_id, created_at) VALUES (?, ?, ?, ?)').bind(t!.businessId, conv!.customer_id, svc.id, Date.now()).run();
    const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const slot = (await api(`/api/appointments/availability?service_id=${svc.id}&date=${day}`, { token })).data.slots[4];
    const appt = await api('/api/appointments', { body: { customer_name: 'Quien Cancela', service_id: svc.id, start_at: slot }, token });
    await api(`/api/appointments/${appt.data.id}/cancel`, { method: 'POST', token });
    mock = mockGemini([]);
    await runCron(env, '*/15 * * * *');
    const sent = mock.meta().filter((m) => String(m.body ?? '').includes('Se liberó un cupo'));
    expect(sent).toHaveLength(1);
    const w = await env.DB.prepare('SELECT status, notified FROM waitlist WHERE customer_id = ?').bind(conv!.customer_id).first();
    expect(w).toMatchObject({ status: 'offered', notified: 1 });
  });

  it('reactivación: lista clientes que ya deberían volver con link de WhatsApp listo', async () => {
    const { token, businessId } = await registerBusiness('peluqueria_canina');
    const svc = (await api('/api/services', { token })).data.find((s: { name: string }) => s.name === 'Baño');
    const c = (await api('/api/customers', { body: { first_name: 'Rosa', phone: '593966666666', extra: { mascota: 'Firulais' } }, token })).data;
    const past = Date.now() - 40 * 86400_000;
    await env.DB.prepare("INSERT INTO appointments (business_id, customer_id, service_id, start_ts, end_ts, status, created_at) VALUES (?, ?, ?, ?, ?, 'completed', ?)")
      .bind(businessId, c.id, svc.id, past, past + 3600_000, past).run();
    const list = (await api('/api/reactivation', { token })).data;
    expect(list).toHaveLength(1);
    expect(list[0].message).toContain('Firulais');
    expect(list[0].whatsapp_link).toMatch(/^https:\/\/wa\.me\/593966666666\?text=/);
    await api(`/api/reactivation/${c.id}/done`, { method: 'POST', token });
    expect((await api('/api/reactivation', { token })).data).toHaveLength(0);
  });
});

async function fetchWebhook(body: string, signature: string) {
  const { SELF } = await import('cloudflare:test');
  return SELF.fetch('https://api.test/webhooks/meta', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature } });
}

describe('modo dueño', () => {
  it('quitar el número del dueño le quita las herramientas de dueño a ese chat', async () => {
    const { token } = await registerBusiness('peluqueria');
    const { phoneId } = await connectWhatsApp(token);
    await api('/api/agent/config', { method: 'PUT', body: { ownerPhones: ['593977777777'] }, token });
    const t = await processInbound(env, parseWebhook(env, waText(phoneId, '593977777777', 'wamid.O1', 'resumen de hoy'))[0]);
    let row = await env.DB.prepare('SELECT is_owner FROM conversations WHERE id = ?').bind(t!.conversationId).first<{ is_owner: number }>();
    expect(row?.is_owner).toBe(1);
    await api('/api/agent/config', { method: 'PUT', body: { ownerPhones: [] }, token });
    await processInbound(env, parseWebhook(env, waText(phoneId, '593977777777', 'wamid.O2', 'otra vez'))[0]);
    row = await env.DB.prepare('SELECT is_owner FROM conversations WHERE id = ?').bind(t!.conversationId).first<{ is_owner: number }>();
    expect(row?.is_owner).toBe(0);
  });
});
