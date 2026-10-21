import type { NicheTemplate } from './types';

export default {
  id: 'academia', label: 'Academia / clases / tutorías', icon: 'book', mode: 'citas',
  description: 'Clases particulares, cursos e inscripciones.',
  customerFields: [{ key: 'estudiante', label: 'Nombre del estudiante' }, { key: 'nivel', label: 'Nivel / grado' }],
  services: [
    { name: 'Clase de prueba', duration: 45, price: 0 },
    { name: 'Clase particular', duration: 60, price: 12, cycleDays: 7 },
  ],
  persona: 'asistente de inscripciones de una academia',
  rules: ['Si el estudiante es menor de edad, habla con el representante y pide el nombre del estudiante.', 'Ofrece la clase de prueba a quien no ha venido antes.'],
} satisfies NicheTemplate;
