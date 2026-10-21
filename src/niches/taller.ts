import type { NicheTemplate } from './types';

export default {
  id: 'taller', label: 'Taller mecánico / lavadora de autos', icon: 'wrench', mode: 'servicios_profesionales',
  description: 'Diagnósticos, mantenimientos y turnos de lavado.',
  customerFields: [{ key: 'vehiculo', label: 'Marca y modelo', required: true }, { key: 'placa', label: 'Placa' }, { key: 'kilometraje', label: 'Kilometraje' }],
  services: [
    { name: 'Diagnóstico', duration: 60, price: 15 },
    { name: 'Cambio de aceite', duration: 45, price: 35, cycleDays: 120 },
    { name: 'Lavado completo', duration: 60, price: 10, cycleDays: 21, capacity: 2 },
  ],
  persona: 'asesor de servicio de un taller automotriz',
  rules: ['Pide marca, modelo y año del vehículo. No cotices reparaciones sin diagnóstico.'],
  reactivationMessage: 'Hola {nombre} 🚗 tu {extra.vehiculo} ya está para su {servicio}. ¿Te agendo?',
} satisfies NicheTemplate;
