import { afterEach, describe, expect, it } from 'vitest';
import { api, env, mockGemini, openAllWeek, registerBusiness } from './helpers';

let mock: ReturnType<typeof mockGemini> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

/** Próximo horario libre según la API (lo mismo que vería el agente). */
async function firstSlot(token: string, serviceId: number) {
  for (let i = 1; i < 10; i++) {
    const d = new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10);
    const r = await api(`/api/appointments/availability?service_id=${serviceId}&date=${d}`, { token });
    if (r.data.slots?.length) return String(r.data.slots[0]).slice(0, 16);
  }
  throw new Error('sin horarios');
}

describe('agente por giro', () => {
  it('peluquería canina: guarda la mascota y agenda una cita real', async () => {
    const { token, businessId } = await registerBusiness('peluqueria_canina');
    await openAllWeek(token);
    const services = (await api('/api/services', { token })).data;
    const bath = services.find((s: { name: string }) => s.name === 'Baño');
    const slot = await firstSlot(token, bath.id);
    mock = mockGemini([
      { calls: [{ name: 'guardar_dato_cliente', args: { nombre: 'Lucía', mascota: 'Toby', raza: 'Schnauzer', tamano: 'Pequeño' } }, { name: 'agendar_cita', args: { servicio: 'Baño', fecha_hora: slot } }] },
      { text: '¡Listo Lucía! Toby tiene su baño agendado 🐶' },
    ]);
    const r = await api('/api/agent/test', { body: { message: 'Hola, quiero agendar baño para Toby, schnauzer pequeño' }, token });
    expect(r.status).toBe(200);
    expect(r.data.replies[0]).toContain('Toby');
    // El prompt incluye la persona del giro y solo herramientas del modo citas.
    const first = mock.gemini()[0];
    expect(first.systemInstruction.parts[0].text).toContain('peluquería canina');
    const toolNames = first.tools[0].functionDeclarations.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('agendar_cita');
    expect(toolNames).not.toContain('crear_pedido');
    // Las respuestas de herramientas viajan de vuelta con la firma de pensamiento de Gemini 3.
    expect(mock.gemini()[1].contents.some((c: any) => c.parts.some((p: any) => p.thoughtSignature === 'sig'))).toBe(true);
    const appts = (await api('/api/appointments', { token })).data;
    expect(appts).toHaveLength(1);
    expect(appts[0].origin).toBe('chat');
    const customer = (await api(`/api/customers/${appts[0].customer_id}`, { token })).data;
    expect(customer.extra).toMatchObject({ mascota: 'Toby', raza: 'Schnauzer', tamano: 'Pequeño' });
    const usage = await env.DB.prepare('SELECT calls, booked_cents FROM ai_usage WHERE business_id = ?').bind(businessId).first<{ calls: number; booked_cents: number }>();
    expect(usage).toMatchObject({ calls: 2, booked_cents: 1200 });
  });

  it('si el horario ya está ocupado, devuelve alternativas reales', async () => {
    const { token } = await registerBusiness('peluqueria');
    await openAllWeek(token);
    const svc = (await api('/api/services', { token })).data[0];
    const slot = await firstSlot(token, svc.id);
    expect((await api('/api/appointments', { body: { customer_name: 'Otro Cliente', service_id: svc.id, start_at: slot }, token })).status).toBe(200);
    let toolResult: any;
    mock = mockGemini([
      { calls: [{ name: 'agendar_cita', args: { servicio: svc.name, fecha_hora: slot } }] },
      (body) => { toolResult = body.contents.at(-1).parts[0].functionResponse.response.result; return { text: 'Ese horario se ocupó, ¿te sirve otro?' }; },
    ]);
    await api('/api/agent/test', { body: { message: `Quiero ${svc.name} el ${slot}` }, token });
    expect(toolResult.error).toMatch(/no está disponible/);
    expect(toolResult.alternativas.length).toBeGreaterThan(0);
  });

  it('inmobiliaria: califica al prospecto y busca propiedades', async () => {
    const { token } = await registerBusiness('inmobiliaria');
    await api('/api/properties', { body: { title: 'Departamento en Cumbayá', zone: 'Cumbayá', price: 120000, bedrooms: 2, operation: 'venta', type: 'departamento' }, token });
    await api('/api/properties', { body: { title: 'Casa en Samborondón', zone: 'Samborondón', price: 300000, bedrooms: 4 }, token });
    let found: any;
    mock = mockGemini([
      { calls: [
        { name: 'calificar_lead', args: { interes: 'departamento 2 dormitorios', presupuesto: 130000, zona: 'Cumbayá', forma_pago: 'Crédito hipotecario', plazo: 'este mes' } },
        { name: 'buscar_propiedades', args: { zona: 'Cumbayá', precio_maximo: 130000 } },
      ] },
      (body) => { found = body.contents.at(-1).parts[1].functionResponse.response.result; return { text: 'Tengo una opción en Cumbayá por $120.000. ¿Agendamos visita?' }; },
    ]);
    await api('/api/agent/test', { body: { message: 'Busco depa en Cumbayá hasta 130 mil con crédito, lo necesito este mes' }, token });
    expect(found).toHaveLength(1);
    expect(found[0].titulo).toContain('Cumbayá');
    const leads = (await api('/api/leads', { token })).data;
    expect(leads[0].score).toBeGreaterThanOrEqual(60);
    expect(leads[0].stage).toBe('calificado');
  });

  it('tienda: crea el pedido con precios del catálogo y descuenta stock', async () => {
    const { token } = await registerBusiness('tienda');
    const p = (await api('/api/products', { body: { name: 'Camiseta negra', price: 15, stock: 5, category: 'Ropa' }, token })).data;
    mock = mockGemini([
      { calls: [{ name: 'crear_pedido', args: { items: [{ producto_id: p.id, cantidad: 2 }], direccion: 'Quito centro' } }] },
      { text: 'Pedido listo: 2 camisetas, total $30.' },
    ]);
    await api('/api/agent/test', { body: { message: 'Quiero 2 camisetas negras, envío a Quito centro' }, token });
    const orders = (await api('/api/orders', { token })).data;
    expect(orders[0].total).toBe(30);
    expect((await api('/api/products', { token })).data.find((x: { id: number }) => x.id === p.id).stock).toBe(3);
  });

  it('FAQ del dueño responde gratis, sin llamar a Gemini', async () => {
    const { token, businessId } = await registerBusiness('barberia');
    await api('/api/agent/config', { method: 'PUT', body: { faqs: [{ keywords: ['parqueadero'], answer: 'Sí, tenemos parqueadero gratis 🚗' }] }, token });
    mock = mockGemini([{ text: 'no debería llamarse' }]);
    const r = await api('/api/agent/test', { body: { message: '¿Tienen parqueadero?' }, token });
    expect(r.data.replies[0]).toContain('parqueadero gratis');
    expect(mock.gemini()).toHaveLength(0);
    const usage = await env.DB.prepare('SELECT free_replies FROM ai_usage WHERE business_id = ?').bind(businessId).first<{ free_replies: number }>();
    expect(usage?.free_replies).toBe(1);
  });

  it('presupuesto agotado: pasa a humano y no gasta más', async () => {
    const { token, businessId } = await registerBusiness('spa');
    const day = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    await env.DB.prepare('INSERT INTO ai_usage (business_id, day, cost_micros) VALUES (?, ?, ?)').bind(businessId, day, 10_000_000).run();
    mock = mockGemini([{ text: 'no' }]);
    const r = await api('/api/agent/test', { body: { message: 'Hola, ¿precio del masaje?' }, token });
    expect(r.data.skipped).toBe('budget');
    expect(mock.gemini()).toHaveLength(0);
  });

  it('modo dueño: registra un gasto por chat', async () => {
    const { token } = await registerBusiness('peluqueria');
    mock = mockGemini([
      { calls: [{ name: 'registrar_gasto', args: { monto: 20, descripcion: 'Shampoo', categoria: 'Insumos' } }] },
      { text: 'Registré el gasto de $20 en shampoo.' },
    ]);
    await api('/api/agent/test', { body: { message: 'registra gasto 20 dólares de shampoo', asOwner: true }, token });
    const tools = mock.gemini()[0].tools[0].functionDeclarations.map((t: { name: string }) => t.name);
    expect(tools).toContain('registrar_gasto');
    expect(tools).not.toContain('agendar_cita');
    const expenses = (await api('/api/expenses', { token })).data;
    expect(expenses[0]).toMatchObject({ description: 'Shampoo', amount: 20 });
  });

  it('pasar a humano pausa al bot en esa conversación', async () => {
    const { token } = await registerBusiness('consultorio');
    mock = mockGemini([{ calls: [{ name: 'pasar_a_humano', args: { motivo: 'Dolor de pecho' } }] }, { text: 'Llama al 911. Te paso con el doctor.' }]);
    await api('/api/agent/test', { body: { message: 'tengo dolor de pecho fuerte' }, token });
    const second = await api('/api/agent/test', { body: { message: 'hola?' }, token });
    // El probador reactiva el bot en cada mensaje; en un canal real queda pausado:
    expect(second.status).toBe(200);
    const conv = await env.DB.prepare("SELECT pause_reason FROM conversations WHERE kind = 'test' ORDER BY id DESC LIMIT 1").first<{ pause_reason: string }>();
    expect(conv?.pause_reason).toBe('handoff');
  });
});
