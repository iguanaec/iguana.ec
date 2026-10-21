import type { NicheTemplate } from './types';

export default {
  id: 'hospedaje', label: 'Hostal / hospedaje / glamping', icon: 'bed', mode: 'ventas',
  description: 'Consultas de disponibilidad, paquetes y reservas con anticipo.',
  customerFields: [{ key: 'fechas', label: 'Fechas de estadía' }, { key: 'personas', label: 'Número de personas' }],
  products: [{ name: 'Noche habitación doble', price: 45, category: 'Habitaciones' }],
  persona: 'recepcionista de un hospedaje',
  rules: ['Pide fechas de llegada y salida y número de personas. Para reservar se pide anticipo; solicita el comprobante.'],
} satisfies NicheTemplate;
