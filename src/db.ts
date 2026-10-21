import type { Env } from './env';
import type { Mode, Module } from './niches/types';
import { json } from './lib/http';

export interface BusinessHours { day: number; enabled: boolean; start: string; end: string }

export interface Settings {
  aiMode: 'client' | 'owner';
  appointmentDurationMinutes: number;
  businessTimezone: string;
  slotIntervalMinutes: number;
  minimumBookingNoticeMinutes: number;
  maximumAdvanceBookingDays: number;
  closedDates: string[];
  businessHours: BusinessHours[];
  /** Personas/sillas atendiendo a la vez. */
  parallelCapacity: number;
  /** Minutos que el bot se calla cuando el dueño responde desde su celular. */
  coexistencePauseMinutes: number;
  businessProfile: {
    businessName: string;
    communicationStyle: 'formal' | 'semiformal' | 'friend';
    preferredTone: string;
    greeting: string;
    address: string;
    contactPhone: string;
    cancellationPolicy: string;
    arrivalInstructions: string;
    generalNotes: string;
    acceptedPaymentMethods: string[];
    paymentInstructions: string;
  };
}

export interface Faq { keywords: string[]; answer: string }

/** Configuración del agente. Los campos marcados (admin) solo los cambia el super admin. */
export interface AgentConfig {
  faqs: Faq[];
  /** Números (solo dígitos, con código de país) que se tratan como el dueño. */
  ownerPhones: string[];
  /** (admin) Presupuesto mensual de IA en USD. */
  monthlyBudgetUsd: number;
  /** (admin) Reglas extra sobre la plantilla del giro. */
  extraRules: string;
  /** (admin) Plantillas aprobadas de WhatsApp para escribir fuera de la ventana de 24 h. */
  reminderTemplate: string;
  reactivationTemplate: string;
  autoReactivation: boolean;
}

export interface Business {
  id: number;
  name: string;
  niche: string;
  mode: Mode;
  modules: Module[];
  locked: boolean;
  status: string;
  timezone: string;
  ai_enabled: boolean;
  settings: Settings;
  agent: AgentConfig;
}

export function defaultSettings(name = '', tz = 'America/Guayaquil'): Settings {
  return {
    aiMode: 'client',
    appointmentDurationMinutes: 60,
    businessTimezone: tz,
    slotIntervalMinutes: 15,
    minimumBookingNoticeMinutes: 30,
    maximumAdvanceBookingDays: 31,
    closedDates: [],
    businessHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: day !== 0, start: '09:00', end: day === 6 ? '14:00' : '18:00' })),
    parallelCapacity: 1,
    coexistencePauseMinutes: 30,
    businessProfile: {
      businessName: name, communicationStyle: 'semiformal', preferredTone: '', greeting: '', address: '', contactPhone: '',
      cancellationPolicy: '', arrivalInstructions: '', generalNotes: '', acceptedPaymentMethods: ['Efectivo', 'Transferencia'],
      paymentInstructions: '',
    },
  };
}

export function defaultAgentConfig(): AgentConfig {
  return { faqs: [], ownerPhones: [], monthlyBudgetUsd: 5, extraRules: '', reminderTemplate: '', reactivationTemplate: '', autoReactivation: false };
}

type BusinessRow = {
  id: number; name: string; niche: string; mode: Mode; modules: string; locked: number; status: string;
  timezone: string; ai_enabled: number; settings: string; agent_config: string;
};

function hydrate(row: BusinessRow): Business {
  const settings = { ...defaultSettings(row.name, row.timezone), ...json<Partial<Settings>>(row.settings, {}) };
  settings.businessProfile = { ...defaultSettings(row.name).businessProfile, ...(settings.businessProfile || {}) };
  return {
    id: row.id, name: row.name, niche: row.niche, mode: row.mode, modules: json<Module[]>(row.modules, []),
    locked: row.locked === 1, status: row.status, timezone: row.timezone, ai_enabled: row.ai_enabled === 1,
    settings, agent: { ...defaultAgentConfig(), ...json<Partial<AgentConfig>>(row.agent_config, {}) },
  };
}

const cacheKey = (id: number) => `biz:${id}`;

/** Configuración del negocio con caché en KV (se lee en cada mensaje entrante). */
export async function getBusiness(env: Env, id: number): Promise<Business | null> {
  const cached = await env.CACHE.get<Business>(cacheKey(id), 'json');
  if (cached) return cached;
  const row = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first<BusinessRow>();
  if (!row) return null;
  const business = hydrate(row);
  await env.CACHE.put(cacheKey(id), JSON.stringify(business), { expirationTtl: 300 });
  return business;
}

export async function invalidateBusiness(env: Env, id: number) {
  await env.CACHE.delete(cacheKey(id));
}

export const now = () => Date.now();

/** Ejecuta varias sentencias en una sola ida a D1. */
export function batch(env: Env, statements: D1PreparedStatement[]) {
  return statements.length ? env.DB.batch(statements) : Promise.resolve([]);
}
