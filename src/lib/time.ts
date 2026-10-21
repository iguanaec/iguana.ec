// Utilidades de zona horaria sin dependencias (Intl).
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
};
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = (n: number) => String(n).padStart(2, '0');

export function localParts(ts: number, tz: string) {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(new Date(ts))) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS[p.weekday],
  };
}

/** Minutos que la zona está adelantada respecto a UTC en ese instante (Ecuador: -300). */
export function offsetMinutes(ts: number, tz: string) {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}

/** 'YYYY-MM-DD' + 'HH:MM' en la zona del negocio → milisegundos UTC. */
export function localToUtc(date: string, time: string, tz: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetMinutes(guess, tz) * 60000;
  ts = guess - offsetMinutes(ts, tz) * 60000;
  return ts;
}

export function localDate(ts: number, tz: string) {
  const p = localParts(ts, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(ts: number, tz: string) {
  const p = localParts(ts, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** ISO con el desfase del negocio, como lo espera el panel: 2026-10-21T09:30:00.000-05:00 */
export function toLocalIso(ts: number, tz: string) {
  const off = offsetMinutes(ts, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${localDate(ts, tz)}T${localTime(ts, tz)}:00.000${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Acepta ISO con desfase, o fecha/hora local sin desfase (se interpreta en la zona del negocio). */
export function parseDateTime(value: string, tz: string) {
  const v = String(value || '').trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    const ts = Date.parse(v);
    if (!Number.isNaN(ts)) return ts;
  }
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return localToUtc(m[1], m[2], tz);
  return NaN;
}

export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOf(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function humanDateTime(ts: number, tz: string) {
  const date = localDate(ts, tz);
  const [, m, d] = date.split('-').map(Number);
  return `${DAY_NAMES[weekdayOf(date)]} ${d}/${m} a las ${localTime(ts, tz)}`;
}
