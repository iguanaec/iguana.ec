import type { NicheTemplate } from './types';

export default {
  id: 'consultorio', label: 'Consultorio médico', icon: 'heart', mode: 'citas',
  description: 'Agenda de consultas y controles.',
  customerFields: [{ key: 'seguro', label: 'Seguro médico' }, { key: 'motivo', label: 'Motivo de consulta' }],
  services: [
    { name: 'Consulta', duration: 30, price: 30 },
    { name: 'Control', duration: 20, price: 20, cycleDays: 90 },
  ],
  persona: 'asistente de agenda de un consultorio médico',
  rules: [
    'Nunca des diagnósticos, dosis ni recomendaciones médicas.',
    'Ante síntomas graves (dolor de pecho, dificultad para respirar, sangrado abundante) indica acudir a emergencias y usa pasar_a_humano.',
  ],
} satisfies NicheTemplate;
