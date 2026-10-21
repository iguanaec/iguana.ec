import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireRole } from '../auth';
import { getBusiness, invalidateBusiness } from '../db';
import { forbidden, str } from '../lib/http';
import { changeNiche } from '../provision';

/**
 * Onboarding: el dueño elige su giro mientras el negocio está en "onboarding".
 * Al completarlo, giro, modo y secciones quedan bloqueados; solo el super admin puede cambiarlos.
 */
const onboarding = new Hono<AppEnv>();
onboarding.use('*', requireAuth, requireBusiness, requireRole('admin'));

onboarding.get('/', async (c) => {
  const business = (await getBusiness(c.env, c.get('businessId')))!;
  const channels = await c.env.DB.prepare('SELECT kind, display_name FROM channels WHERE business_id = ? AND status = ?')
    .bind(business.id, 'active').all();
  const services = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM services WHERE business_id = ?').bind(business.id).first<{ n: number }>();
  return c.json({
    status: business.status,
    locked: business.locked,
    niche: business.niche,
    steps: {
      niche: true,
      catalog: (services?.n ?? 0) > 0 || ['ventas', 'pedidos'].includes(business.mode),
      hours: business.settings.businessHours.some((h) => h.enabled),
      channels: channels.results.length > 0,
    },
    channels: channels.results,
  });
});

onboarding.put('/niche', async (c) => {
  const business = (await getBusiness(c.env, c.get('businessId')))!;
  if (business.locked && c.get('user').role !== 'super_admin') {
    throw forbidden('El tipo de negocio ya quedó definido. Para cambiarlo escríbele a soporte de Iguana.');
  }
  const body = await c.req.json().catch(() => ({}));
  await changeNiche(c.env, business.id, str(body.niche, 60));
  return c.json({ ok: true });
});

onboarding.post('/complete', async (c) => {
  const id = c.get('businessId');
  await c.env.DB.prepare("UPDATE businesses SET locked = 1, status = CASE WHEN status = 'onboarding' THEN 'active' ELSE status END WHERE id = ?")
    .bind(id).run();
  await invalidateBusiness(c.env, id);
  return c.json({ ok: true });
});

export default onboarding;
