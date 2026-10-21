import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAuth, requireBusiness, requireModule } from '../auth';
import { getBusiness } from '../db';
import { createOrder, ORDER_STATUSES, productOut, type ProductRow } from '../domain/commerce';
import { bad, cents, int, json, money, notFound, str } from '../lib/http';
import { toLocalIso } from '../lib/time';

/* ---------- Catálogo (productos, menú, habitaciones…) ---------- */

export const products = new Hono<AppEnv>();
products.use('*', requireAuth, requireBusiness, requireModule('catalogo'));

const productIn = (body: Record<string, unknown>) => {
  const name = str(body.name, 160);
  const price = cents(body.price);
  if (!name || price == null) throw bad('El producto necesita nombre y precio.');
  return {
    name, price, description: str(body.description, 1000), category: str(body.category, 80), image: str(body.image_url, 500),
    stock: body.stock === '' || body.stock == null ? null : Math.max(0, int(body.stock) ?? 0), enabled: body.enabled === false ? 0 : 1,
  };
};

products.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM products WHERE business_id = ? ORDER BY category, name').bind(c.get('businessId')).all<ProductRow>();
  return c.json(results.map(productOut));
});

products.post('/', async (c) => {
  const p = productIn(await c.req.json());
  const row = await c.env.DB.prepare(
    'INSERT INTO products (business_id, name, description, category, price_cents, stock, image_url, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
  ).bind(c.get('businessId'), p.name, p.description, p.category, p.price, p.stock, p.image, p.enabled).first<ProductRow>();
  return c.json(productOut(row!));
});

products.put('/:id', async (c) => {
  const p = productIn(await c.req.json());
  const row = await c.env.DB.prepare(
    `UPDATE products SET name = ?, description = ?, category = ?, price_cents = ?, stock = ?, image_url = ?, enabled = ?
      WHERE id = ? AND business_id = ? RETURNING *`,
  ).bind(p.name, p.description, p.category, p.price, p.stock, p.image, p.enabled, int(c.req.param('id')), c.get('businessId')).first<ProductRow>();
  if (!row) throw notFound('Producto no encontrado.');
  return c.json(productOut(row));
});

products.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM products WHERE id = ? AND business_id = ?').bind(int(c.req.param('id')), c.get('businessId')).run();
  return c.json({ ok: true });
});

/* ---------- Pedidos ---------- */

export const orders = new Hono<AppEnv>();
orders.use('*', requireAuth, requireBusiness, requireModule('pedidos'));

type OrderRow = {
  id: number; customer_id: number | null; status: string; items: string; total_cents: number; paid_cents: number; delivery_address: string;
  delivery_note: string; origin: string; created_at: number; first_name: string | null; last_name: string | null; phone: string | null;
};

orders.get('/', async (c) => {
  const b = (await getBusiness(c.env, c.get('businessId')))!;
  const status = c.req.query('status');
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, c.first_name, c.last_name, c.phone FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.business_id = ? ${status ? 'AND o.status = ?' : ''} ORDER BY o.id DESC LIMIT 500`,
  ).bind(b.id, ...(status ? [status] : [])).all<OrderRow>();
  return c.json(results.map((o) => ({
    id: o.id, customer_id: o.customer_id, customer_name: [o.first_name, o.last_name].filter(Boolean).join(' ') || 'Sin nombre', phone: o.phone ?? '',
    status: o.status, items: json(o.items, []), total: money(o.total_cents), paid: money(o.paid_cents), delivery_address: o.delivery_address,
    delivery_note: o.delivery_note, origin: o.origin, created_at: toLocalIso(o.created_at, b.timezone),
  })));
});

orders.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const customerId = int(body.customer_id);
  if (customerId) {
    const own = await c.env.DB.prepare('SELECT 1 FROM customers WHERE id = ? AND business_id = ?').bind(customerId, c.get('businessId')).first();
    if (!own) throw notFound('Cliente no encontrado.');
  }
  const order = await createOrder(c.env, c.get('businessId'), {
    customerId, items: Array.isArray(body.items) ? body.items : [], address: str(body.delivery_address, 300), note: str(body.delivery_note, 500), origin: 'admin',
  });
  return c.json({ ok: true, ...order });
});

orders.post('/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!ORDER_STATUSES.includes(body.status)) throw bad('Estado inválido.');
  const row = await c.env.DB.prepare('UPDATE orders SET status = ? WHERE id = ? AND business_id = ? RETURNING id')
    .bind(body.status, int(c.req.param('id')), c.get('businessId')).first();
  if (!row) throw notFound('Pedido no encontrado.');
  return c.json({ ok: true });
});

orders.post('/:id/payment', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const amount = cents(body.amount);
  if (!amount) throw bad('Escribe el monto cobrado.');
  const id = int(c.req.param('id'));
  const row = await c.env.DB.prepare(
    `UPDATE orders SET paid_cents = paid_cents + ?1,
            status = CASE WHEN paid_cents + ?1 >= total_cents AND status IN ('nuevo','confirmado') THEN 'pagado' ELSE status END
      WHERE id = ?2 AND business_id = ?3 RETURNING id`,
  ).bind(amount, id, c.get('businessId')).first();
  if (!row) throw notFound('Pedido no encontrado.');
  await c.env.DB.prepare('INSERT INTO payments (business_id, order_id, amount_cents, method, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.get('businessId'), id, amount, str(body.method, 40) || 'Transferencia', Date.now()).run();
  return c.json({ ok: true });
});
