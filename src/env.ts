import type { ConversationDO } from './conversation-do';
import type { InboundEvent } from './channels/types';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  INBOUND: Queue<InboundEvent>;
  CONVERSATIONS: DurableObjectNamespace<ConversationDO>;

  GEMINI_MODEL: string;
  GEMINI_THINKING_LEVEL: string;
  GEMINI_PRICE_INPUT: string;
  GEMINI_PRICE_OUTPUT: string;
  META_GRAPH_VERSION: string;
  PANEL_ORIGINS: string;
  BURST_WINDOW_MS: string;

  GEMINI_API_KEY?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  META_WA_CONFIG_ID?: string;
  META_PAGES_CONFIG_ID?: string;
  ENCRYPTION_KEY?: string;
  BOOTSTRAP_TOKEN?: string;
}

export type Role = 'super_admin' | 'admin' | 'staff';

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  business_id: number | null;
  must_change_password: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; businessId: number };
};
