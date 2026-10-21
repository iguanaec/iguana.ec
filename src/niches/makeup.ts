import type { NicheTemplate } from './types';

export default {
  id: 'makeup', label: 'Maquillaje / estética', icon: 'sparkle', mode: 'citas',
  description: 'Maquillaje social, novias, cejas, pestañas y faciales.',
  customerFields: [{ key: 'evento', label: 'Tipo de evento' }, { key: 'tipo_piel', label: 'Tipo de piel', options: ['Seca', 'Mixta', 'Grasa', 'Sensible'] }],
  services: [
    { name: 'Maquillaje social', duration: 60, price: 30 },
    { name: 'Maquillaje de novia (con prueba)', duration: 150, price: 120 },
    { name: 'Diseño de cejas', duration: 30, price: 10, cycleDays: 21 },
    { name: 'Lifting de pestañas', duration: 60, price: 25, cycleDays: 45 },
    { name: 'Limpieza facial', duration: 60, price: 30, cycleDays: 30 },
  ],
  persona: 'asistente de una maquilladora profesional',
  rules: ['Pregunta la fecha y hora del evento; para novias sugiere agendar también la prueba.', 'Si es a domicilio, pide la dirección y avisa que puede tener recargo.'],
  reactivationMessage: 'Hola {nombre} ✨ ¿te agendo tu próximo {servicio}?',
} satisfies NicheTemplate;
