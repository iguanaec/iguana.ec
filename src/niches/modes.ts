import type { Mode, ModeDefinition } from './types';

const BASE = ['inicio', 'clientes', 'dinero', 'mensajeria', 'asistente', 'ajustes'] as const;
const AGENDA_TOOLS = ['ver_disponibilidad', 'agendar_cita', 'mis_citas', 'reprogramar_cita', 'cancelar_cita', 'unirse_lista_espera'];
const COMMON_TOOLS = ['guardar_dato_cliente', 'pasar_a_humano'];

export const MODES: Record<Mode, ModeDefinition> = {
  citas: {
    label: 'Citas',
    modules: [...BASE, 'calendario', 'lista_espera', 'reactivar'],
    tools: [...AGENDA_TOOLS, ...COMMON_TOOLS],
    vocabulary: { booking: 'cita', bookings: 'citas', customer: 'cliente' },
    rules: [
      'Para agendar: confirma servicio, día y hora; usa ver_disponibilidad y ofrece máximo 3 horarios.',
      'Si no hay cupo, ofrece la lista de espera.',
    ],
  },
  alto_flujo: {
    label: 'Citas de alto flujo',
    modules: [...BASE, 'calendario', 'lista_espera', 'reactivar'],
    tools: [...AGENDA_TOOLS, ...COMMON_TOOLS],
    vocabulary: { booking: 'turno', bookings: 'turnos', customer: 'cliente' },
    rules: [
      'Mucho volumen: sé muy breve. Ofrece de inmediato los 3 turnos más próximos con ver_disponibilidad.',
      'Agenda en cuanto el cliente elija; no hagas preguntas innecesarias.',
    ],
  },
  visitas_leads: {
    label: 'Visitas y prospectos',
    modules: [...BASE, 'calendario', 'leads', 'propiedades'],
    tools: ['buscar_propiedades', 'calificar_lead', 'ver_disponibilidad', 'agendar_visita', 'mis_citas', 'cancelar_cita', ...COMMON_TOOLS],
    vocabulary: { booking: 'visita', bookings: 'visitas', customer: 'prospecto' },
    rules: [
      'Primero entiende qué busca: operación (compra/arriendo), zona, presupuesto, forma de pago y plazo. Registra con calificar_lead.',
      'Muestra máximo 3 opciones de buscar_propiedades y ofrece agendar una visita.',
    ],
  },
  ventas: {
    label: 'Ventas',
    modules: [...BASE, 'catalogo', 'pedidos', 'reactivar'],
    tools: ['buscar_productos', 'crear_pedido', 'estado_pedido', ...COMMON_TOOLS],
    vocabulary: { booking: 'pedido', bookings: 'pedidos', customer: 'cliente' },
    rules: [
      'Recomienda productos solo de buscar_productos, con precio exacto.',
      'Antes de crear_pedido confirma productos, cantidades, total y datos de entrega.',
      'Tras el pedido indica cómo pagar y pide que envíe la foto del comprobante.',
    ],
  },
  pedidos: {
    label: 'Pedidos y delivery',
    modules: [...BASE, 'catalogo', 'pedidos'],
    tools: ['buscar_productos', 'crear_pedido', 'estado_pedido', ...COMMON_TOOLS],
    vocabulary: { booking: 'pedido', bookings: 'pedidos', customer: 'cliente' },
    rules: [
      'Toma el pedido como un mesero: platos, cantidades, extras, dirección y hora de entrega.',
      'Repite el pedido con el total antes de crear_pedido.',
    ],
  },
  servicios_profesionales: {
    label: 'Servicios profesionales',
    modules: [...BASE, 'calendario', 'leads'],
    tools: ['calificar_lead', ...AGENDA_TOOLS, ...COMMON_TOOLS],
    vocabulary: { booking: 'cita', bookings: 'citas', customer: 'cliente' },
    rules: [
      'Entiende el caso en 1-2 preguntas, regístralo con calificar_lead y agenda una cita de evaluación.',
      'No des diagnósticos ni asesoría definitiva por chat.',
    ],
  },
};

/** Herramientas que solo usa el dueño cuando escribe desde su número. */
export const OWNER_TOOLS = ['resumen_negocio', 'agenda_del_dia', 'bloquear_horario', 'registrar_gasto'];
