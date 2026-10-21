// Herramientas del agente: declaraciones para Gemini + ejecución contra D1.
// Cada negocio recibe solo las herramientas de su modo (menos tokens y menos errores).
import type { Env } from '../env';
import type { Business } from '../db';
import { MODES, OWNER_TOOLS } from '../niches/modes';
import { getNiche } from '../niches';
import type { FunctionDeclaration } from './gemini';
import {
  APPOINTMENT_SELECT, cancelAppointment, createAppointment, findService, nextSlots, rescheduleAppointment, slotsForDay,
  type AppointmentJoined,
} from '../domain/booking';
import { createOrder, searchProducts } from '../domain/commerce';
import { searchProperties, upsertLead } from '../domain/leads';
import { insertExpense, dashboardData } from '../routes/money';
import { addDays, humanDateTime, localDate, localToUtc, parseDateTime, toLocalIso } from '../lib/time';
import { json, money } from '../lib/http';
import { recordBooked } from './economy';

export interface ToolContext {
  env: Env;
  business: Business;
  conversationId: number;
  customerId: number | null;
  isOwner: boolean;
  origin: string;
  handoff?: string;
}

type Executor = (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;

const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'number', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required });

const DECLARATIONS: Record<string, (b: Business) => FunctionDeclaration> = {
  ver_disponibilidad: () => ({
    name: 'ver_disponibilidad',
    description: 'Horarios libres reales. Sin fecha devuelve los próximos disponibles.',
    parameters: obj({ servicio: S('Nombre del servicio'), fecha: S('AAAA-MM-DD (opcional)') }),
  }),
  agendar_cita: () => ({
    name: 'agendar_cita',
    description: 'Agenda una cita en un horario libre (confirma antes con el cliente).',
    parameters: obj({ servicio: S('Nombre del servicio'), fecha_hora: S('AAAA-MM-DDTHH:MM'), notas: S('Detalles útiles (opcional)') }, ['servicio', 'fecha_hora']),
  }),
  mis_citas: () => ({ name: 'mis_citas', description: 'Próximas citas del cliente, con su id.', parameters: obj({}) }),
  reprogramar_cita: () => ({
    name: 'reprogramar_cita', description: 'Cambia la fecha de una cita del cliente.',
    parameters: obj({ cita_id: N('id de mis_citas'), fecha_hora: S('AAAA-MM-DDTHH:MM') }, ['cita_id', 'fecha_hora']),
  }),
  cancelar_cita: () => ({ name: 'cancelar_cita', description: 'Cancela una cita del cliente.', parameters: obj({ cita_id: N('id de mis_citas') }, ['cita_id']) }),
  unirse_lista_espera: () => ({
    name: 'unirse_lista_espera', description: 'Anota al cliente para avisarle si se libera un cupo.',
    parameters: obj({ servicio: S('Nombre del servicio'), fecha: S('AAAA-MM-DD o vacío para cualquier día') }),
  }),
  guardar_dato_cliente: (b) => {
    const fields = getNiche(b.niche)?.customerFields ?? [];
    const props: Record<string, unknown> = { nombre: S('Nombre'), apellido: S('Apellido'), cedula: S('Cédula o RUC'), direccion: S('Dirección') };
    for (const f of fields) props[f.key] = S(f.options ? `${f.label}: ${f.options.join(' / ')}` : f.label);
    return { name: 'guardar_dato_cliente', description: 'Guarda datos que el cliente comparte.', parameters: obj(props) };
  },
  pasar_a_humano: () => ({
    name: 'pasar_a_humano', description: 'Pasa la conversación a una persona del negocio (queja, caso especial, emergencia o lo pide el cliente).',
    parameters: obj({ motivo: S('Motivo breve') }, ['motivo']),
  }),
  buscar_propiedades: () => ({
    name: 'buscar_propiedades', description: 'Busca propiedades disponibles.',
    parameters: obj({
      operacion: { type: 'string', enum: ['venta', 'arriendo'] }, tipo: S('casa, departamento, terreno, local, oficina'), zona: S('Sector o ciudad'),
      precio_maximo: N('USD'), dormitorios_min: N('Mínimo de dormitorios'),
    }),
  }),
  calificar_lead: () => ({
    name: 'calificar_lead', description: 'Registra o actualiza lo que busca el prospecto.',
    parameters: obj({
      interes: S('Qué busca'), presupuesto: N('USD'), zona: S('Zona'), forma_pago: S('Contado, crédito, etc.'), plazo: S('Cuándo lo necesita'), notas: S('Otros datos'),
    }, ['interes']),
  }),
  agendar_visita: () => ({
    name: 'agendar_visita', description: 'Agenda una visita (a una propiedad o reunión).',
    parameters: obj({ fecha_hora: S('AAAA-MM-DDTHH:MM'), propiedad_id: N('id de buscar_propiedades (opcional)'), notas: S('Opcional') }, ['fecha_hora']),
  }),
  buscar_productos: () => ({
    name: 'buscar_productos', description: 'Busca en el catálogo/menú con precios y stock reales.',
    parameters: obj({ busqueda: S('Qué busca el cliente; vacío = destacados') }),
  }),
  crear_pedido: () => ({
    name: 'crear_pedido', description: 'Crea el pedido cuando el cliente confirmó productos, cantidades y entrega.',
    parameters: obj({
      items: { type: 'array', items: obj({ producto_id: N('id del producto'), cantidad: N('cantidad') }, ['producto_id', 'cantidad']) },
      direccion: S('Dirección de entrega o "retiro en local"'), nota: S('Detalles (hora, extras)'),
    }, ['items']),
  }),
  estado_pedido: () => ({ name: 'estado_pedido', description: 'Estado de los últimos pedidos del cliente.', parameters: obj({}) }),
  resumen_negocio: () => ({
    name: 'resumen_negocio', description: 'Ingresos, gastos, ganancia y por cobrar.',
    parameters: obj({ periodo: { type: 'string', enum: ['hoy', 'semana', 'mes'] } }),
  }),
  agenda_del_dia: () => ({ name: 'agenda_del_dia', description: 'Citas de un día.', parameters: obj({ fecha: S('AAAA-MM-DD; vacío = hoy') }) }),
  bloquear_horario: () => ({
    name: 'bloquear_horario', description: 'Bloquea un rango para que no se agenden citas.',
    parameters: obj({ desde: S('AAAA-MM-DDTHH:MM'), hasta: S('AAAA-MM-DDTHH:MM'), motivo: S('Opcional') }, ['desde', 'hasta']),
  }),
  registrar_gasto: () => ({
    name: 'registrar_gasto', description: 'Registra un gasto del negocio.',
    parameters: obj({ monto: N('USD'), descripcion: S('Qué se compró'), categoria: S('Insumos, Arriendo, Servicios básicos, Marketing, Otros'), metodo_pago: S('Efectivo, Transferencia, Tarjeta') }, ['monto', 'descripcion']),
  }),
};

export function toolNamesFor(b: Business, isOwner: boolean) {
  if (isOwner) return OWNER_TOOLS.filter((t) => t !== 'agenda_del_dia' || b.modules.includes('calendario'));
  return MODES[b.mode].tools;
}

export const declarationsFor = (b: Business, isOwner: boolean) => toolNamesFor(b, isOwner).map((n) => DECLARATIONS[n](b));

/* ---------------- Ejecutores ---------------- */

const label = (ts: number, b: Business) => ({ fecha_hora: toLocalIso(ts, b.timezone).slice(0, 16), texto: humanDateTime(ts, b.timezone) });

async function myAppointments(ctx: ToolContext) {
  if (!ctx.customerId) return [];
  const { results } = await ctx.env.DB.prepare(
    `${APPOINTMENT_SELECT} WHERE a.business_id = ? AND a.customer_id = ? AND a.status = 'confirmed' AND a.start_ts > ? ORDER BY a.start_ts LIMIT 5`,
  ).bind(ctx.business.id, ctx.customerId, Date.now()).all<AppointmentJoined>();
  return results;
}

async function assertOwnAppointment(ctx: ToolContext, id: number) {
  const mine = await myAppointments(ctx);
  if (!mine.some((a) => a.id === id)) throw new Error('Esa cita no es de este cliente o ya pasó.');
}

const EXECUTORS: Record<string, Executor> = {
  async ver_disponibilidad(ctx, a) {
    const b = ctx.business;
    const service = await findService(ctx.env, b.id, a.servicio);
    if (!service) {
      const { results } = await ctx.env.DB.prepare('SELECT name FROM services WHERE business_id = ? AND enabled = 1').bind(b.id).all<{ name: string }>();
      return { error: 'Indica el servicio.', servicios: results.map((s) => s.name) };
    }
    const today = localDate(Date.now(), b.timezone);
    const slots = a.fecha && /^\d{4}-\d{2}-\d{2}$/.test(a.fecha)
      ? (await slotsForDay(ctx.env, b, service, a.fecha)).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 6)) === 0).slice(0, 6)
      : await nextSlots(ctx.env, b, service, today, 3);
    return { servicio: service.name, duracion_min: service.duration_minutes, precio: money(service.price_cents), horarios: slots.map((t) => label(t, b)) };
  },

  async agendar_cita(ctx, a) {
    const b = ctx.business;
    const service = await findService(ctx.env, b.id, a.servicio);
    if (!service) return { error: 'Servicio no encontrado.' };
    try {
      const appt = await createAppointment(ctx.env, b, {
        customerId: ctx.customerId, serviceId: service.id, startTs: parseDateTime(a.fecha_hora, b.timezone), origin: ctx.origin, notes: String(a.notas ?? '').slice(0, 500),
      });
      await recordBooked(ctx.env, b, service.price_cents);
      return { ok: true, cita_id: appt.id, servicio: service.name, ...label(appt.startTs, b), precio: money(service.price_cents) };
    } catch (err) {
      const alternatives = await nextSlots(ctx.env, b, service, localDate(parseDateTime(a.fecha_hora, b.timezone) || Date.now(), b.timezone), 3);
      return { error: (err as Error).message, alternativas: alternatives.map((t) => label(t, b)) };
    }
  },

  async mis_citas(ctx) {
    return (await myAppointments(ctx)).map((x) => ({ cita_id: x.id, servicio: x.service_name, ...label(x.start_ts, ctx.business) }));
  },

  async reprogramar_cita(ctx, a) {
    await assertOwnAppointment(ctx, Number(a.cita_id));
    const r = await rescheduleAppointment(ctx.env, ctx.business, Number(a.cita_id), parseDateTime(a.fecha_hora, ctx.business.timezone));
    return { ok: true, cita_id: r.id, ...label(r.startTs, ctx.business) };
  },

  async cancelar_cita(ctx, a) {
    await assertOwnAppointment(ctx, Number(a.cita_id));
    await cancelAppointment(ctx.env, ctx.business, Number(a.cita_id));
    return { ok: true };
  },

  async unirse_lista_espera(ctx, a) {
    if (!ctx.customerId) return { error: 'Sin cliente.' };
    const service = await findService(ctx.env, ctx.business.id, a.servicio);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(a.fecha ?? '') ? a.fecha : null;
    await ctx.env.DB.prepare('INSERT INTO waitlist (business_id, customer_id, service_id, desired_date, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(ctx.business.id, ctx.customerId, service?.id ?? null, date, Date.now()).run();
    return { ok: true, mensaje: 'Le avisaremos por aquí si se libera un cupo.' };
  },

  async guardar_dato_cliente(ctx, a) {
    if (!ctx.customerId) return { error: 'Sin cliente.' };
    const row = await ctx.env.DB.prepare('SELECT extra FROM customers WHERE id = ?').bind(ctx.customerId).first<{ extra: string }>();
    const extra = json<Record<string, string>>(row?.extra, {});
    const fields = getNiche(ctx.business.niche)?.customerFields ?? [];
    for (const f of fields) if (a[f.key]) extra[f.key] = String(a[f.key]).slice(0, 200);
    await ctx.env.DB.prepare(
      `UPDATE customers SET first_name = COALESCE(NULLIF(?, ''), first_name), last_name = COALESCE(NULLIF(?, ''), last_name),
              cedula_ruc = COALESCE(NULLIF(?, ''), cedula_ruc), address = COALESCE(NULLIF(?, ''), address), extra = ? WHERE id = ?`,
    ).bind(String(a.nombre ?? '').slice(0, 80), String(a.apellido ?? '').slice(0, 80), String(a.cedula ?? '').slice(0, 20),
      String(a.direccion ?? '').slice(0, 300), JSON.stringify(extra), ctx.customerId).run();
    return { ok: true };
  },

  async pasar_a_humano(ctx, a) {
    ctx.handoff = String(a.motivo ?? 'Cliente pide hablar con una persona').slice(0, 200);
    return { ok: true, mensaje: 'Una persona del equipo continuará la conversación.' };
  },

  async buscar_propiedades(ctx, a) {
    const list = await searchProperties(ctx.env, ctx.business.id, {
      operation: a.operacion, type: a.tipo, zone: a.zona, maxPrice: Number(a.precio_maximo) || null, minBedrooms: Number(a.dormitorios_min) || null,
    });
    return list.length
      ? list.map((p) => ({ propiedad_id: p.id, titulo: p.title, operacion: p.operation, zona: p.zone, precio: money(p.price_cents), dormitorios: p.bedrooms, banos: p.bathrooms, m2: p.area_m2, link: p.url || undefined }))
      : { resultado: 'No hay propiedades con esos criterios. Ofrece ampliar la búsqueda o registrar el interés.' };
  },

  async calificar_lead(ctx, a) {
    const r = await upsertLead(ctx.env, ctx.business.id, ctx.customerId, ctx.conversationId, {
      interest: String(a.interes ?? '').slice(0, 300), budget_cents: Number(a.presupuesto) > 0 ? Math.round(Number(a.presupuesto) * 100) : null,
      zone: String(a.zona ?? '').slice(0, 120), financing: String(a.forma_pago ?? '').slice(0, 80), timeline: String(a.plazo ?? '').slice(0, 80),
      notes: String(a.notas ?? '').slice(0, 500),
    });
    await ctx.env.DB.prepare('UPDATE conversations SET stage = ? WHERE id = ?').bind(r.score >= 60 ? 'calificado' : 'nuevo', ctx.conversationId).run();
    return { ok: true, puntaje: r.score };
  },

  async agendar_visita(ctx, a) {
    const b = ctx.business;
    const service = await findService(ctx.env, b.id, undefined)
      ?? (await ctx.env.DB.prepare('SELECT * FROM services WHERE business_id = ? AND enabled = 1 ORDER BY id LIMIT 1').bind(b.id).first());
    if (!service) return { error: 'El negocio no tiene configurado el tipo de visita.' };
    const propertyId = Number(a.propiedad_id) || null;
    if (propertyId) {
      const own = await ctx.env.DB.prepare('SELECT 1 FROM properties WHERE id = ? AND business_id = ?').bind(propertyId, b.id).first();
      if (!own) return { error: 'Propiedad no encontrada.' };
    }
    try {
      const appt = await createAppointment(ctx.env, b, {
        customerId: ctx.customerId, serviceId: (service as { id: number }).id, startTs: parseDateTime(a.fecha_hora, b.timezone), origin: ctx.origin,
        kind: 'visita', propertyId, notes: String(a.notas ?? '').slice(0, 500),
      });
      if (ctx.customerId) {
        await ctx.env.DB.prepare("UPDATE leads SET stage = 'visita', updated_at = ? WHERE business_id = ? AND customer_id = ? AND stage IN ('nuevo','calificado')")
          .bind(Date.now(), b.id, ctx.customerId).run();
      }
      return { ok: true, visita_id: appt.id, ...label(appt.startTs, b) };
    } catch (err) {
      const alternatives = await nextSlots(ctx.env, b, service as never, localDate(Date.now(), b.timezone), 3);
      return { error: (err as Error).message, alternativas: alternatives.map((t) => label(t, b)) };
    }
  },

  async buscar_productos(ctx, a) {
    const list = await searchProducts(ctx.env, ctx.business.id, String(a.busqueda ?? ''), 6);
    return list.length
      ? list.map((p) => ({ producto_id: p.id, nombre: p.name, precio: money(p.price_cents), categoria: p.category || undefined, stock: p.stock ?? undefined, detalle: p.description.slice(0, 120) || undefined }))
      : { resultado: 'No encontré ese producto en el catálogo.' };
  },

  async crear_pedido(ctx, a) {
    try {
      const order = await createOrder(ctx.env, ctx.business.id, {
        customerId: ctx.customerId, origin: ctx.origin, address: String(a.direccion ?? '').slice(0, 300), note: String(a.nota ?? '').slice(0, 500),
        items: (Array.isArray(a.items) ? a.items : []).map((i: Record<string, unknown>) => ({ product_id: Number(i.producto_id), qty: Number(i.cantidad) })),
      });
      await recordBooked(ctx.env, ctx.business, order.total_cents);
      await ctx.env.DB.prepare("UPDATE conversations SET stage = 'pedido' WHERE id = ?").bind(ctx.conversationId).run();
      const p = ctx.business.settings.businessProfile;
      return {
        ok: true, pedido_id: order.id, total: money(order.total_cents), items: order.items.map((i) => `${i.qty} x ${i.name}`),
        como_pagar: p.paymentInstructions || p.acceptedPaymentMethods.join(', '),
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },

  async estado_pedido(ctx) {
    if (!ctx.customerId) return [];
    const { results } = await ctx.env.DB.prepare('SELECT id, status, total_cents, paid_cents, created_at FROM orders WHERE business_id = ? AND customer_id = ? ORDER BY id DESC LIMIT 3')
      .bind(ctx.business.id, ctx.customerId).all<{ id: number; status: string; total_cents: number; paid_cents: number; created_at: number }>();
    return results.map((o) => ({ pedido_id: o.id, estado: o.status, total: money(o.total_cents), pagado: money(o.paid_cents), fecha: localDate(o.created_at, ctx.business.timezone) }));
  },

  /* ----- Dueño ----- */

  async resumen_negocio(ctx, a) {
    const b = ctx.business;
    const today = localDate(Date.now(), b.timezone);
    const from = a.periodo === 'mes' ? `${today.slice(0, 7)}-01` : a.periodo === 'semana' ? addDays(today, -6) : today;
    const d = await dashboardData(ctx.env, b, from, today);
    return {
      desde: from, hasta: today, cobrado: money(d.summary.income_cents), gastos: money(d.summary.expenses_cents), ganancia: money(d.summary.profit_cents),
      por_cobrar: money(d.summary.outstanding_cents), atenciones: d.summary.services_count,
    };
  },

  async agenda_del_dia(ctx, a) {
    const b = ctx.business;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(a.fecha ?? '') ? a.fecha : localDate(Date.now(), b.timezone);
    const { results } = await ctx.env.DB.prepare(
      `${APPOINTMENT_SELECT} WHERE a.business_id = ? AND a.start_ts >= ? AND a.start_ts < ? AND a.status != 'cancelled' ORDER BY a.start_ts`,
    ).bind(b.id, localToUtc(date, '00:00', b.timezone), localToUtc(addDays(date, 1), '00:00', b.timezone)).all<AppointmentJoined>();
    return { fecha: date, citas: results.map((x) => ({ hora: toLocalIso(x.start_ts, b.timezone).slice(11, 16), cliente: [x.first_name, x.last_name].filter(Boolean).join(' '), servicio: x.service_name })) };
  },

  async bloquear_horario(ctx, a) {
    const b = ctx.business;
    const start = parseDateTime(a.desde, b.timezone);
    const end = parseDateTime(a.hasta, b.timezone);
    if (!(end > start)) return { error: 'El rango no es válido.' };
    await ctx.env.DB.prepare('INSERT INTO time_blocks (business_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?)').bind(b.id, start, end, String(a.motivo ?? '').slice(0, 200)).run();
    return { ok: true, desde: humanDateTime(start, b.timezone), hasta: humanDateTime(end, b.timezone) };
  },

  async registrar_gasto(ctx, a) {
    const row = await insertExpense(ctx.env, ctx.business.id, {
      amount: a.monto, description: a.descripcion, category: a.categoria, payment_method: a.metodo_pago, expense_date: localDate(Date.now(), ctx.business.timezone),
    });
    return { ok: true, gasto_id: row?.id, monto: Number(a.monto) };
  },
};

export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const allowed = toolNamesFor(ctx.business, ctx.isOwner);
  if (!allowed.includes(name) || !EXECUTORS[name]) return { error: `Herramienta no disponible: ${name}` };
  try {
    return await EXECUTORS[name](ctx, args);
  } catch (err) {
    return { error: (err as Error).message || 'Error al ejecutar la herramienta.' };
  }
}
