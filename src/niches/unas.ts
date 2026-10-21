import type { NicheTemplate } from './types';

export default {
  id: 'unas', label: 'Uñas / nail bar', icon: 'sparkle', mode: 'citas',
  description: 'Manicure, pedicure, acrílicas y gel.',
  customerFields: [],
  services: [
    { name: 'Manicure tradicional', duration: 45, price: 8, cycleDays: 15 },
    { name: 'Uñas en gel', duration: 60, price: 15, cycleDays: 21 },
    { name: 'Uñas acrílicas', duration: 120, price: 25, cycleDays: 21 },
    { name: 'Pedicure spa', duration: 60, price: 15, cycleDays: 30 },
  ],
  persona: 'asistente de un nail bar',
  rules: ['Si piden un diseño, pide una foto de referencia y avisa que el precio puede variar según el diseño.'],
  reactivationMessage: 'Hola {nombre} 💅 ya es momento de renovar tus uñas. ¿Agendamos?',
} satisfies NicheTemplate;
