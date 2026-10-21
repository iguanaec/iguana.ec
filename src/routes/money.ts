import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule, requireRole } from '../auth';
import { getBusiness, type Business } from '../db';
import { paymentStatus } from '../domain/booking';
import { bad, cents, int, money, str } from '../lib/http';
import { addDays, localDate, localToUtc, toLocalIso } from '../lib/time';
import type { Env } from '../env';

const app = () => {
  const h = new Hono<AppEnv>();
  h.use('*', requireAuth, requireBusiness, requireRole('admin'));
  return h;
};
export const expenses = app();
export const income = app();
export const dashboard = app();

/* ---------- Gastos ---------- */

type ExpenseRow = { id: number; amount_cents: number; [k: string]: unknown };
const expenseOut = (e: ExpenseRow) => {
  const { amount_cents, business_id: _b, created_at: _c, ...rest } = e;
  return { ...rest, amount: money(amount_cents), receipt_url: '' };
};

expenses.get('/', requireModule('dinero'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM expenses WHERE business_id = ? ORDER BY expense_date DESC, id DESC LIMIT 1000')
    .bind(c.get('businessId')).all<ExpenseRow>();
  return c.json(results.map(expenseOut));
});

export async function insertExpense(env: Env, businessId: number, v: Record<string, unknown>) {
  const amount = cents(v.amount);
  if (!amount) throw bad('Escribe el monto del gasto.');
  const description = str(v.description, 200);
  if (!description) throw bad('Describe el gasto.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(v.expense_date)) ? String(v.expense_date) : new Date().toISOString().slice(0, 10);
  return env.DB.prepare(
    `INSERT INTO expenses (business_id, expense_date, description, notes, category, supplier, payment_method, bank, document_type, document_number, amount_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(businessId, date, description, str(v.notes, 500), str(v.category, 60) || 'Otros', str(v.supplier, 120), str(v.payment_method, 40) || 'Efectivo',
    str(v.bank, 60), str(v.document_type, 40), str(v.document_number, 60), amount, Date.now()).first<ExpenseRow>();
}

expenses.post('/', requireModule('dinero'), async (c) => {
  const type = c.req.header('Content-Type') || '';
  const body = type.includes('application/json') ? await c.req.json() : Object.fromEntries((await c.req.formData()).entries());
  return c.json(expenseOut((await insertExpense(c.env, c.get('businessId'), body))!));
});

expenses.delete('/:id', requireModule('dinero'), async (c) => {
  await c.env.DB.prepare('DELETE FROM expenses WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Ingresos: citas y pedidos en un mismo formato ---------- */

interface IncomeRow {
  id: number; kind: 'cita' | 'pedido'; customer_name: string; service_name: string; start_ts: number; status: string;
  price_cents: number; paid_cents: number;
}

async function incomeRows(env: Env, b: Business, from?: string, to?: string) {
  const start = from ? localToUtc(from, '00:00', b.timezone) : 0;
  const end = to ? localToUtc(addDays(to, 1), '00:00', b.timezone) : 8.64e15;
  const [appts, orders] = await env.DB.batch<IncomeRow>([
    env.DB.prepare(
      `SELECT a.id, 'cita' AS kind, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS customer_name,
              COALESCE(s.name, 'Servicio') AS service_name, a.start_ts, a.status, COALESCE(a.price_cents, 0) AS price_cents, a.paid_cents
         FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN services s ON s.id = a.service_id
        WHERE a.business_id = ? AND a.start_ts >= ? AND a.start_ts < ?`,
    ).bind(b.id, start, end),
    env.DB.prepare(
      `SELECT o.id, 'pedido' AS kind, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS customer_name,
              'Pedido #' || o.id AS service_name, o.created_at AS start_ts,
              CASE o.status WHEN 'cancelado' THEN 'cancelled' WHEN 'entregado' THEN 'completed' ELSE 'confirmed' END AS status,
              o.total_cents AS price_cents, o.paid_cents
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.business_id = ? AND o.created_at >= ? AND o.created_at < ?`,
    ).bind(b.id, start, end),
  ]);
  return [...appts.results, ...orders.results].map((r) => ({ ...r, customer_name: r.customer_name || 'Sin nombre' }));
}

const outstanding = (r: IncomeRow) => (r.status === 'cancelled' ? 0 : Math.max(0, r.price_cents - r.paid_cents));

income.get('/', requireModule('dinero'), async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const customer = (c.req.query('customer') || '').toLocaleLowerCase('es');
  const service = c.req.query('service');
  const status = c.req.query('status');
  const list = (await incomeRows(c.env, b, c.req.query('from'), c.req.query('to')))
    .map((r) => ({ ...r, payment_status: paymentStatus(r.price_cents, r.paid_cents) }))
    .filter((r) => !customer || r.customer_name.toLocaleLowerCase('es').includes(customer))
    .filter((r) => !service || r.service_name === service)
    .filter((r) => !status || r.payment_status === status)
    .sort((x, y) => y.start_ts - x.start_ts);
  const live = list.filter((r) => r.status !== 'cancelled');
  return c.json({
    summary: {
      expected_cents: live.reduce((s, r) => s + r.price_cents, 0),
      paid_cents: live.reduce((s, r) => s + r.paid_cents, 0),
      outstanding_cents: live.reduce((s, r) => s + outstanding(r), 0),
      appointments: list.length,
    },
    appointments: list.map((r) => ({
      id: r.id, kind: r.kind, customer_name: r.customer_name, service_name: r.service_name, start_at: toLocalIso(r.start_ts, b.timezone),
      appointment_status: r.status, status: r.status, price_cents: r.price_cents, paid_cents: r.paid_cents, payment_status: r.payment_status,
      outstanding_cents: outstanding(r),
    })),
  });
});

export async function dashboardData(env: Env, b: Business, from?: string, to?: string) {
  const rows = (await incomeRows(env, b, from, to)).filter((r) => r.status !== 'cancelled');
  const { results: exp } = await env.DB.prepare(
    `SELECT expense_date, amount_cents FROM expenses WHERE business_id = ? AND expense_date >= ? AND expense_date <= ?`,
  ).bind(b.id, from || '0000-00-00', to || '9999-12-31').all<{ expense_date: string; amount_cents: number }>();
  const income = rows.reduce((s, r) => s + r.paid_cents, 0);
  const expenses = exp.reduce((s, e) => s + e.amount_cents, 0);
  const unpaid = rows.filter((r) => outstanding(r) > 0);
  const byService: Record<string, number> = {};
  const days: Record<string, { income_cents: number; expenses_cents: number }> = {};
  for (const r of rows) {
    const key = r.kind === 'pedido' ? 'Pedidos' : r.service_name;
    byService[key] = (byService[key] || 0) + 1;
    (days[localDate(r.start_ts, b.timezone)] ||= { income_cents: 0, expenses_cents: 0 }).income_cents += r.paid_cents;
  }
  for (const e of exp) (days[e.expense_date] ||= { income_cents: 0, expenses_cents: 0 }).expenses_cents += e.amount_cents;
  return {
    summary: {
      income_cents: income, expenses_cents: expenses, profit_cents: income - expenses,
      outstanding_cents: unpaid.reduce((s, r) => s + outstanding(r), 0), services_count: rows.length,
      unpaid_people: new Set(unpaid.map((r) => r.customer_name)).size,
    },
    service_breakdown: Object.entries(byService).map(([service_name, appointments]) => ({ service_name, appointments })).sort((a, b2) => b2.appointments - a.appointments),
    daily_activity: Object.entries(days).sort(([a], [b2]) => a.localeCompare(b2)).map(([date, v]) => ({ date, ...v })),
    unpaid: unpaid.map((r) => ({
      customer_name: r.customer_name, service_name: r.service_name, start_at: toLocalIso(r.start_ts, b.timezone), paid_cents: r.paid_cents, outstanding_cents: outstanding(r),
    })),
  };
}

dashboard.get('/', requireModule('inicio'), async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  return c.json(await dashboardData(c.env, b, c.req.query('from'), c.req.query('to')));
});

