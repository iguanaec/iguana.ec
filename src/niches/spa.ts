import type { NicheTemplate } from './types';

export default {
  id: 'spa', label: 'Spa / masajes', icon: 'leaf', mode: 'citas',
  description: 'Masajes, tratamientos corporales y paquetes.',
  customerFields: [{ key: 'condiciones', label: 'Condiciones de salud o embarazo' }],
  services: [
    { name: 'Masaje relajante', duration: 60, price: 35, cycleDays: 30 },
    { name: 'Masaje descontracturante', duration: 60, price: 40, cycleDays: 30 },
    { name: 'Día de spa', duration: 180, price: 90 },
  ],
  persona: 'recepcionista de un spa',
  rules: ['Habla con calma y calidez. Pregunta si tiene alguna condición de salud o está embarazada antes de agendar masajes.'],
  reactivationMessage: 'Hola {nombre} 🌿 te mereces otro momento de relax. ¿Reservamos tu {servicio}?',
} satisfies NicheTemplate;
