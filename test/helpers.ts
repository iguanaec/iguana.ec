import { SELF, env as testEnv } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Env } from '../src/env';

export const env = testEnv as unknown as Env;

export async function api(path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await SELF.fetch(`https://api.test${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: res.headers.get('Set-Cookie') ?? '' };
}

export const tokenFrom = (cookie: string) => /ig_session=([^;]+)/.exec(cookie)?.[1] ?? '';

let seq = 0;
export async function registerBusiness(niche: string, extra: Record<string, unknown> = {}) {
  const username = `user${Date.now()}${seq++}`;
  const r = await api('/api/auth/register', {
    body: { businessName: `Negocio ${niche}`, username, password: 'clave-segura-1', niche, ...extra },
    headers: { 'CF-Connecting-IP': `10.0.0.${seq}` },
  });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  return { token: tokenFrom(r.cookie), businessId: r.data.businessId as number, username };
}

/** Abre todos los días de 08:00 a 20:00 para que las pruebas no dependan del día en que corren. */
export async function openAllWeek(token: string) {
  const s = (await api('/api/settings', { token })).data;
  s.businessHours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: true, start: '08:00', end: '20:00' }));
  s.minimumBookingNoticeMinutes = 0;
  return api('/api/settings', { method: 'PUT', body: s, token });
}

type StaticReply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };
type GeminiReply = StaticReply | ((body: any) => StaticReply);

/** Simula Gemini: devuelve las respuestas en orden y registra cada petición. */
export function mockGemini(replies: GeminiReply[]) {
  const requests: any[] = [];
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      requests.push(body);
      const n = requests.filter((r) => !r.meta).length;
      const entry = replies[Math.min(n - 1, replies.length - 1)] ?? { text: '' };
      const reply: StaticReply = typeof entry === 'function' ? entry(body) : entry;
      const parts = [
        ...(reply.text ? [{ text: reply.text }] : []),
        ...(reply.calls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args }, thoughtSignature: 'sig' })),
      ];
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } }));
    }
    if (/graph\.facebook\.com\/v[\d.]+\/MEDIA\d+$/.test(url)) {
      requests.push({ meta: url });
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/media/1', mime_type: 'audio/ogg' }));
    }
    if (url.includes('lookaside.fbsbx.com')) return new Response(new Uint8Array([1, 2, 3, 4]));
    if (url.includes('graph.facebook.com')) {
      requests.push({ meta: url, body: init?.body });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${requests.length}` }], success: true }));
    }
    return original(input as RequestInfo, init);
  });
  return { requests, gemini: () => requests.filter((r) => !r.meta), meta: () => requests.filter((r) => r.meta), restore: () => spy.mockRestore() };
}
