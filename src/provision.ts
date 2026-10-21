import type { Env } from './env';
import { defaultAgentConfig, defaultSettings, invalidateBusiness, type Settings } from './db';
import { getNiche, modulesFor } from './niches';
import { hashPassword } from './lib/crypto';
import { bad } from './lib/http';

export interface NewBusiness {
  name: string;
  niche: string;
  username: string;
  password: string;
  communicationStyle?: Settings['businessProfile']['communicationStyle'];
  ownerPhone?: string;
  mustChangePassword?: boolean;
  timezone?: string;
}

export function validateUsername(username: string) {
  if (!/^[\p{L}\p{N}._@+-]{3,120}$/u.test(username)) throw bad('El usuario debe tener entre 3 y 120 caracteres, sin espacios.');
}

export function validatePassword(password: string) {
  if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
  if (password.length > 200) throw bad('La contraseña es demasiado larga.');
}

/** Crea negocio + dueño y siembra servicios/productos de la plantilla del giro. */
export async function createBusiness(env: Env, input: NewBusiness) {
  const niche = getNiche(input.niche);
  if (!niche) throw bad('Elige un tipo de negocio válido.');
  validateUsername(input.username);
  validatePassword(input.password);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(input.username).first();
  if (exists) throw bad('Ese usuario ya existe. Elige otro.');

  const tz = input.timezone || 'America/Guayaquil';
  const settings = defaultSettings(input.name, tz);
  if (input.communicationStyle) settings.businessProfile.communicationStyle = input.communicationStyle;
  if (niche.mode === 'alto_flujo') settings.parallelCapacity = 3;
  const agent = defaultAgentConfig();
  const phone = (input.ownerPhone || '').replace(/\D/g, '');
  if (phone) agent.ownerPhones = [phone];

  const now = Date.now();
  const business = await env.DB.prepare(
    `INSERT INTO businesses (name, niche, mode, modules, timezone, settings, agent_config, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(input.name, niche.id, niche.mode, JSON.stringify(modulesFor(niche)), tz, JSON.stringify(settings), JSON.stringify(agent), now)
    .first<{ id: number }>();
  const businessId = business!.id;

  await env.DB.prepare(
    `INSERT INTO users (business_id, username, password_hash, role, phone, must_change_password, created_at)
     VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
  ).bind(businessId, input.username, await hashPassword(input.password), phone || null, input.mustChangePassword ? 1 : 0, now).run();

  await seedCatalog(env, businessId, niche.id);
  return businessId;
}

/** Siembra (o re-siembra durante el onboarding) los servicios y productos del giro. */
export async function seedCatalog(env: Env, businessId: number, nicheId: string) {
  const niche = getNiche(nicheId)!;
  const statements: D1PreparedStatement[] = [];
  for (const s of niche.services ?? []) {
    statements.push(env.DB.prepare(
      `INSERT INTO services (business_id, name, description, duration_minutes, price_cents, return_cycle_days, capacity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(businessId, s.name, s.description ?? '', s.duration, s.price == null ? null : Math.round(s.price * 100), s.cycleDays ?? null, s.capacity ?? 1));
  }
  for (const p of niche.products ?? []) {
    statements.push(env.DB.prepare(
      'INSERT INTO products (business_id, name, description, category, price_cents) VALUES (?, ?, ?, ?, ?)',
    ).bind(businessId, p.name, p.description ?? '', p.category ?? '', Math.round(p.price * 100)));
  }
  if (statements.length) await env.DB.batch(statements);
}

/**
 * Cambia el giro. Durante el onboarding lo hace el dueño; después solo el super admin.
 * Si todavía no hay movimiento, reemplaza el catálogo sembrado por el del nuevo giro.
 */
export async function changeNiche(env: Env, businessId: number, nicheId: string) {
  const niche = getNiche(nicheId);
  if (!niche) throw bad('Tipo de negocio inválido.');
  await env.DB.prepare('UPDATE businesses SET niche = ?, mode = ?, modules = ? WHERE id = ?')
    .bind(niche.id, niche.mode, JSON.stringify(modulesFor(niche)), businessId).run();
  const activity = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM appointments WHERE business_id = ?1) + (SELECT COUNT(*) FROM orders WHERE business_id = ?1) AS n`,
  ).bind(businessId).first<{ n: number }>();
  if (!activity?.n) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM services WHERE business_id = ?').bind(businessId),
      env.DB.prepare('DELETE FROM products WHERE business_id = ?').bind(businessId),
    ]);
    await seedCatalog(env, businessId, niche.id);
  }
  await invalidateBusiness(env, businessId);
}
