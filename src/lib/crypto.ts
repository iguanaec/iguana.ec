// Contraseñas (PBKDF2), tokens de sesión, firmas HMAC y cifrado AES-GCM con WebCrypto.
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000; // máximo soportado por Workers

export const toB64 = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomToken(bytes = 32) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(arr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;
  const bits = await pbkdf2(password, fromB64(salt), Number(iter));
  return timingSafeEqual(new Uint8Array(bits), fromB64(hash));
}

export async function hmacSha256Hex(secret: string, body: ArrayBuffer | string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, typeof body === 'string' ? enc.encode(body) : body));
}

async function aesKey(secret: string) {
  const raw = fromB64(secret);
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY debe ser de 32 bytes en base64.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `${toB64(iv)}.${toB64(data)}`;
}

export async function decrypt(secret: string, sealed: string) {
  const [iv, data] = sealed.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(secret), fromB64(data));
  return new TextDecoder().decode(plain);
}
