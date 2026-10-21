import type { NicheTemplate } from './types';

export default {
  id: 'peluqueria', label: 'Peluquería / salón de belleza', icon: 'scissors', mode: 'citas',
  description: 'Cortes, tintes, peinados y tratamientos con agenda por estilista.',
  customerFields: [{ key: 'tipo_cabello', label: 'Tipo de cabello', options: ['Liso', 'Ondulado', 'Rizado', 'Afro'] }],
  services: [
    { name: 'Corte de cabello', duration: 45, price: 8, cycleDays: 30 },
    { name: 'Tinte completo', duration: 120, price: 35, cycleDays: 45 },
    { name: 'Mechas / balayage', duration: 180, price: 60, cycleDays: 75 },
    { name: 'Peinado', duration: 60, price: 15 },
    { name: 'Tratamiento de keratina', duration: 150, price: 50, cycleDays: 90 },
  ],
  persona: 'recepcionista de un salón de belleza',
  rules: ['Para tintes o mechas pregunta si el cabello tiene químicos previos y avisa que el precio final puede variar según el largo.'],
  reactivationMessage: 'Hola {nombre} 💇 ya pasó un mes desde tu último {servicio}. ¿Te reservo un espacio esta semana?',
} satisfies NicheTemplate;
