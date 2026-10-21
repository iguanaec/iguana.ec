import type { NicheTemplate } from './types';

export default {
  id: 'barberia', label: 'Barbería', icon: 'scissors', mode: 'alto_flujo',
  description: 'Turnos rápidos de corte y barba con varios barberos.',
  customerFields: [],
  services: [
    { name: 'Corte', duration: 30, price: 6, cycleDays: 21, capacity: 3 },
    { name: 'Barba', duration: 20, price: 4, cycleDays: 14, capacity: 3 },
    { name: 'Corte + barba', duration: 45, price: 9, cycleDays: 21, capacity: 3 },
  ],
  persona: 'asistente de turnos de una barbería',
  rules: ['Habla relajado y directo.'],
  reactivationMessage: 'Qué más {nombre} 💈 ya toca retoque. ¿Te aparto turno?',
} satisfies NicheTemplate;
