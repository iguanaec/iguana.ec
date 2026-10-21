import type { NicheTemplate } from './types';

export default {
  id: 'peluqueria_canina', label: 'Peluquería canina / grooming', icon: 'paw', mode: 'citas',
  description: 'Baño, corte y spa para mascotas, con datos de cada mascota.',
  customerFields: [
    { key: 'mascota', label: 'Nombre de la mascota', required: true },
    { key: 'raza', label: 'Raza', required: true },
    { key: 'tamano', label: 'Tamaño', options: ['Pequeño', 'Mediano', 'Grande', 'Gigante'], required: true },
    { key: 'temperamento', label: 'Temperamento / cuidados' },
  ],
  services: [
    { name: 'Baño', duration: 60, price: 12, cycleDays: 30 },
    { name: 'Baño y corte', duration: 90, price: 20, cycleDays: 45 },
    { name: 'Corte de uñas', duration: 15, price: 4, cycleDays: 30 },
    { name: 'Spa antipulgas', duration: 75, price: 18 },
  ],
  persona: 'asistente de una peluquería canina',
  rules: [
    'Antes de agendar pide nombre, raza y tamaño de la mascota y guárdalos con guardar_dato_cliente.',
    'El precio puede subir para tamaño grande/gigante o pelo muy enredado; avísalo.',
    'Pregunta si necesita recogida a domicilio.',
  ],
  reactivationMessage: 'Hola {nombre} 🐶 {extra.mascota} ya lleva {dias} días desde su último {servicio}. ¿Le agendamos su baño?',
} satisfies NicheTemplate;
