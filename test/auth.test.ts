import { describe, expect, it } from 'vitest';
import { api, registerBusiness, tokenFrom } from './helpers';

describe('acceso y giro bloqueado', () => {
  it('registra un negocio con su giro y devuelve las secciones de ese giro', async () => {
    const { token } = await registerBusiness('peluqueria_canina');
    const me = await api('/api/auth/me', { token });
    expect(me.status).toBe(200);
    expect(me.data.user.role).toBe('admin');
    expect(me.data.business.niche).toBe('peluqueria_canina');
    expect(me.data.business.modules).toContain('calendario');
    expect(me.data.business.modules).not.toContain('propiedades');
    expect(me.data.business.customerFields.map((f: { key: string }) => f.key)).toContain('mascota');
    const services = await api('/api/services', { token });
    expect(services.data.map((s: { name: string }) => s.name)).toContain('Baño');
  });

  it('una inmobiliaria ve propiedades y prospectos, no lista de espera', async () => {
    const { token } = await registerBusiness('inmobiliaria');
    const me = await api('/api/auth/me', { token });
    expect(me.data.business.modules).toEqual(expect.arrayContaining(['propiedades', 'leads']));
    expect((await api('/api/properties', { token })).status).toBe(200);
    expect((await api('/api/waitlist', { token })).status).toBe(403);
    expect((await api('/api/products', { token })).status).toBe(403);
  });

  it('el giro se puede cambiar durante el onboarding y queda bloqueado al terminarlo', async () => {
    const { token } = await registerBusiness('peluqueria');
    expect((await api('/api/onboarding/niche', { method: 'PUT', body: { niche: 'tienda' }, token })).status).toBe(200);
    let me = await api('/api/auth/me', { token });
    expect(me.data.business.mode).toBe('ventas');
    expect(me.data.business.modules).toContain('catalogo');
    expect((await api('/api/onboarding/complete', { method: 'POST', token })).status).toBe(200);
    const change = await api('/api/onboarding/niche', { method: 'PUT', body: { niche: 'barberia' }, token });
    expect(change.status).toBe(403);
    me = await api('/api/auth/me', { token });
    expect(me.data.business.niche).toBe('tienda');
    expect(me.data.business.locked).toBe(true);
  });

  it('el super admin sí puede cambiar el giro y el dueño no entra a Empresas', async () => {
    const { token: owner, businessId } = await registerBusiness('spa');
    await api('/api/onboarding/complete', { method: 'POST', token: owner });
    expect((await api('/api/moderator/companies', { token: owner })).status).toBe(403);

    const setup = await api('/api/setup', { body: { username: 'iguana-admin', password: 'super-clave-123' }, headers: { 'X-Bootstrap-Token': 'boot-token' } });
    expect([200, 409]).toContain(setup.status);
    const login = await api('/api/auth/login', { body: { username: 'iguana-admin', password: 'super-clave-123' } });
    expect(login.status).toBe(200);
    const admin = tokenFrom(login.cookie);
    const list = await api('/api/moderator/companies', { token: admin });
    expect(list.data.companies.some((c: { id: number }) => c.id === businessId)).toBe(true);
    expect((await api(`/api/moderator/companies/${businessId}`, { method: 'PUT', body: { niche: 'gimnasio' }, token: admin })).status).toBe(200);
    const me = await api('/api/auth/me', { token: owner });
    expect(me.data.business.niche).toBe('gimnasio');
    expect(me.data.business.mode).toBe('alto_flujo');
  });

  it('rechaza contraseña incorrecta y bootstrap sin token', async () => {
    const { username } = await registerBusiness('unas');
    expect((await api('/api/auth/login', { body: { username, password: 'mala-clave' } })).status).toBe(401);
    expect((await api('/api/setup', { body: { username: 'x', password: 'yyyyyyyy' } })).status).toBe(403);
    expect((await api('/api/auth/me')).status).toBe(401);
  });

  it('un negocio no puede ver los clientes de otro', async () => {
    const a = await registerBusiness('peluqueria');
    const b = await registerBusiness('peluqueria');
    const created = await api('/api/customers', { body: { first_name: 'Ana', phone: '593999000111' }, token: a.token });
    expect(created.status).toBe(200);
    expect((await api(`/api/customers/${created.data.id}`, { token: b.token })).status).toBe(404);
    expect((await api(`/api/customers/${created.data.id}`, { method: 'DELETE', token: b.token })).status).toBe(200);
    expect((await api(`/api/customers/${created.data.id}`, { token: a.token })).status).toBe(200);
  });

  it('cambio de contraseña obligatorio bloquea el resto de la API', async () => {
    const login = await api('/api/auth/login', { body: { username: 'iguana-admin', password: 'super-clave-123' } });
    const admin = tokenFrom(login.cookie);
    const created = await api('/api/moderator/companies', { body: { name: 'Taller Don Pepe', niche: 'taller', username: `pepe${Date.now()}` }, token: admin });
    expect(created.status).toBe(200);
    const username = created.data.temporaryPassword ? (await api('/api/moderator/companies', { token: admin })).data.companies.find((c: { id: number }) => c.id === created.data.id).owner_username : '';
    const ownerLogin = await api('/api/auth/login', { body: { username, password: created.data.temporaryPassword } });
    expect(ownerLogin.status).toBe(200);
    const owner = tokenFrom(ownerLogin.cookie);
    expect((await api('/api/auth/me', { token: owner })).data.user.mustChangePassword).toBe(true);
    expect((await api('/api/services', { token: owner })).status).toBe(403);
    const changed = await api('/api/auth/change-password', { body: { password: 'nueva-clave-99', confirmation: 'nueva-clave-99' }, token: owner });
    expect(changed.status).toBe(200);
    const fresh = tokenFrom(changed.cookie);
    expect((await api('/api/services', { token: fresh })).status).toBe(200);
    // Las sesiones anteriores quedan invalidadas.
    expect((await api('/api/services', { token: owner })).status).toBe(401);
    // Creado por Iguana: giro ya bloqueado.
    expect((await api('/api/auth/me', { token: fresh })).data.business.locked).toBe(true);
  });
});
