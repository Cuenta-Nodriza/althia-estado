/**
 * VIGILANTE EXTERNO DE ALTHIA (#P28a, 13-11-2026).
 * ============================================================================
 * Corre en GitHub Actions, en el repositorio PÚBLICO `althia-estado` (en los
 * públicos los minutos de Actions son gratis), cada 5 minutos: fuera de Google,
 * para enterarse aunque se caiga todo Google a la vez (el panel no podría avisar).
 *
 * Por cada sitio: GET, hasta 3 intentos con 20 s entre ellos (un tropiezo no es
 * una caída). Si cae, abre un issue «🔴 Caída: …» (GitHub te avisa por correo y
 * en su app del teléfono, porque eres el dueño del repositorio); al volver, lo
 * cierra diciendo cuánto duró. Guarda el estado y una muestra por hora del tiempo
 * de respuesta en `estado.json`, y el README con la tabla de estado.
 *
 * Además (#P28b): la revisión programada del panel (si lleva > 45 min sin pasar, el panel no
 * puede avisar de nada), la caducidad de los certificados TLS (una vez por hora; aviso a 14
 * días, urgente a 3) y, si el repositorio tiene el secreto NTFY_TEMA, el teléfono del dueño
 * por ntfy: prioridad 5 al caer, 3 al volver. Desde #P32 ese aviso lo da el Worker de Cloudflare de
 * cada minuto; este solo llama al teléfono si ese está parado (o sin montar) y por los certificados.
 *
 * Solo URLs públicas y tiempos: nada de código de Althia ni datos de nadie.
 * Sin dependencias (Node 20: fetch). Las funciones puras se prueban en
 * tests/althiaEstado.test.ts del repositorio de Althia.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { latidoAlDia, sitiosDe, revisionAlDia, juzgar, motivoDeError, comprobar, transicion, duracion, mensajeNtfy, santoDomingo, MIN_REVISION_PARADA, INTENTOS, ESPERA_MS, TIEMPO_MAX_MS } from './comun.mjs';
export { latidoAlDia, sitiosDe, revisionAlDia, juzgar, motivoDeError, comprobar, transicion, duracion, mensajeNtfy, santoDomingo, MIN_REVISION_PARADA, INTENTOS, ESPERA_MS, TIEMPO_MAX_MS };


/**
 * La dirección del panel NO está en este archivo (el repositorio es público): viene del secreto PANEL_SALUD_URL
 * del repositorio. Sin él, el vigilante se salta el panel y su revisión programada. Los sitios «privados» nunca
 * muestran su dirección: ni en los issues, ni en el README, ni en el estado, ni en el registro.
 */
export const URL_PANEL = String(process.env.PANEL_SALUD_URL || '').trim();


/**
 * #P32: el vigilante de cada minuto (Worker de Cloudflare) es el que hace sonar el teléfono. Este, cada 5 min, lo
 * vigila a él (secreto VIGILANTE_CF_URL) y solo llama al teléfono por caídas si ese está parado o no está montado.
 */
export const URL_VIGILANTE_CF = String(process.env.VIGILANTE_CF_URL || '').trim();
export function sitiosConVigilanteCf(urlPanel = URL_PANEL, urlCf = URL_VIGILANTE_CF) {
  const base = sitiosDe(urlPanel);
  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(urlCf)) return base;
  return [...base, { id: 'vigilante-cf', nombre: 'Vigilante de cada minuto (Cloudflare)', url: urlCf, privado: true, json: (j, ahoraMs = Date.now()) => latidoAlDia(j, ahoraMs) }];
}
export const SITIOS = sitiosConVigilanteCf();

/** Los certificados TLS que se vigilan: { clave, host, privado }. El host del panel nunca se muestra: su clave es «panel». */
export function certificadosDe(urlPanel = URL_PANEL) {
  const lista = [{ clave: 'althiaedu.com', host: 'althiaedu.com' }, { clave: 'althia-edu.com', host: 'althia-edu.com' }];
  try {
    const host = new URL(urlPanel).hostname;
    if (host) lista.push({ clave: 'panel', host, privado: true });
  } catch { /* sin dirección del panel */ }
  return lista;
}
export const CERTIFICADOS = certificadosDe();
export const DIAS_CERT_AVISO = 14;
export const DIAS_CERT_URGENTE = 3;
export const MUESTRAS_MAX = 24 * 14; // una por hora, 14 días






/** Fecha de caducidad del certificado TLS de un host (ISO), o null y el motivo. */
export function caducidadCertificado(host, tiempoMs = 15_000) {
  return new Promise((ok) => {
    const s = connect({ host, port: 443, servername: host, timeout: tiempoMs }, () => {
      const c = s.getPeerCertificate();
      s.end();
      ok(c?.valid_to ? { vence: new Date(c.valid_to).toISOString(), motivo: null } : { vence: null, motivo: 'sin certificado' });
    });
    s.on('timeout', () => { s.destroy(); ok({ vence: null, motivo: 'no respondió' }); });
    s.on('error', (e) => ok({ vence: null, motivo: String(e?.code || e?.message || 'error').slice(0, 60) }));
  });
}

/**
 * Qué hacer con un certificado. Puro. `previo`: { nivel: null | 'aviso' | 'urgente', issue }.
 * Abre issue al entrar en 14 días; avisa otra vez (urgente) al entrar en 3; cierra cuando se renueva.
 */
export function transicionCertificado(previo, vence, ahoraMs) {
  const antes = previo || { nivel: null, issue: null, vence: null };
  if (!vence) return { estado: antes, accion: null };
  const dias = Math.floor((Date.parse(vence) - ahoraMs) / 86_400_000);
  const nivel = dias <= DIAS_CERT_URGENTE ? 'urgente' : dias <= DIAS_CERT_AVISO ? 'aviso' : null;
  if (nivel && !antes.nivel) return { estado: { nivel, issue: null, vence }, accion: 'abrir', dias };
  if (nivel === 'urgente' && antes.nivel === 'aviso') return { estado: { ...antes, nivel, vence }, accion: 'subir', dias };
  if (!nivel && antes.nivel) return { estado: { nivel: null, issue: null, vence }, accion: 'cerrar', dias, issue: antes.issue };
  return { estado: { ...antes, vence }, accion: null, dias };
}


async function alTelefono(prioridad, titulo, texto) {
  const tema = String(process.env.NTFY_TEMA || '').trim();
  if (!/^althia-[a-z0-9]{32}$/.test(tema)) return;
  try {
    await fetch(String(process.env.NTFY_SERVIDOR || 'https://ntfy.sh'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mensajeNtfy(tema, prioridad, titulo, texto)), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.log('ntfy no respondió:', String(e?.message || e).slice(0, 80));
  }
}


export function readme(estado, ahoraIso) {
  const filas = SITIOS.map((s) => {
    const e = estado.sitios[s.id];
    const ult = (estado.muestras[s.id] || []).at(-1);
    const marca = !e ? '⚪ sin datos' : e.estado === 'arriba' ? '🟢 funciona' : `🔴 caído desde ${santoDomingo(e.desde)} (${e.motivo || 'sin motivo'})`;
    return `| ${s.nombre} | ${marca} | ${ult ? `${ult.ms} ms` : '—'} |`;
  });
  const certs = Object.entries(estado.certs || {}).map(([h, c]) => `| ${h} | ${c?.vence ? c.vence.slice(0, 10) : '—'} | ${c?.nivel === 'urgente' ? '🔴 a punto de vencer' : c?.nivel === 'aviso' ? '🟠 vence pronto' : '🟢 bien'} |`);
  return `# Estado de Althia\n\nVigilancia externa cada 5 minutos (GitHub Actions). Hora de Santo Domingo. Última revisión: ${santoDomingo(ahoraIso)}.\n\n| Servicio | Estado | Último tiempo de respuesta |\n|---|---|---|\n${filas.join('\n')}\n${certs.length ? `\n| Certificado | Vence | Estado |\n|---|---|---|\n${certs.join('\n')}\n` : ''}\nLas caídas abren un *issue* y se cierran solas al volver. Solo URLs públicas; nada de datos de nadie.\n`;
}

async function github(ruta, metodo, cuerpo) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  if (!r.ok) throw new Error(`GitHub ${metodo} ${ruta}: ${r.status}`);
  return r.json();
}

async function principal() {
  const ahora = new Date().toISOString();
  const estado = existsSync('estado.json') ? JSON.parse(readFileSync('estado.json', 'utf8')) : { sitios: {}, muestras: {}, ultimaMuestra: null };
  const resultados = await Promise.all(SITIOS.map(async (s) => [s, await comprobar(s)]));
  // Si el vigilante de cada minuto está vivo, el teléfono ya lo avisa él: aquí solo issues (salvo que el caído sea él).
  const cf = resultados.find(([s]) => s.id === 'vigilante-cf');
  const cfVivo = Boolean(cf && cf[1].ok);
  let cambio = false;
  for (const [s, r] of resultados) {
    const t = transicion(estado.sitios[s.id], r, ahora);
    if (t.accion === 'abrir') {
      const issue = await github('/issues', 'POST', { title: `🔴 Caída: ${s.nombre}`, body: `**${s.nombre}** no responde bien desde ${santoDomingo(ahora)} (hora de Santo Domingo).\n\n${s.privado ? '' : `- Dirección: ${s.url}\n`}- Motivo: ${r.motivo}\n- Intentos: ${r.intentos}, con ${ESPERA_MS / 1000} s entre ellos.\n\nSe cerrará solo cuando vuelva.` });
      t.estado.issue = issue.number;
      if (!cfVivo || s.id === 'vigilante-cf') await alTelefono(5, `Althia CAÍDA: ${s.nombre}`, `${r.motivo}. Desde ${santoDomingo(ahora)} (Santo Domingo).`);
      cambio = true;
    } else if (t.accion === 'cerrar') {
      if (t.issue) {
        await github(`/issues/${t.issue}/comments`, 'POST', { body: `🟢 Volvió a las ${santoDomingo(ahora)}. Estuvo caído ${duracion(t.caidaDesde, ahora)}.` });
        await github(`/issues/${t.issue}`, 'PATCH', { state: 'closed' });
      }
      if (!cfVivo || s.id === 'vigilante-cf') await alTelefono(3, `Althia: volvió ${s.nombre}`, `Estuvo caído ${duracion(t.caidaDesde, ahora)}.`);
      cambio = true;
    }
    estado.sitios[s.id] = t.estado;
  }
  // Una muestra por hora del tiempo de respuesta (y siempre que algo cambie): base para ver si se va poniendo lento.
  const hora = ahora.slice(0, 13);
  // Certificados: una vez por hora (cambian poco y cada conexión cuesta).
  if (estado.ultimaMuestra !== hora) {
    estado.certs ||= {};
    for (const { clave, host, privado } of CERTIFICADOS) {
      const nombre = privado ? 'el panel' : host; // la dirección del panel no se publica
      const { vence, motivo } = await caducidadCertificado(host);
      const t = transicionCertificado(estado.certs[clave], vence, Date.parse(ahora));
      if (t.accion === 'abrir' || t.accion === 'subir') {
        const urgente = t.estado.nivel === 'urgente';
        const titulo = `${urgente ? '🔴' : '🟠'} Certificado de ${nombre}: vence en ${t.dias} días`;
        const cuerpo = `El certificado TLS de **${nombre}** vence el ${vence.slice(0, 10)}. App Hosting y Cloudflare lo renuevan solos: si no lo han hecho a ${t.dias} días, algo falla (suele ser el DNS). Revisa el dominio en Cloudflare y en App Hosting → Dominios.`;
        if (t.accion === 'abrir') t.estado.issue = (await github('/issues', 'POST', { title: titulo, body: cuerpo })).number;
        else if (t.estado.issue) await github(`/issues/${t.estado.issue}/comments`, 'POST', { body: `${titulo}. ${cuerpo}` });
        await alTelefono(urgente ? 5 : 4, `Althia: certificado de ${nombre}`, `Vence en ${t.dias} días (${vence.slice(0, 10)}).`);
        cambio = true;
      } else if (t.accion === 'cerrar' && t.issue) {
        await github(`/issues/${t.issue}/comments`, 'POST', { body: `🟢 Renovado: ahora vence el ${vence.slice(0, 10)}.` });
        await github(`/issues/${t.issue}`, 'PATCH', { state: 'closed' });
        cambio = true;
      }
      estado.certs[clave] = t.estado;
      if (!vence) console.log(`certificado ${clave}: ${motivo}`);
    }
  }
  if (cambio || estado.ultimaMuestra !== hora) {
    estado.ultimaRevision = ahora;
    for (const [s, r] of resultados) {
      const m = (estado.muestras[s.id] ||= []);
      m.push({ t: ahora, ms: r.ms, ok: r.ok });
      if (m.length > MUESTRAS_MAX) m.splice(0, m.length - MUESTRAS_MAX);
    }
    estado.ultimaMuestra = hora;
    writeFileSync('estado.json', JSON.stringify(estado, null, 1) + '\n');
    writeFileSync('README.md', readme(estado, ahora));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'guardar=1\n');
  }
  for (const [s, r] of resultados) console.log(`${r.ok ? 'OK ' : 'MAL'} ${s.id} ${r.ms} ms${r.motivo ? ` — ${r.motivo}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  principal().catch((e) => { console.error(e); process.exit(1); });
}
