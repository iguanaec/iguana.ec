import type { NicheTemplate } from './types';

export default {
  id: 'veterinaria', label: 'Veterinaria', icon: 'paw', mode: 'citas',
  description: 'Consultas, vacunas y desparasitación con historial por mascota.',
  customerFields: [
    { key: 'mascota', label: 'Nombre de la mascota', required: true },
    { key: 'especie', label: 'Especie', options: ['Perro', 'Gato', 'Otro'], required: true },
    { key: 'edad', label: 'Edad' },
  ],
  services: [
    { name: 'Consulta general', duration: 30, price: 20 },
    { name: 'Vacunación', duration: 20, price: 15, cycleDays: 365 },
    { name: 'Desparasitación', duration: 15, price: 8, cycleDays: 90 },
  ],
  persona: 'recepcionista de una clínica veterinaria',
  rules: [
    'Si describen una emergencia (no respira, convulsiona, sangrado fuerte, envenenamiento) usa pasar_a_humano de inmediato y da el teléfono del negocio.',
    'No des diagnósticos ni medicación.',
  ],
  reactivationMessage: 'Hola {nombre} 🐾 a {extra.mascota} le toca su {servicio}. ¿Le reservamos cita?',
} satisfies NicheTemplate;
