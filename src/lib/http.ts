import { HTTPException } from 'hono/http-exception';

export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502, message: string) {
    super(status, { message });
  }
}

export const bad = (message: string) => new ApiError(400, message);
export const notFound = (message = 'No encontrado.') => new ApiError(404, message);
export const forbidden = (message = 'No tienes permiso para esto.') => new ApiError(403, message);

export const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
export const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
/** "12.50" o 12.5 → 1250 centavos; vacío → null */
export const cents = (v: unknown) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw bad('Monto inválido.');
  return Math.round(n * 100);
};
export const money = (c: number | null | undefined) => (c == null ? null : Math.round(c) / 100);
export const json = <T = unknown>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};
