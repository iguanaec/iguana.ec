import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { requireAuth, requireRole } from '../auth';
import { getBusiness, invalidateBusiness } from '../db';
import { bad, int, json, notFound, str } from '../lib/http';
import { changeNiche, createBusiness } from '../provision';
import { randomToken } from '../lib/crypto';

const SETTINGS_DEFAULTS: Record<string, unknown> = { onboardingEnabled: true, firstStepsEnabled: true, publicSignupEnabled: true };

export async function platformSetting<T = unknown>(env: Env, key: string, fallback?: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? json<T>(row.value, (fallback ?? SETTINGS_DEFAULTS[key]) as T) : ((fallback ?? SETTINGS_DEFAULTS[key]) as T);
}

const sqlDate = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');

/** Panel del super administrador (Iguana): empresas, giros, presupuestos de IA. */
const moderator = new Hono<AppEnv>();
moderator.use('*', requireAuth, requireRole('super_admin'));

moderator.get('/companies', async (c) => {
  const month = new Date().toISOString().slice(0, 7);
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.niche, b.mode, b.status, b.locked, b.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.business_id = b.id AND u.role = 'admin') AS admin_count,
            (SELECT username FROM users u WHERE u.business_id = b.id AND u.role = 'admin' ORDER BY id LIMIT 1) AS owner_username,
            (SELECT phone FROM users u WHERE u.business_id = b.id AND u.role = 'admin' ORDER BY id LIMIT 1) AS owner_phone,
            (SELECT GROUP_CONCAT(kind) FROM channels ch WHERE ch.business_id = b.id AND ch.status = 'active') AS channels,
            (SELECT COALESCE(SUM(cost_micros), 0) FROM ai_usage a WHERE a.business_id = b.id AND a.day LIKE ?1) AS ai_cost_micros,
            (SELECT COALESCE(SUM(calls), 0) FROM ai_usage a WHERE a.business_id = b.id AND a.day LIKE ?1) AS ai_calls
       FROM businesses b ORDER BY b.created_at DESC`,
  ).bind(`${month}%`).all<Record<string, unknown> & { created_at: number }>();
  return c.json({
    companies: results.map((r) => ({
      ...r, created_at: sqlDate(r.created_at), locked: r.locked === 1, channels: r.channels ? String(r.channels).split(',') : [],
      ai_cost_usd: Number(r.ai_cost_micros) / 1e6,
    })),
  });
});

/** Alta asistida: Iguana crea el negocio con el giro ya elegido y una contraseña temporal. */
moderator.post('/companies', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tempPassword = str(body.password, 200) || `Ig-${randomToken(6)}`;
  const id = await createBusiness(c.env, {
    name: str(body.name, 120), niche: str(body.niche, 60), username: str(body.username, 120), password: tempPassword,
    ownerPhone: str(body.phone, 32), mustChangePassword: true,
  });
  // Creado por Iguana: el onboarding de giro ya está hecho, queda bloqueado.
  await c.env.DB.prepare("UPDATE businesses SET locked = 1, status = 'active' WHERE id = ?").bind(id).run();
  return c.json({ ok: true, id, temporaryPassword: tempPassword });
});

moderator.put('/companies/:id', async (c) => {
  const id = int(c.req.param('id'))!;
  const business = await getBusiness(c.env, id);
  if (!business) throw notFound('Empresa no encontrada.');
  const body = await c.req.json().catch(() => ({}));
  if (body.niche && body.niche !== business.niche) await changeNiche(c.env, id, str(body.niche, 60));
  if (body.status) {
    if (!['active', 'suspended', 'onboarding'].includes(body.status)) throw bad('Estado inválido.');
    await c.env.DB.prepare('UPDATE businesses SET status = ? WHERE id = ?').bind(body.status, id).run();
  }
  if (typeof body.locked === 'boolean') {
    await c.env.DB.prepare('UPDATE businesses SET locked = ? WHERE id = ?').bind(body.locked ? 1 : 0, id).run();
  }
  if (typeof body.aiEnabled === 'boolean') {
    await c.env.DB.prepare('UPDATE businesses SET ai_enabled = ? WHERE id = ?').bind(body.aiEnabled ? 1 : 0, id).run();
  }
  if (body.agent && typeof body.agent === 'object') {
    // Campos que solo el super admin define (presupuesto, reglas extra, plantillas de WhatsApp).
    const agent = { ...business.agent };
    if (body.agent.monthlyBudgetUsd != null) agent.monthlyBudgetUsd = Math.max(0, Number(body.agent.monthlyBudgetUsd) || 0);
    if (body.agent.extraRules != null) agent.extraRules = str(body.agent.extraRules, 2000);
    if (body.agent.reminderTemplate != null) agent.reminderTemplate = str(body.agent.reminderTemplate, 100);
    if (body.agent.reactivationTemplate != null) agent.reactivationTemplate = str(body.agent.reactivationTemplate, 100);
    if (body.agent.autoReactivation != null) agent.autoReactivation = body.agent.autoReactivation === true;
    await c.env.DB.prepare('UPDATE businesses SET agent_config = ? WHERE id = ?').bind(JSON.stringify(agent), id).run();
  }
  await invalidateBusiness(c.env, id);
  return c.json({ ok: true });
});

moderator.delete('/companies/:id', async (c) => {
  const id = int(c.req.param('id'))!;
  await c.env.DB.prepare('DELETE FROM businesses WHERE id = ?').bind(id).run();
  await invalidateBusiness(c.env, id);
  return c.json({ ok: true });
});

moderator.get('/ai-settings', async (c) => c.json({
  onboardingEnabled: await platformSetting(c.env, 'onboardingEnabled'),
  firstStepsEnabled: await platformSetting(c.env, 'firstStepsEnabled'),
  publicSignupEnabled: await platformSetting(c.env, 'publicSignupEnabled'),
}));

moderator.put('/ai-settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const statements = Object.keys(SETTINGS_DEFAULTS)
    .filter((key) => typeof body[key] === 'boolean')
    .map((key) => c.env.DB.prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, JSON.stringify(body[key])));
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

export default moderator;
