import type { NicheTemplate } from './types';

export default {
  id: 'tienda', label: 'Tienda online / ecommerce', icon: 'bag', mode: 'ventas',
  description: 'Catálogo, pedidos por chat, pagos por transferencia y envíos.',
  customerFields: [{ key: 'ciudad', label: 'Ciudad de envío' }, { key: 'talla', label: 'Talla' }],
  products: [
    { name: 'Producto ejemplo', price: 20, category: 'General', description: 'Edita o reemplaza este producto en Catálogo.' },
  ],
  persona: 'asesor de ventas de una tienda online',
  rules: ['Cierra la venta con amabilidad, sin presionar. Si un producto no tiene stock, ofrece una alternativa parecida.'],
  reactivationMessage: 'Hola {nombre} 🛍️ llegaron novedades que te pueden gustar. ¿Te muestro?',
} satisfies NicheTemplate;
