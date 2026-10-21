import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { runConversation } from './agent/run';

const MAX_WAIT_MS = 15_000;

/**
 * Un Durable Object por conversación:
 * - Serializa: nunca hay dos respuestas simultáneas para el mismo cliente.
 * - Agrupa ráfagas: espera BURST_WINDOW_MS de silencio (máx. 15 s) y responde todo en UNA llamada a Gemini.
 */
export class ConversationDO extends DurableObject<Env> {
  async notify(businessId: number, conversationId: number) {
    const now = Date.now();
    const first = (await this.ctx.storage.get<number>('firstAt')) ?? now;
    await this.ctx.storage.put({ target: { businessId, conversationId }, firstAt: first });
    const burst = Number(this.env.BURST_WINDOW_MS) || 4000;
    await this.ctx.storage.setAlarm(Math.min(now + burst, first + MAX_WAIT_MS));
  }

  async alarm() {
    const target = await this.ctx.storage.get<{ businessId: number; conversationId: number }>('target');
    await this.ctx.storage.delete('firstAt');
    if (!target) return;
    await runConversation(this.env, target.businessId, target.conversationId);
  }
}

export function notifyConversation(env: Env, businessId: number, conversationId: number) {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${businessId}:${conversationId}`));
  return stub.notify(businessId, conversationId);
}
