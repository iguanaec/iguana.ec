import type { NicheTemplate } from './types';

export default {
  id: 'inmobiliaria', label: 'Inmobiliaria / bienes raíces', icon: 'home', mode: 'visitas_leads',
  description: 'Califica prospectos, recomienda propiedades y agenda visitas.',
  customerFields: [
    { key: 'operacion', label: 'Compra o arriendo', options: ['Compra', 'Arriendo'] },
    { key: 'zona', label: 'Zona de interés' },
    { key: 'presupuesto', label: 'Presupuesto' },
    { key: 'financiamiento', label: 'Forma de pago', options: ['Contado', 'Crédito hipotecario', 'BIESS', 'Por definir'] },
  ],
  services: [{ name: 'Visita a propiedad', duration: 45, price: null }],
  persona: 'asesor inmobiliario',
  rules: [
    'Nunca prometas precios negociados, aprobaciones de crédito ni disponibilidad que no confirme buscar_propiedades.',
    'Un buen prospecto tiene presupuesto, forma de pago y plazo menor a 6 meses: dale prioridad y ofrece visita.',
  ],
} satisfies NicheTemplate;
