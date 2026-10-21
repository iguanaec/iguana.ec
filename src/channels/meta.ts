// WhatsApp Cloud API (incluida coexistencia), Instagram y Messenger: firma, parseo, envío y medios.
import type { Env } from '../env';
import { decrypt, hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { ChannelRow, InboundEvent } from './types';

export const graph = (env: Env, path: string) => `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path.replace(/^\//, '')}`;

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret). */
export async function verifySignature(env: Env, raw: ArrayBuffer, header: string | undefined) {
  if (!env.META_APP_SECRET || !header?.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(env.META_APP_SECRET, raw);
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(expected), enc.encode(header.slice(7)));
}

const mediaTypes = ['audio', 'image', 'document', 'video', 'sticker'] as const;
type MediaType = (typeof mediaTypes)[number];

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Convierte el webhook de Meta en eventos normalizados. Ignora estados (entregado/leído) y lo que no es mensaje. */
export function parseWebhook(env: Env, payload: any): InboundEvent[] {
  const events: InboundEvent[] = [];
  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        const phoneId = v.metadata?.phone_number_id;
        if (!phoneId) continue;
        if (change.field === 'messages') {
          const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? '']));
          for (const m of v.messages ?? []) events.push(waMessage(phoneId, m, m.from, names.get(m.from), false));
        } else if (change.field === 'smb_message_echoes') {
          // Coexistencia: el dueño respondió desde la app WhatsApp Business de su celular.
          for (const m of v.message_echoes ?? []) events.push(waMessage(phoneId, m, m.to, undefined, true));
        }
      }
    }
  } else if (payload?.object === 'page' || payload?.object === 'instagram') {
    const kind = payload.object === 'page' ? 'messenger' : 'instagram';
    for (const entry of payload.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const msg = ev.message;
        if (!msg || msg.is_deleted) continue;
        const echo = msg.is_echo === true;
        // Ecos de nuestros propios envíos por API: no son del dueño, se ignoran.
        if (echo && env.META_APP_ID && String(msg.app_id ?? '') === env.META_APP_ID) continue;
        const attachment = msg.attachments?.[0];
        const type = mediaTypes.includes(attachment?.type) ? attachment.type as MediaType : attachment?.type === 'file' ? 'document' : undefined;
        events.push({
          kind, channelExternalId: String(entry.id), contactRef: String(echo ? ev.recipient?.id : ev.sender?.id),
          externalId: String(msg.mid), ts: Number(ev.timestamp) || Date.now(), text: msg.text, echo,
          media: type ? { type, url: attachment.payload?.url } : undefined,
        });
      }
    }
  }
  return events.filter((e) => e.contactRef && e.externalId && (e.text || e.media));
}

function waMessage(phoneId: string, m: any, contact: string, name: string | undefined, echo: boolean): InboundEvent {
  const type = m.type as string;
  let text: string | undefined;
  if (type === 'text') text = m.text?.body;
  else if (type === 'button') text = m.button?.text;
  else if (type === 'interactive') text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
  else if (type === 'location') text = `[Ubicación: ${m.location?.name ?? ''} ${m.location?.address ?? ''} (${m.location?.latitude}, ${m.location?.longitude})]`.replace(/\s+/g, ' ');
  else if (type === 'reaction') text = undefined;
  else if (type === 'contacts') text = '[Contacto compartido]';
  const media = mediaTypes.includes(type as MediaType) ? { type: type as MediaType, id: m[type]?.id, mime: m[type]?.mime_type } : undefined;
  if (media && m[type]?.caption) text = m[type].caption;
  return {
    kind: 'whatsapp', channelExternalId: phoneId, contactRef: String(contact), contactName: name, externalId: String(m.id),
    ts: Number(m.timestamp) * 1000 || Date.now(), text, media, echo,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function channelToken(env: Env, channel: ChannelRow) {
  if (!env.ENCRYPTION_KEY) throw new Error('Falta ENCRYPTION_KEY.');
  return decrypt(env.ENCRYPTION_KEY, channel.token_enc);
}

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** Descarga un audio/imagen entrante. WhatsApp entrega un id; IG/Messenger una URL. */
export async function downloadMedia(env: Env, channel: ChannelRow, media: NonNullable<InboundEvent['media']>) {
  let url = media.url;
  let mime = media.mime;
  const token = await channelToken(env, channel);
  const headers: Record<string, string> = {};
  if (media.id) {
    const meta = await fetch(graph(env, media.id), { headers: { Authorization: `Bearer ${token}` } });
    if (!meta.ok) throw new Error(`No se pudo obtener el medio (${meta.status}).`);
    const info = await meta.json<{ url: string; mime_type: string; file_size?: number }>();
    if (info.file_size && info.file_size > MAX_MEDIA_BYTES) throw new Error('Archivo demasiado grande.');
    url = info.url;
    mime = info.mime_type;
    headers.Authorization = `Bearer ${token}`;
  }
  if (!url) throw new Error('Medio sin URL.');
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`No se pudo descargar el medio (${res.status}).`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_MEDIA_BYTES) throw new Error('Archivo demasiado grande.');
  return { mime: (mime || res.headers.get('Content-Type') || 'application/octet-stream').split(';')[0], bytes: buf };
}

/** Parte textos largos respetando párrafos (Messenger/IG aceptan ~1000-2000 caracteres). */
function chunks(text: string, max: number) {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n', max), rest.lastIndexOf('. ', max));
    const at = cut > max / 2 ? cut + 1 : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendText(env: Env, channel: ChannelRow, to: string, text: string) {
  const token = await channelToken(env, channel);
  const ids: string[] = [];
  for (const part of chunks(text, channel.kind === 'whatsapp' ? 3800 : 950)) {
    const isWa = channel.kind === 'whatsapp';
    const res = await fetch(graph(env, isWa ? `${channel.external_id}/messages` : `${channel.page_id || channel.external_id}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(isWa
        ? { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: part, preview_url: true } }
        : { recipient: { id: to }, messaging_type: 'RESPONSE', message: { text: part } }),
    });
    if (!res.ok) throw new Error(`Meta rechazó el envío (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json<{ messages?: { id: string }[]; message_id?: string }>();
    ids.push(data.messages?.[0]?.id ?? data.message_id ?? '');
  }
  return ids;
}

/** Plantilla aprobada de WhatsApp (para escribir fuera de la ventana de 24 h). */
export async function sendTemplate(env: Env, channel: ChannelRow, to: string, name: string, params: string[], lang = 'es') {
  if (channel.kind !== 'whatsapp') throw new Error('Las plantillas solo existen en WhatsApp.');
  const token = await channelToken(env, channel);
  const res = await fetch(graph(env, `${channel.external_id}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [] },
    }),
  });
  if (!res.ok) throw new Error(`Meta rechazó la plantilla (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json<{ messages?: { id: string }[] }>();
  return data.messages?.[0]?.id ?? '';
}

/** Marca como leído en WhatsApp (los dos checks azules) — da sensación de atención inmediata. */
export async function markRead(env: Env, channel: ChannelRow, messageId: string) {
  if (channel.kind !== 'whatsapp') return;
  const token = await channelToken(env, channel);
  await fetch(graph(env, `${channel.external_id}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => undefined);
}
