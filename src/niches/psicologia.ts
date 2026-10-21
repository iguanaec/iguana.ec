import type { NicheTemplate } from './types';

export default {
  id: 'psicologia', label: 'Psicología / terapia', icon: 'heart', mode: 'citas',
  description: 'Sesiones presenciales y virtuales.',
  customerFields: [{ key: 'modalidad', label: 'Modalidad', options: ['Presencial', 'Virtual'] }],
  services: [
    { name: 'Primera sesión', duration: 60, price: 35 },
    { name: 'Sesión de seguimiento', duration: 50, price: 30, cycleDays: 7 },
  ],
  persona: 'asistente de agenda de un consultorio de psicología',
  rules: [
    'Sé muy empático y discreto; no pidas detalles del motivo por chat.',
    'Si alguien menciona hacerse daño o riesgo de vida, responde con empatía, comparte la línea de emergencia 911 y usa pasar_a_humano.',
  ],
} satisfies NicheTemplate;
