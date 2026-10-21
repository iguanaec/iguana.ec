-- Iguana: esquema multi-negocio. Toda tabla de negocio lleva business_id.
-- Fechas/horas: enteros en milisegundos UTC (*_ts) o texto YYYY-MM-DD en la zona del negocio (*_date).
-- Dinero: enteros en centavos (*_cents).

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  mode TEXT NOT NULL,
  modules TEXT NOT NULL,                    -- JSON: secciones del panel habilitadas
  locked INTEGER NOT NULL DEFAULT 0,        -- 1 = giro/modo bloqueado (solo super_admin cambia)
  status TEXT NOT NULL DEFAULT 'onboarding',-- onboarding | active | suspended
  timezone TEXT NOT NULL DEFAULT 'America/Guayaquil',
  settings TEXT NOT NULL DEFAULT '{}',      -- JSON: horario, reglas de reserva, perfil del negocio
  agent_config TEXT NOT NULL DEFAULT '{}',  -- JSON: FAQs, teléfonos del dueño, presupuesto, ajustes de la plantilla
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,                       -- super_admin | admin (dueño) | staff
  phone TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX users_business ON users(business_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                      -- SHA-256 del token (el token nunca se guarda)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price_cents INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  return_cycle_days INTEGER,                -- cada cuánto suele volver el cliente (reactivación)
  capacity INTEGER NOT NULL DEFAULT 1       -- cupos simultáneos (alto flujo)
);
CREATE INDEX services_business ON services(business_id);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  cedula_ruc TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  telegram_username TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '{}',         -- JSON: campos propios del giro (mascota, zona, talla…)
  last_reactivation_ts INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX customers_business ON customers(business_id);
CREATE INDEX customers_phone ON customers(business_id, phone);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  property_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'cita',        -- cita | visita
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | completed | cancelled | no_show
  origin TEXT NOT NULL DEFAULT 'admin',     -- whatsapp | instagram | messenger | chat | admin
  price_cents INTEGER,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX appointments_business_start ON appointments(business_id, start_ts);
CREATE INDEX appointments_customer ON appointments(customer_id);

CREATE TABLE time_blocks (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX time_blocks_business ON time_blocks(business_id, start_ts);

CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  desired_date TEXT,                        -- YYYY-MM-DD o NULL = cualquier día
  status TEXT NOT NULL DEFAULT 'waiting',   -- waiting | offered | booked | expired
  offered_ts INTEGER,                       -- inicio del cupo liberado que se le ofrece
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX waitlist_business ON waitlist(business_id, status);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expense_date TEXT NOT NULL,
  description TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Otros',
  supplier TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'Efectivo',
  bank TEXT NOT NULL DEFAULT '',
  document_type TEXT NOT NULL DEFAULT '',
  document_number TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX expenses_business_date ON expenses(business_id, expense_date);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  stock INTEGER,                            -- NULL = sin control de stock
  image_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX products_business ON products(business_id);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'nuevo',     -- nuevo | confirmado | pagado | enviado | entregado | cancelado
  items TEXT NOT NULL,                      -- JSON [{product_id, name, qty, price_cents}]
  total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  delivery_address TEXT NOT NULL DEFAULT '',
  delivery_note TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);
CREATE INDEX orders_business ON orders(business_id, created_at);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'venta',  -- venta | arriendo
  type TEXT NOT NULL DEFAULT 'casa',
  zone TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  bedrooms INTEGER,
  bathrooms INTEGER,
  area_m2 INTEGER,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disponible' -- disponible | reservada | vendida
);
CREATE INDEX properties_business ON properties(business_id, status);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  conversation_id INTEGER,
  interest TEXT NOT NULL DEFAULT '',
  budget_cents INTEGER,
  zone TEXT NOT NULL DEFAULT '',
  financing TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,         -- 0-100
  stage TEXT NOT NULL DEFAULT 'nuevo',      -- nuevo | calificado | visita | negociacion | ganado | perdido
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX leads_business ON leads(business_id, stage);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id INTEGER,
  order_id INTEGER,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Efectivo',
  source TEXT NOT NULL DEFAULT 'panel',     -- panel | comprobante
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_business ON payments(business_id, created_at);

-- Comprobantes leídos por la IA: quedan pendientes hasta que el dueño los aprueba.
CREATE TABLE payment_proofs (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  message_id INTEGER,
  customer_id INTEGER,
  appointment_id INTEGER,
  order_id INTEGER,
  amount_cents INTEGER,
  bank TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at INTEGER NOT NULL
);
CREATE INDEX payment_proofs_business ON payment_proofs(business_id, status);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- whatsapp | instagram | messenger
  external_id TEXT NOT NULL,                -- phone_number_id | ig user id | page id
  page_id TEXT,                             -- página de Facebook usada para enviar (IG y Messenger)
  waba_id TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL,                  -- token cifrado con AES-GCM
  coexistence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (kind, external_id)
);
CREATE INDEX channels_business ON channels(business_id);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                       -- whatsapp | instagram | messenger | test
  contact_ref TEXT NOT NULL,                -- wa_id | PSID | IGSID
  contact_name TEXT NOT NULL DEFAULT '',
  is_owner INTEGER NOT NULL DEFAULT 0,      -- el que escribe es el dueño (modo administrador por chat)
  stage TEXT NOT NULL DEFAULT 'nuevo',
  bot_paused_until INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT NOT NULL DEFAULT '',    -- owner_reply | handoff | manual | budget
  summary TEXT NOT NULL DEFAULT '',
  summary_upto_id INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_message_ts INTEGER NOT NULL DEFAULT 0,
  last_inbound_ts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (business_id, kind, contact_ref)
);
CREATE INDEX conversations_business ON conversations(business_id, last_message_ts);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                  -- in | out
  author TEXT NOT NULL,                     -- customer | bot | owner | staff
  text TEXT NOT NULL DEFAULT '',
  media_type TEXT,                          -- audio | image | document | video | sticker
  external_id TEXT,
  answered INTEGER NOT NULL DEFAULT 0,      -- mensajes entrantes ya atendidos por el bot
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_external ON messages(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_conversation ON messages(conversation_id, id);

CREATE TABLE ai_documents (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_documents_business ON ai_documents(business_id);

CREATE TABLE ai_usage (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  free_replies INTEGER NOT NULL DEFAULT 0,  -- respuestas resueltas sin llamar a la IA
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,   -- millonésimas de dólar
  booked_cents INTEGER NOT NULL DEFAULT 0,  -- valor agendado/vendido por el agente
  PRIMARY KEY (business_id, day)
);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
