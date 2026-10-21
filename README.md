# Iguana API

Servidor del CRM Iguana: un **agente de IA replicable por giro de negocio** (Gemini 3.1 Flash-Lite) que atiende por
**WhatsApp (con coexistencia), Instagram y Messenger**, más la API que usa el panel (`dashboard-iguana`).

Corre en Cloudflare Workers: sin servidores que mantener, escala solo y cuesta centavos por negocio.

## Cómo funciona

```
Meta (WA / IG / Messenger) ──► /webhooks/meta ──► Queue ──► guarda mensaje, transcribe audios, lee comprobantes
                                  (firma HMAC)                │
                                                              ▼
                                         Durable Object por conversación (agrupa ráfagas ~4 s, una respuesta a la vez)
                                                              │
                                    FAQ del dueño (gratis) ◄──┴──► Gemini + herramientas del giro ──► D1 (agenda, pedidos…)
                                                              │
                                                              ▼
                                                   respuesta por el mismo canal
```

- **Giro (nicho)**: plantilla de datos en `src/niches/*.ts` (servicios sugeridos, campos del cliente, reglas, mensaje de reactivación).
  Cada giro usa uno de 6 **modos** (`src/niches/modes.ts`) que definen las secciones del panel y las herramientas del agente:
  `citas`, `alto_flujo`, `visitas_leads`, `ventas`, `pedidos`, `servicios_profesionales`.
- **El giro se elige en el onboarding y queda bloqueado** (`businesses.locked`). Después solo el super admin lo cambia
  (`PUT /api/moderator/companies/:id`). El servidor rechaza las secciones que el giro no tiene (`requireModule`).
- **Ahorro de tokens**: respuestas sin IA para FAQs, prompt corto, solo las herramientas del modo, historial de 8 mensajes
  + resumen rodante, ráfagas agrupadas en una llamada, razonamiento mínimo y presupuesto mensual por negocio.

### Giros incluidos

Peluquería, barbería (alto flujo), uñas, maquillaje/estética, spa, peluquería canina, veterinaria, consultorio médico,
odontología, psicología, gimnasio/clases (alto flujo), academia, inmobiliaria (visitas y prospectos), tienda online (ventas),
restaurante/delivery (pedidos), taller mecánico, abogados/contadores, fotografía/eventos y hospedaje.

**Agregar un giro** = crear `src/niches/mi_giro.ts` con `satisfies NicheTemplate` y sumarlo a `src/niches/index.ts`.

### Lo que lo hace diferente

| | |
| --- | --- |
| Coexistencia inteligente | El dueño sigue usando WhatsApp Business en su celular. Si responde él (`smb_message_echoes`), el bot se calla en esa conversación por `coexistencePauseMinutes`. |
| Notas de voz y fotos | Los audios se transcriben; las fotos de comprobantes se leen y quedan como pago pendiente que el dueño aprueba con un toque (`/api/payment-proofs`). |
| Relleno de huecos | Si alguien cancela, el cupo se ofrece al primero de la lista de espera. |
| Reactivación por ciclo del giro | "Toby lleva 40 días sin baño": lista con mensaje y link `wa.me` listo para enviar desde el celular (sin costo de plantilla). |
| El dueño administra por chat | Desde su número: "¿cuánto vendí hoy?", "bloquea mañana de 3 a 5", "registra gasto $20". |
| Medidor de retorno | `GET /api/agent/usage`: cuánto costó la IA y cuánto agendó/vendió en el mes. |

## Conectar WhatsApp sin entrar a Business Manager

El cliente pulsa **"Conectar mi WhatsApp"** en el panel → se abre la ventana de Meta (Embedded Signup v3 con
`featureType: 'whatsapp_business_app_onboarding'`) → escanea un QR con su app WhatsApp Business → listo.
El panel envía `code`, `waba_id` y `phone_number_id` a `POST /api/channels/whatsapp/embedded-signup` y el servidor:
canjea el código, suscribe la WABA a los webhooks, sincroniza contactos e historial (`smb_app_data`) y guarda el token cifrado.

Instagram y Messenger: botón "Conectar Instagram y Facebook" (Facebook Login for Business) → `POST /api/channels/pages/connect`.

Requisitos de Iguana (una sola vez): app de Meta como **Tech Provider**, con Embedded Signup configurado, permisos
`whatsapp_business_management`, `whatsapp_business_messaging`, `pages_messaging`, `instagram_manage_messages`, y el webhook
apuntando a `https://<tu-worker>/webhooks/meta` con los campos `messages`, `smb_message_echoes`, `smb_app_state_sync` y `history`.
Requisito del cliente: app WhatsApp Business 2.24.17 o superior.

## Poner en marcha

```bash
npm install
npx wrangler d1 create iguana            # copia el database_id a wrangler.toml
npx wrangler kv namespace create CACHE   # copia el id a wrangler.toml
npx wrangler queues create iguana-inbound
npx wrangler queues create iguana-inbound-dlq
npm run db:migrate:remote

# Secretos
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put META_WA_CONFIG_ID       # configuración de Embedded Signup (WhatsApp)
npx wrangler secret put META_PAGES_CONFIG_ID    # configuración de Facebook Login for Business (IG + Messenger)
npx wrangler secret put ENCRYPTION_KEY          # openssl rand -base64 32
npx wrangler secret put BOOTSTRAP_TOKEN

npm run deploy

# Crear el super administrador (una sola vez)
curl -X POST https://<tu-worker>/api/setup -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"una-clave-larga"}'
```

Agrega el dominio del panel a `PANEL_ORIGINS` en `wrangler.toml`.

### Local

```bash
cp .dev.vars.example .dev.vars   # completa ENCRYPTION_KEY y, si quieres respuestas reales, GEMINI_API_KEY
npm run db:migrate:local
npm run dev                      # http://127.0.0.1:8787
```

El panel apunta a `http://127.0.0.1:8787` cuando no está en `*.workers.dev`.

## Pruebas

```bash
npm run typecheck
npm test
```

Las pruebas corren dentro del runtime de Workers (D1, KV, Durable Objects reales en memoria) con Gemini y Meta simulados:
acceso y roles, giro bloqueado, aislamiento entre negocios, agenda real, el agente por giro (canina, inmobiliaria, tienda,
modo dueño), FAQ sin costo, presupuesto agotado, firma de Meta, coexistencia, ráfagas, notas de voz, comprobantes,
lista de espera y reactivación.

## API (resumen)

| Ruta | Para |
| --- | --- |
| `POST /api/auth/register`, `login`, `logout`, `change-password`, `GET /api/auth/me` | Acceso. `me` devuelve el giro, modo, secciones (`modules`), vocabulario y campos del cliente |
| `GET /api/niches` | Catálogo de giros para el onboarding |
| `GET /api/onboarding`, `PUT /api/onboarding/niche`, `POST /api/onboarding/complete` | Onboarding (el giro se bloquea al completar) |
| `/api/settings`, `/api/services`, `/api/ai-documents`, `/api/agent/config`, `/api/agent/usage` | Ajustes del negocio y del agente |
| `/api/appointments` (+ `/availability`, `/:id/payment`, `/cancel`, `/reschedule`, `/status`, `/blocks`) | Agenda |
| `/api/customers`, `/api/expenses`, `/api/income`, `/api/dashboard` | Clientes y dinero |
| `/api/products`, `/api/orders` | Catálogo y pedidos (modos ventas/pedidos) |
| `/api/properties`, `/api/leads` | Propiedades y prospectos (visitas_leads / servicios profesionales) |
| `/api/waitlist`, `/api/reactivation` | Lista de espera y clientes por reactivar |
| `/api/conversations`, `/api/payment-proofs` | Bandeja omnicanal, tomar/devolver al bot, comprobantes |
| `POST /api/agent/test` | Probador del agente (sin canal real; `asOwner: true` prueba el modo dueño) |
| `/api/channels` | Canales conectados y conexión con un botón |
| `/api/moderator/*` | Super admin: empresas, giro, presupuesto de IA, plantillas |
| `/webhooks/meta` | Webhook único de Meta |

Decisiones de arquitectura: [`docs/adr/0001-arquitectura.md`](docs/adr/0001-arquitectura.md).
