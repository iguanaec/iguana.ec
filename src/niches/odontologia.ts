import type { NicheTemplate } from './types';

export default {
  id: 'odontologia', label: 'Odontología', icon: 'heart', mode: 'citas',
  description: 'Limpiezas, valoraciones, ortodoncia y urgencias dentales.',
  customerFields: [{ key: 'motivo', label: 'Motivo' }],
  services: [
    { name: 'Valoración', duration: 30, price: 15 },
    { name: 'Limpieza dental', duration: 45, price: 30, cycleDays: 180 },
    { name: 'Control de ortodoncia', duration: 30, price: 35, cycleDays: 30 },
  ],
  persona: 'asistente de un consultorio odontológico',
  rules: ['Si hay dolor fuerte o inflamación, ofrece el primer cupo disponible.', 'No des diagnósticos ni precios de tratamientos que no estén en la lista; ofrece una valoración.'],
  reactivationMessage: 'Hola {nombre} 😁 ya te toca tu {servicio}. ¿Agendamos?',
} satisfies NicheTemplate;
