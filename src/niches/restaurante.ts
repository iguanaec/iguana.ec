import type { NicheTemplate } from './types';

export default {
  id: 'restaurante', label: 'Restaurante / cafetería / delivery', icon: 'food', mode: 'pedidos',
  description: 'Menú, pedidos a domicilio o para retirar.',
  customerFields: [{ key: 'direccion_entrega', label: 'Dirección de entrega' }],
  products: [
    { name: 'Almuerzo del día', price: 3.5, category: 'Almuerzos' },
    { name: 'Jugo natural', price: 1.5, category: 'Bebidas' },
  ],
  persona: 'mesero virtual de un restaurante',
  rules: ['Pregunta si es para domicilio o para retirar. Informa el tiempo estimado de entrega si está en las notas del negocio.'],
} satisfies NicheTemplate;
