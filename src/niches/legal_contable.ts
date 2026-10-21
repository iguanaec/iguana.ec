import type { NicheTemplate } from './types';

export default {
  id: 'legal_contable', label: 'Abogados / contadores / asesorías', icon: 'briefcase', mode: 'servicios_profesionales',
  description: 'Califica el caso y agenda la consulta inicial.',
  customerFields: [{ key: 'tipo_caso', label: 'Tipo de caso' }, { key: 'empresa', label: 'Empresa' }],
  services: [{ name: 'Consulta inicial', duration: 45, price: 25 }],
  persona: 'asistente de un estudio profesional',
  rules: ['Mantén la confidencialidad: pide solo lo necesario para clasificar el caso.'],
} satisfies NicheTemplate;
