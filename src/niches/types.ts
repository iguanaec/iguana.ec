// Una plantilla de giro es solo datos: agregar un giro nuevo = agregar un archivo en src/niches/.

export type Mode = 'citas' | 'alto_flujo' | 'visitas_leads' | 'ventas' | 'pedidos' | 'servicios_profesionales';

export type Module =
  | 'inicio' | 'calendario' | 'clientes' | 'dinero' | 'mensajeria' | 'asistente' | 'ajustes'
  | 'lista_espera' | 'catalogo' | 'pedidos' | 'propiedades' | 'leads' | 'reactivar';

export interface CustomerField {
  key: string;
  label: string;
  options?: string[];
  /** Si true, el agente lo pide antes de agendar o vender. */
  required?: boolean;
}

export interface ServiceTemplate {
  name: string;
  description?: string;
  duration: number;
  price: number | null;
  /** Días típicos para que el cliente vuelva (reactivación automática). */
  cycleDays?: number;
  capacity?: number;
}

export interface ProductTemplate {
  name: string;
  price: number;
  category?: string;
  description?: string;
}

export interface Faq {
  /** Palabras que disparan la respuesta sin llamar a la IA. */
  keywords: string[];
  answer: string;
}

export interface NicheTemplate {
  id: string;
  label: string;
  description: string;
  icon: string;
  mode: Mode;
  /** Módulos extra además de los del modo. */
  extraModules?: Module[];
  customerFields: CustomerField[];
  services?: ServiceTemplate[];
  products?: ProductTemplate[];
  /** Quién es el agente en este giro (una línea). */
  persona: string;
  /** Reglas del giro, cortas: cada token cuenta. */
  rules: string[];
  faqs?: Faq[];
  /** Mensaje de reactivación; {nombre}, {servicio}, {dias}, {extra.mascota}… */
  reactivationMessage?: string;
}

export interface ModeDefinition {
  label: string;
  modules: Module[];
  tools: string[];
  vocabulary: { booking: string; bookings: string; customer: string };
  rules: string[];
}
