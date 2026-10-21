export type ChannelKind = 'whatsapp' | 'instagram' | 'messenger';

/** Mensaje entrante normalizado (igual para los tres canales de Meta). Viaja por la Queue. */
export interface InboundEvent {
  kind: ChannelKind;
  /** phone_number_id (WhatsApp), id de cuenta IG o id de página (Messenger). */
  channelExternalId: string;
  /** wa_id / PSID / IGSID del cliente. */
  contactRef: string;
  contactName?: string;
  externalId: string;
  ts: number;
  text?: string;
  media?: { type: 'audio' | 'image' | 'document' | 'video' | 'sticker'; id?: string; url?: string; mime?: string };
  /**
   * Mensaje que el NEGOCIO escribió desde su app (WhatsApp Business en coexistencia,
   * o la bandeja de Meta). Pausa al bot en esa conversación.
   */
  echo?: boolean;
}

export interface ChannelRow {
  id: number;
  business_id: number;
  kind: ChannelKind;
  external_id: string;
  page_id: string | null;
  waba_id: string | null;
  display_name: string;
  token_enc: string;
  coexistence: number;
  status: string;
}
