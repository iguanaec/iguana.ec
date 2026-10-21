import type { NicheTemplate } from './types';

export default {
  id: 'fotografia', label: 'Fotografía / eventos', icon: 'camera', mode: 'servicios_profesionales',
  description: 'Sesiones, cobertura de eventos y cotizaciones.',
  customerFields: [{ key: 'evento', label: 'Tipo de evento' }, { key: 'fecha_evento', label: 'Fecha del evento' }, { key: 'lugar', label: 'Lugar' }],
  services: [
    { name: 'Sesión de fotos', duration: 60, price: 60 },
    { name: 'Reunión de cotización', duration: 30, price: 0 },
  ],
  persona: 'asistente de un estudio de fotografía',
  rules: ['Para eventos pide fecha, lugar y número de invitados; registra con calificar_lead y agenda una reunión de cotización.'],
} satisfies NicheTemplate;
