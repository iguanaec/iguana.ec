// Catálogo y pedidos, compartido por el panel y el agente.
import type { Env } from '../env';
import { bad, money } from '../lib/http';

export type ProductRow = {
  id: number; name: string; description: string; category: string; price_cents: number; stock: number | null; image_url: string; enabled: number;
};

export const productOut = (p: ProductRow) => ({
  id: p.id, name: p.name, description: p.description, category: p.category, price: money(p.price_cents), stock: p.stock,
  image_url: p.image_url, enabled: p.enabled === 1,
});

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Búsqueda simple por palabras (nombre, categoría, descripción). Sin embeddings: es gratis y suficiente para catálogos pequeños. */
export async function searchProducts(env: Env, businessId: number, query: string, limit = 5) {
  const { results } = await env.DB.prepare('SELECT * FROM products WHERE business_id = ? AND enabled = 1 ORDER BY id LIMIT 1000')
    .bind(businessId).all<ProductRow>();
  const words = norm(query).split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return results.slice(0, limit);
  return results
    .map((p) => {
      const hay = norm(`${p.name} ${p.category} ${p.description}`);
      return { p, score: words.reduce((s, w) => s + (hay.includes(w) ? (norm(p.name).includes(w) ? 2 : 1) : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

export interface OrderItemInput { product_id: number; qty: number }

export async function createOrder(env: Env, businessId: number, input: {
  customerId: number | null; items: OrderItemInput[]; address?: string; note?: string; origin: string;
}) {
  if (!input.items?.length) throw bad('El pedido no tiene productos.');
  if (input.items.length > 50) throw bad('Un pedido puede tener hasta 50 productos distintos.');
  const ids = [...new Set(input.items.map((i) => Number(i.product_id)))];
  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE business_id = ? AND enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`,
  ).bind(businessId, ...ids).all<ProductRow>();
  const items = input.items.map((i) => {
    const p = results.find((x) => x.id === Number(i.product_id));
    if (!p) throw bad(`El producto ${i.product_id} no existe o no está disponible.`);
    const qty = Math.max(1, Math.min(999, Math.round(Number(i.qty) || 1)));
    if (p.stock != null && p.stock < qty) throw bad(`Solo quedan ${p.stock} unidades de ${p.name}.`);
    return { product_id: p.id, name: p.name, qty, price_cents: p.price_cents };
  });
  const total = items.reduce((s, i) => s + i.qty * i.price_cents, 0);
  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (business_id, customer_id, items, total_cents, delivery_address, delivery_note, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(businessId, input.customerId, JSON.stringify(items), total, input.address ?? '', input.note ?? '', input.origin, Date.now()),
    ...items.filter((i) => results.find((p) => p.id === i.product_id)?.stock != null)
      .map((i) => env.DB.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND business_id = ?').bind(i.qty, i.product_id, businessId)),
  ];
  const [inserted] = await env.DB.batch<{ id: number }>(statements);
  return { id: inserted.results[0].id, items, total_cents: total };
}

export const ORDER_STATUSES = ['nuevo', 'confirmado', 'pagado', 'enviado', 'entregado', 'cancelado'];
