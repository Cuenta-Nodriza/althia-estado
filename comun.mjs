/**
 * LO COMÚN A LOS DOS VIGILANTES DE ALTHIA (#P32, 13-11-2026): el de GitHub Actions (cada 5 min,
 * scripts/althia-estado/vigilar.mjs) y el Worker de Cloudflare (cada minuto,
 * scripts/althia-vigilante-cf/worker.mjs). Solo JavaScript estándar (fetch, AbortSignal,
 * setTimeout): corre igual en Node 20 y en Workers. Sin direcciones privadas: la del
 * panel llega siempre de fuera (secreto PANEL_SALUD_URL).
 */
/** La revisión programada (Cloud Scheduler, cada 15 min) pasó hace menos de 45 min. Sin el dato (panel antiguo o recién publicado), no juzga. */
export function revisionAlDia(j, ahoraMs = Date.now()) {
  if (j?.ok !== true) return 'el panel no responde bien';
  const ms = Number(j?.ultimaRevisionMs);
  if (!ms) return true;
  const min = Math.round((ahoraMs - ms) / 60_000);
  return min <= MIN_REVISION_PARADA ? true : `la revisión programada lleva ${min} min sin pasar: el panel no puede avisar de nada`;
}

/** Los sitios que se vigilan. Los del panel solo si hay dirección (secreto). */
export function sitiosDe(urlPanel = '') {
  const base = [
    { id: 'web', nombre: 'Web (althiaedu.com)', url: 'https://althiaedu.com/', contiene: 'Althia' },
    { id: 'app', nombre: 'App: servidor de producción', url: 'https://althiaedu.com/api/health', json: (j) => j?.status === 'ok' },
    { id: 'entrada', nombre: 'App: pantalla de entrada', url: 'https://althiaedu.com/app', contiene: '<div id="root"' },
    { id: 'web-guion', nombre: 'althia-edu.com (redirige)', url: 'https://althia-edu.com/', contiene: 'Althia' }
  ];
  if (!/^https:\/\/[a-z0-9.-]+\/[^\s]*$/i.test(urlPanel)) return base;
  return [
    ...base,
    { id: 'panel', nombre: 'Panel del dueño', url: urlPanel, privado: true, json: (j) => j?.ok === true },
    { id: 'revision', nombre: 'Revisión programada del panel', url: urlPanel, privado: true, json: (j, ahoraMs = Date.now()) => revisionAlDia(j, ahoraMs) }
  ];
}

export const MIN_REVISION_PARADA = 45;


export const INTENTOS = 3;
export const ESPERA_MS = 20_000;
export const TIEMPO_MAX_MS = 25_000;

/** ¿La respuesta es buena? Devuelve null si sí, o el motivo en palabras. */
export function juzgar(sitio, status, cuerpo) {
  if (status !== 200) return `respondió HTTP ${status}`;
  if (sitio.json) {
    let j = null;
    try { j = JSON.parse(cuerpo); } catch { return 'la respuesta no es JSON'; }
    const v = sitio.json(j);
    return v === true ? null : typeof v === 'string' ? v : 'responde, pero dice que no está bien';
  }
  if (sitio.contiene && !String(cuerpo).includes(sitio.contiene)) return 'responde, pero la página llega incompleta';
  return null;
}

export function motivoDeError(e, tiempoMaxMs = TIEMPO_MAX_MS) {
  const c = e?.cause?.code || '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `no respondió en ${tiempoMaxMs / 1000} s`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'el dominio no resuelve (DNS)';
  if (/CERT|SSL|TLS/i.test(c + ' ' + (e?.message || ''))) return 'problema con el certificado';
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET') return 'el servidor cortó la conexión';
  return String(c || e?.message || 'error desconocido').slice(0, 120);
}

export async function comprobar(sitio, fetchFn = fetch, esperaMs = ESPERA_MS, intentos = INTENTOS, tiempoMaxMs = TIEMPO_MAX_MS) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i++) {
    const t0 = Date.now();
    try {
      const r = await fetchFn(sitio.url, { redirect: 'follow', headers: { 'User-Agent': 'althia-estado/1.0' }, signal: AbortSignal.timeout(tiempoMaxMs) });
      const cuerpo = await r.text();
      const ms = Date.now() - t0;
      const motivo = juzgar(sitio, r.status, cuerpo);
      if (!motivo) return { ok: true, ms, intentos: i, motivo: null };
      ultimo = { ok: false, ms, intentos: i, motivo };
    } catch (e) {
      ultimo = { ok: false, ms: Date.now() - t0, intentos: i, motivo: motivoDeError(e, tiempoMaxMs) };
    }
    if (i < intentos) await new Promise((ok) => setTimeout(ok, esperaMs));
  }
  return ultimo;
}

/**
 * Qué hacer con un resultado, según el estado anterior. Puro.
 * Devuelve el estado nuevo del sitio y la acción: 'abrir' | 'cerrar' | null.
 */
export function transicion(previo, r, ahoraIso) {
  const antes = previo || { estado: 'arriba', desde: ahoraIso, issue: null, motivo: null };
  if (!r.ok && antes.estado === 'arriba') return { estado: { estado: 'caida', desde: ahoraIso, issue: null, motivo: r.motivo }, accion: 'abrir' };
  if (r.ok && antes.estado === 'caida') return { estado: { estado: 'arriba', desde: ahoraIso, issue: null, motivo: null }, accion: 'cerrar', caidaDesde: antes.desde, issue: antes.issue };
  return { estado: { ...antes, motivo: r.ok ? null : r.motivo }, accion: null };
}

export function duracion(desdeIso, hastaIso) {
  const min = Math.max(0, Math.round((Date.parse(hastaIso) - Date.parse(desdeIso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** El mensaje para el teléfono (ntfy, JSON). Puro. */
export function mensajeNtfy(tema, prioridad, titulo, texto) {
  return { topic: tema, priority: prioridad, title: titulo.slice(0, 120), message: texto.slice(0, 400), tags: [prioridad >= 5 ? 'rotating_light' : prioridad === 4 ? 'warning' : 'white_check_mark'] };
}

export const santoDomingo = (iso) => new Date(Date.parse(iso) - 4 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

/** El vigilante de cada minuto (Cloudflare) da señales de vida cada 10 min; a los 20 sin latido, se ha parado. */
export const MIN_LATIDO_CF = 20;
export function latidoAlDia(j, ahoraMs = Date.now()) {
  if (j?.ok !== true) return 'el vigilante de cada minuto no responde bien';
  const ms = Number(j?.latidoMs);
  if (!ms) return 'el vigilante de cada minuto aún no ha dado señales de vida';
  const min = Math.round((ahoraMs - ms) / 60_000);
  return min <= MIN_LATIDO_CF ? true : `el vigilante de cada minuto lleva ${min} min sin señales de vida`;
}
