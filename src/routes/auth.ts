import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { clearRateLimit, createSession, destroySession, rateLimit, requireAuth } from '../auth';
import { getBusiness } from '../db';
import { MODES, getNiche, publicCatalog } from '../niches';
import { hashPassword, timingSafeEqual, verifyPassword } from '../lib/crypto';
import { ApiError, bad, str } from '../lib/http';
import { createBusiness, validatePassword, validateUsername } from '../provision';
import { platformSetting } from './moderator';

const auth = new Hono<AppEnv>();

/** Catálogo público de giros para el onboarding. */
auth.get('/niches', (c) => c.json(publicCatalog()));

auth.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = str(body.username, 120);
  const password = String(body.password ?? '');
  if (!username || !password) throw bad('Escribe tu usuario y contraseña.');
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const limitKey = `login:${username.toLowerCase()}:${ip}`;
  await rateLimit(c.env, limitKey, 10, 900);
  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind(username)
    .first<{ id: number; password_hash: string }>();
  // Se verifica aunque el usuario no exista para no revelar cuáles existen por el tiempo de respuesta.
  const ok = await verifyPassword(password, user?.password_hash ?? 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!user || !ok) throw new ApiError(401, 'Usuario o contraseña incorrectos.');
  await clearRateLimit(c.env, limitKey);
  await createSession(c, user.id);
  return c.json({ ok: true });
});

auth.post('/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

/** Registro público: crea el negocio en estado "onboarding" (el giro se puede elegir hasta terminarlo). */
auth.post('/auth/register', async (c) => {
  if ((await platformSetting(c.env, 'publicSignupEnabled', true)) !== true) {
    throw new ApiError(403, 'El registro está cerrado. Escríbenos para crear tu cuenta.');
  }
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  await rateLimit(c.env, `register:${ip}`, 5, 3600);
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.businessName, 120);
  if (name.length < 2) throw bad('Escribe el nombre de tu negocio.');
  const style = ['formal', 'semiformal', 'friend'].includes(body.communicationStyle) ? body.communicationStyle : 'semiformal';
  const businessId = await createBusiness(c.env, {
    name, niche: str(body.niche, 60) || 'peluqueria', username: str(body.username, 120), password: String(body.password ?? ''),
    communicationStyle: style, ownerPhone: str(body.phone, 32),
  });
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE business_id = ?').bind(businessId).first<{ id: number }>();
  await createSession(c, user!.id);
  return c.json({ ok: true, businessId });
});

auth.post('/setup', async (c) => {
  // Crea el primer super admin. Requiere BOOTSTRAP_TOKEN y solo funciona si aún no existe ninguno.
  const token = c.req.header('X-Bootstrap-Token') || '';
  const expected = c.env.BOOTSTRAP_TOKEN || '';
  const enc = new TextEncoder();
  if (!expected || !timingSafeEqual(enc.encode(token), enc.encode(expected))) throw new ApiError(403, 'Token inválido.');
  const existing = await c.env.DB.prepare("SELECT 1 FROM users WHERE role = 'super_admin'").first();
  if (existing) throw new ApiError(409, 'Ya existe un super administrador.');
  const body = await c.req.json().catch(() => ({}));
  const username = str(body.username, 120);
  const password = String(body.password ?? '');
  validateUsername(username);
  validatePassword(password);
  await c.env.DB.prepare(
    "INSERT INTO users (business_id, username, password_hash, role, created_at) VALUES (NULL, ?, ?, 'super_admin', ?)",
  ).bind(username, await hashPassword(password), Date.now()).run();
  return c.json({ ok: true });
});

auth.use('/auth/me', requireAuth);
auth.get('/auth/me', async (c) => {
  const user = c.get('user');
  const base = { id: user.id, username: user.username, role: user.role, mustChangePassword: user.must_change_password === 1 };
  if (user.role === 'super_admin' || !user.business_id) return c.json({ user: base });
  const business = await getBusiness(c.env, user.business_id);
  if (!business) throw new ApiError(404, 'Negocio no encontrado.');
  const niche = getNiche(business.niche);
  const mode = MODES[business.mode];
  return c.json({
    user: { ...base, companyName: business.name },
    business: {
      id: business.id,
      name: business.name,
      status: business.status,
      niche: business.niche,
      nicheLabel: niche?.label ?? business.niche,
      mode: business.mode,
      modeLabel: mode.label,
      locked: business.locked,
      onboarding: business.status === 'onboarding',
      // El personal no ve dinero ni ajustes.
      modules: user.role === 'staff' ? business.modules.filter((m) => !['dinero', 'ajustes', 'asistente'].includes(m)) : business.modules,
      vocabulary: mode.vocabulary,
      customerFields: niche?.customerFields ?? [],
    },
  });
});

auth.use('/auth/change-password', requireAuth);
auth.post('/auth/change-password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password ?? '');
  if (body.confirmation != null && body.confirmation !== password) throw bad('Las contraseñas no coinciden.');
  validatePassword(password);
  const user = c.get('user');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').bind(await hashPassword(password), user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  await createSession(c, user.id);
  return c.json({ ok: true });
});

export default auth;
