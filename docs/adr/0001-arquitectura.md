# ADR 0001 — Arquitectura del agente multi-giro

- **Estado:** aceptada
- **Fecha:** 2026-10-21

## Contexto

Iguana necesita un agente de IA que se replique en muchos negocios pequeños de giros distintos (citas, ventas, inmobiliaria,
pedidos…), barato por conversación, que atienda por WhatsApp (con el número que el negocio ya usa), Instagram y Messenger,
y que viva dentro del CRM con usuario/contraseña. El giro define qué ve cada negocio y no lo debe cambiar el cliente.

## Decisión

1. **Cloudflare Workers + D1 + KV + Queues + Durable Objects.** Sin servidores, escala por petición, latencia baja en
   Latinoamérica, costo casi cero en reposo. D1 guarda todo con `business_id` en cada tabla; el acceso pasa por middlewares
   que fijan el negocio de la sesión (`requireBusiness`) y la sección permitida (`requireModule`).
2. **Giro = datos, modo = comportamiento.** Las plantillas (`src/niches`) son objetos sin lógica; los 6 modos definen
   secciones y herramientas. Escalar a más giros no requiere código nuevo.
3. **Gemini 3.1 Flash-Lite por REST con function calling**, sin SDK. Cada negocio recibe solo las herramientas de su modo.
   Las herramientas ejecutan contra D1 con las mismas reglas que el panel (`src/domain`), así el agente nunca inventa
   disponibilidad ni precios.
4. **Webhook → Queue → Durable Object por conversación.** Meta recibe 200 de inmediato; la cola reintenta; el DO serializa
   respuestas y agrupa ráfagas (varios mensajes seguidos = una llamada a Gemini).
5. **Coexistencia de WhatsApp con Embedded Signup v3.** El dueño conserva su app WhatsApp Business; sus respuestas llegan como
   `smb_message_echoes` y pausan al bot en esa conversación.
6. **Giro bloqueado al completar el onboarding** (`businesses.locked`); solo el super admin lo cambia.

## Alternativas consideradas

- *Servidor Node + Postgres*: más control, pero hay que operarlo y paga 24/7 aunque no haya mensajes.
- *Un bot por negocio (despliegue separado)*: aislamiento total, pero imposible de mantener con cientos de negocios.
- *RAG con embeddings para los documentos*: mejor recuperación con documentos grandes; hoy los documentos son pequeños
  (≤ 20.000 caracteres) y la búsqueda por palabras es gratis. Se puede agregar Vectorize después sin cambiar la API.
- *whatsapp-web.js / APIs no oficiales*: más baratas, pero riesgo de bloqueo del número; descartado.

## Consecuencias

- D1 tiene límite de tamaño por base (10 GB). El acceso a datos está concentrado en `src/db.ts`, `src/domain` y las rutas,
  de modo que repartir negocios en varias bases (por región o por grupo) es un cambio acotado cuando haga falta.
- Escribir fuera de la ventana de 24 h exige plantillas aprobadas por Meta; los recordatorios y la reactivación las usan si
  Iguana las configura para el negocio, y si no, el panel ofrece enviar desde el celular del dueño (link `wa.me`).
- Gemini 3 exige devolver las "thought signatures" en las llamadas a herramientas; `agent/run.ts` reenvía el contenido del
  modelo sin modificarlo.
