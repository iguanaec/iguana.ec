import type { NicheTemplate } from './types';

export default {
  id: 'gimnasio', label: 'Gimnasio / entrenador / clases grupales', icon: 'bolt', mode: 'alto_flujo',
  description: 'Clases con cupos (spinning, yoga, crossfit) y entrenamientos personales.',
  customerFields: [{ key: 'objetivo', label: 'Objetivo' }],
  services: [
    { name: 'Clase de spinning', duration: 45, price: 5, capacity: 15 },
    { name: 'Clase de yoga', duration: 60, price: 6, capacity: 12 },
    { name: 'Entrenamiento personal', duration: 60, price: 20 },
  ],
  persona: 'asistente de un gimnasio',
  rules: ['Motiva sin exagerar. Para clases grupales confirma el cupo y recuerda llegar 10 minutos antes.'],
} satisfies NicheTemplate;
