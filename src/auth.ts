import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Env, Role, SessionUser } from './env';
import { getBusiness } from './db';
import type { Module } from './niches/types';
import { randomToken, sha256Hex } from './lib/crypto';
import { ApiError, forbidden } from './lib/http';

export const SESSION_COOKIE = 'ig_session';
const SESSION_DAYS = 30;

export async function createSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, expires).run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: SESSION_DAYS * 86400,
  });
  return token;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = readToken(c);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'None' });
}

function readToken(c: Context<AppEnv>) {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return getCookie(c, SESSION_COOKIE) || null;
}

export async function sessionUser(env: Env, token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.business_id, u.must_change_password, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  ).bind(await sha256Hex(token)).first<SessionUser & { expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  const { expires_at: _, ...user } = row;
  return user;
}

/** Exige sesión. Los usuarios con contraseña temporal solo pueden cambiarla. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c.env, readToken(c));
  if (!user) throw new ApiError(401, 'No autenticado');
  const path = new URL(c.req.url).pathname;
  if (user.must_change_password && !['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'].includes(path)) {
    throw forbidden('Debes cambiar tu contraseña antes de continuar.');
  }
  c.set('user', user);
  await next();
};

/**
 * Fija el negocio de la petición. El super admin puede actuar sobre cualquier negocio con
 * el encabezado X-Business-Id (soporte); los demás, solo sobre el suyo.
 */
export const requireBusiness: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  let businessId = user.business_id;
  if (user.role === 'super_admin') {
    const header = Number(c.req.header('X-Business-Id'));
    if (header > 0) businessId = header;
  }
  if (!businessId) throw forbidden('Esta cuenta no tiene un negocio asociado.');
  c.set('businessId', businessId);
  await next();
};

export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const role = c.get('user').role;
  if (role !== 'super_admin' && !roles.includes(role)) throw forbidden();
  await next();
};

/** La sección debe estar habilitada para el giro del negocio. */
export const requireModule = (...modules: Module[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const business = await getBusiness(c.env, c.get('businessId'));
  if (!business) throw new ApiError(404, 'Negocio no encontrado.');
  if (business.status === 'suspended' && c.get('user').role !== 'super_admin') throw forbidden('El negocio está suspendido.');
  if (!modules.some((m) => business.modules.includes(m))) throw forbidden('Esta sección no está disponible para tu tipo de negocio.');
  await next();
};

/** Límite simple de intentos (login) con KV. */
export async function rateLimit(env: Env, key: string, max: number, windowSeconds: number) {
  const k = `rl:${key}`;
  const count = Number((await env.CACHE.get(k)) || 0);
  if (count >= max) throw new ApiError(429, 'Demasiados intentos. Espera unos minutos.');
  await env.CACHE.put(k, String(count + 1), { expirationTtl: windowSeconds });
}

export async function clearRateLimit(env: Env, key: string) {
  await env.CACHE.delete(`rl:${key}`);
}
