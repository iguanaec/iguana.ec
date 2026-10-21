import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import type { InboundEvent } from './channels/types';
import { processInbound } from './channels/inbound';
import { notifyConversation } from './conversation-do';
import { runCron } from './jobs/cron';
import authRoutes from './routes/auth';
import onboarding from './routes/onboarding';
import moderator from './routes/moderator';
import { agentConfig, aiDocuments, services, settings } from './routes/business';
import appointments from './routes/appointments';
import customers from './routes/customers';
import { dashboard, expenses, income } from './routes/money';
import { orders, products } from './routes/catalog';
import { leads, properties, reactivation, waitlist } from './routes/crm';
import { agentTest, conversations, proofs } from './routes/conversations';
import { channels, webhooks } from './routes/channels';

export { ConversationDO } from './conversation-do';

const app = new Hono<AppEnv>();

const originAllowed = (env: Env, origin: string) => {
  const allowed = env.PANEL_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) || origin.endsWith('.workers.dev') || origin.endsWith('.pages.dev') || origin === 'https://iguana.ec' || origin.endsWith('.iguana.ec');
};

app.use('/api/*', async (c, next) => {
  // CSRF: la cookie de sesión es SameSite=None (panel en otro dominio), así que toda petición que cambia datos
  // y viene de un navegador debe traer un Origin permitido.
  const origin = c.req.header('Origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin && !originAllowed(c.env, origin)) {
    return c.json({ error: 'Origen no permitido.' }, 403);
  }
  return cors({
    origin: (o) => (originAllowed(c.env, o) ? o : null),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Business-Id'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  })(c, next);
});

app.get('/', (c) => c.json({ ok: true, service: 'iguana-api' }));

app.route('/api', authRoutes);
app.route('/api/onboarding', onboarding);
app.route('/api/moderator', moderator);
app.route('/api/settings', settings);
app.route('/api/services', services);
app.route('/api/ai-documents', aiDocuments);
app.route('/api/appointments', appointments);
app.route('/api/customers', customers);
app.route('/api/expenses', expenses);
app.route('/api/income', income);
app.route('/api/dashboard', dashboard);
app.route('/api/products', products);
app.route('/api/orders', orders);
app.route('/api/properties', properties);
app.route('/api/leads', leads);
app.route('/api/waitlist', waitlist);
app.route('/api/reactivation', reactivation);
app.route('/api/conversations', conversations);
app.route('/api/payment-proofs', proofs);
app.route('/api/agent/test', agentTest);
app.route('/api/agent', agentConfig);
app.route('/api/channels', channels);
app.route('/webhooks', webhooks);

app.notFound((c) => c.json({ error: 'No encontrado.' }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' }, 500);
});

export default {
  fetch: app.fetch,

  /** Cola de mensajes entrantes: guarda, procesa medios y avisa al Durable Object de la conversación. */
  async queue(batch: MessageBatch<InboundEvent>, env: Env) {
    for (const msg of batch.messages) {
      try {
        const target = await processInbound(env, msg.body);
        if (target) await notifyConversation(env, target.businessId, target.conversationId);
        msg.ack();
      } catch (err) {
        console.error('inbound', (err as Error).message);
        msg.retry({ delaySeconds: 5 });
      }
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, event.cron));
  },
} satisfies ExportedHandler<Env, InboundEvent>;

export { app };
