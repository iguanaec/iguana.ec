// Cliente mínimo de Gemini (REST generateContent) con function calling.
import type { Env } from '../env';
import { ApiError } from '../lib/http';

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
  thought?: boolean;
}
export interface Content { role: 'user' | 'model'; parts: Part[] }

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface GeminiRequest {
  system?: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  maxOutputTokens?: number;
  temperature?: number;
  json?: boolean;
}

export interface GeminiResult {
  content: Content;
  text: string;
  calls: { name: string; args: Record<string, unknown>; id?: string }[];
  usage: { input: number; output: number };
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function generate(env: Env, req: GeminiRequest): Promise<GeminiResult> {
  if (!env.GEMINI_API_KEY) throw new ApiError(500, 'Falta configurar GEMINI_API_KEY.');
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.maxOutputTokens ?? 350,
    temperature: req.temperature ?? 0.4,
  };
  // Razonamiento mínimo: respuestas de chat no lo necesitan y cada token de "pensamiento" se cobra como salida.
  if (env.GEMINI_THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: env.GEMINI_THINKING_LEVEL };
  if (req.json) generationConfig.responseMimeType = 'application/json';
  const body: Record<string, unknown> = { contents: req.contents, generationConfig };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${ENDPOINT}/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  if (!res || !res.ok) {
    const detail = res ? (await res.text()).slice(0, 300) : 'sin respuesta';
    throw new ApiError(502, `Gemini respondió con error: ${detail}`);
  }
  const data = await res.json<{
    candidates?: { content?: Content; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  }>();
  const content: Content = data.candidates?.[0]?.content ?? { role: 'model', parts: [] };
  content.role = 'model';
  content.parts ||= [];
  const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  const calls = content.parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, id: p.functionCall!.id }));
  const u = data.usageMetadata ?? {};
  return { content, text, calls, usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } };
}

/** Convierte un PDF (base64) a texto una sola vez, al subirlo. */
export async function extractPdfText(env: Env, base64: string) {
  const r = await generate(env, {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: 'Extrae todo el texto útil de este documento (precios, servicios, políticas, preguntas frecuentes) como texto plano ordenado. Sin comentarios.' },
    ] }],
    maxOutputTokens: 6000, temperature: 0,
  });
  return r.text;
}

export type MediaInsight =
  | { kind: 'transcript'; text: string; usage: GeminiResult['usage'] }
  | { kind: 'receipt'; amount: number | null; bank: string; reference: string; text: string; usage: GeminiResult['usage'] }
  | { kind: 'image'; text: string; usage: GeminiResult['usage'] };

/** Notas de voz → texto; fotos → ¿es un comprobante de pago? (una sola llamada barata). */
export async function understandMedia(env: Env, type: 'audio' | 'image', mimeType: string, base64: string): Promise<MediaInsight> {
  if (type === 'audio') {
    const r = await generate(env, {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64 } }, { text: 'Transcribe literalmente este audio. Responde solo con la transcripción.' }] }],
      maxOutputTokens: 600, temperature: 0,
    });
    return { kind: 'transcript', text: r.text, usage: r.usage };
  }
  const r = await generate(env, {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64 } }, {
      text: 'Si la imagen es un comprobante de pago o transferencia responde {"receipt":true,"amount":numero_o_null,"bank":"","reference":""}. '
        + 'Si no lo es, responde {"receipt":false,"description":"qué muestra, en una frase corta en español"}.',
    }] }],
    maxOutputTokens: 200, temperature: 0, json: true,
  });
  let parsed: { receipt?: boolean; amount?: number | null; bank?: string; reference?: string; description?: string } = {};
  try { parsed = JSON.parse(r.text); } catch { /* respuesta inválida: se trata como imagen normal */ }
  if (parsed.receipt) {
    const amount = typeof parsed.amount === 'number' && parsed.amount > 0 ? parsed.amount : null;
    return {
      kind: 'receipt', amount, bank: String(parsed.bank ?? '').slice(0, 60), reference: String(parsed.reference ?? '').slice(0, 60), usage: r.usage,
      text: `[Foto de comprobante de pago${amount ? ` por $${amount.toFixed(2)}` : ''}${parsed.bank ? `, ${parsed.bank}` : ''}]`,
    };
  }
  return { kind: 'image', text: `[Foto: ${String(parsed.description || 'imagen').slice(0, 200)}]`, usage: r.usage };
}
