// CONDUFACIL · Agente "Piloto" — Node + PostgreSQL + Meta Cloud API + Google Calendar
const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');

const E = process.env;
const CAP = +E.CITAS_SIMULTANEAS || 2; // clases simultáneas por hora (= vehículos/instructores disponibles)
const TZ = '-05:00'; // Colombia
const pool = new Pool({
  connectionString: E.DATABASE_URL,
  ssl: /railway\.internal/.test(E.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
});
const q = (s, p) => pool.query(s, p).then((r) => r.rows);
const hoyStr = () => new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10);

const cop = (n) => '$' + Number(n).toLocaleString('es-CO');
const hora12 = (h) => { const n = +String(h).slice(0, 2); return `${n % 12 || 12}:00 ${n < 12 ? 'a.m.' : 'p.m.'}`; };
const fechaBonita = (f) => new Date(f + 'T12:00:00-05:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });

/* ───────── Base de datos ───────── */
async function init() {
  await q(`
  CREATE TABLE IF NOT EXISTS alumnos(id SERIAL PRIMARY KEY, telefono TEXT UNIQUE, nombre TEXT, cedula TEXT, categoria TEXT, estado TEXT DEFAULT 'prospecto', creado TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS instructores(id SERIAL PRIMARY KEY, nombre TEXT, telefono TEXT, categoria TEXT, activo BOOLEAN DEFAULT true);
  CREATE TABLE IF NOT EXISTS vehiculos(id SERIAL PRIMARY KEY, placa TEXT, tipo TEXT, modelo TEXT, instructor_id INT, estado TEXT DEFAULT 'disponible');
  CREATE TABLE IF NOT EXISTS cursos(id SERIAL PRIMARY KEY, nombre TEXT, categoria TEXT, horas_teoricas INT DEFAULT 0, horas_practicas INT DEFAULT 0, precio INT DEFAULT 0, cupos INT DEFAULT 10, inicio DATE, activo BOOLEAN DEFAULT true);
  CREATE TABLE IF NOT EXISTS inscripciones(id SERIAL PRIMARY KEY, alumno_id INT, curso_id INT, horas_hechas INT DEFAULT 0, estado TEXT DEFAULT 'activa', creado TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS citas(id SERIAL PRIMARY KEY, alumno_id INT, telefono TEXT, nombre TEXT, servicio TEXT, fecha DATE, hora TEXT, estado TEXT DEFAULT 'confirmada', event_id TEXT, r24 BOOLEAN DEFAULT false, r2 BOOLEAN DEFAULT false, creado TIMESTAMPTZ DEFAULT now());
  ALTER TABLE citas ADD COLUMN IF NOT EXISTS r24 BOOLEAN DEFAULT false;
  ALTER TABLE citas ADD COLUMN IF NOT EXISTS r2 BOOLEAN DEFAULT false;
  CREATE TABLE IF NOT EXISTS renovaciones(id SERIAL PRIMARY KEY, alumno_id INT, telefono TEXT, nombre TEXT, cedula TEXT, categoria TEXT, vence DATE, estado TEXT DEFAULT 'solicitada', recordado BOOLEAN DEFAULT false, creado TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS servicios(id SERIAL PRIMARY KEY, categoria TEXT, nombre TEXT, precio INT DEFAULT 0, activo BOOLEAN DEFAULT true);
  CREATE TABLE IF NOT EXISTS mensajes(id SERIAL PRIMARY KEY, telefono TEXT, rol TEXT, texto TEXT, creado TIMESTAMPTZ DEFAULT now());`);
  // ⚠️ Precios 2026 de ejemplo (COP): edítalos desde el panel (Servicios y Academia)
  if (!(await q('SELECT 1 FROM cursos LIMIT 1')).length) {
    await q(`INSERT INTO cursos(nombre,categoria,horas_teoricas,horas_practicas,precio,cupos,inicio) VALUES
      ('Licencia A2 · moto','A2',20,10,780000,12,CURRENT_DATE+7),
      ('Licencia B1 · carro particular','B1',20,15,1350000,12,CURRENT_DATE+7),
      ('Combo A2 + B1 · moto y carro','A2+B1',40,25,1990000,8,CURRENT_DATE+7),
      ('Recategorización a C1 · servicio público','C1',10,15,1150000,8,CURRENT_DATE+14),
      ('Recategorización a C2 · bus y buseta','C2',10,20,1650000,6,CURRENT_DATE+14),
      ('Recategorización a B2 · camión rígido','B2',10,20,1550000,6,CURRENT_DATE+14)`);
    await q(`INSERT INTO instructores(nombre,telefono,categoria) VALUES
      ('Carlos Mejía','573000000001','B1'),('Laura Gómez','573000000002','A2'),('Andrés Ruiz','573000000003','C1')`);
    await q(`INSERT INTO vehiculos(placa,tipo,modelo,instructor_id) VALUES
      ('DEM-101','Carro','Chevrolet Spark GT 2022',1),('DEM-102','Carro','Renault Logan 2021',3),('DEM-103','Moto','Honda XR150 2023',2)`);
  }
  if (!(await q('SELECT 1 FROM servicios LIMIT 1')).length) {
    await q(`INSERT INTO servicios(categoria,nombre,precio) VALUES
      ('Clases','Clase práctica de carro (1 hora)',70000),
      ('Clases','Clase práctica de moto (1 hora)',60000),
      ('Clases','Paquete 5 clases prácticas de carro',320000),
      ('Clases','Paquete 10 clases prácticas de carro',600000),
      ('Clases','Refuerzo para examen práctico (3 clases)',200000),
      ('Clases','Alquiler del vehículo para el examen práctico',120000),
      ('Clases','Simulacro del examen teórico',35000),
      ('Renovaciones','Certificado médico de aptitud (examen psicofísico)',95000),
      ('Renovaciones','Renovación licencia A1, A2 o B1 (incluye certificado médico y gestión)',215000),
      ('Renovaciones','Renovación licencia B2, B3, C1, C2 o C3 (incluye certificado médico y gestión)',245000),
      ('Renovaciones','Duplicado de licencia por pérdida o deterioro (gestión)',85000),
      ('Otros','Curso pedagógico para infractores de tránsito',140000),
      ('Otros','Curso de manejo defensivo (4 horas)',120000),
      ('Otros','Gestión de trámites de tránsito (desde)',120000)`);
  }
}

/* ───────── WhatsApp (Meta Cloud API) ───────── */
async function wa(to, body) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${E.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E.WA_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) console.error('WA error', r.status, await r.text());
}

async function waPlantilla(to, name, params) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${E.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E.WA_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: E.WA_TEMPLATE_LANG || 'es' }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] } }),
  });
  if (!r.ok) console.error('WA plantilla', r.status, await r.text());
  return r.ok;
}
const alertar = (t) => (E.ASESOR_TEL ? wa(E.ASESOR_TEL, t).catch(() => {}) : null);

/* ───────── Google Calendar ───────── */
function cal() {
  const raw = (E.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw || !E.GOOGLE_CALENDAR_ID) return null;
  try { // acepta el JSON tal cual o convertido a base64
    const c = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    const auth = new google.auth.JWT(c.client_email, null, String(c.private_key).replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/calendar']);
    return google.calendar({ version: 'v3', auth });
  } catch (e) { console.error('calendar: GOOGLE_SERVICE_ACCOUNT_JSON inválido (' + e.message + ')'); return null; }
}

// Mapa 'AAAA-MM-DDTHH:MM' -> cuántas clases ya hay a esa hora (próximos 14 días)
async function ocupados() {
  const m = {};
  try {
    const c = cal();
    if (c) {
      const r = await c.events.list({
        calendarId: E.GOOGLE_CALENDAR_ID, singleEvents: true, maxResults: 250,
        timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 14 * 864e5).toISOString(),
      });
      for (const ev of r.data.items || []) {
        if (!ev.start.dateTime) continue;
        const k = new Date(new Date(ev.start.dateTime).getTime() - 5 * 36e5).toISOString().slice(0, 16);
        m[k] = (m[k] || 0) + 1;
      }
      return m;
    }
  } catch (e) { console.error('calendar', e.message); }
  for (const r of await q("SELECT fecha::text f, hora FROM citas WHERE estado<>'cancelada' AND fecha>=CURRENT_DATE"))
    m[r.f + 'T' + r.hora] = (m[r.f + 'T' + r.hora] || 0) + 1;
  return m;
}

async function syncEvento(c) {
  const cl = cal();
  if (!cl || !c.event_id) return;
  const em = { confirmada: '✅', pendiente_pago: '⏳' }[c.estado] || '';
  try {
    if (c.estado === 'cancelada') await cl.events.delete({ calendarId: E.GOOGLE_CALENDAR_ID, eventId: c.event_id });
    else await cl.events.patch({ calendarId: E.GOOGLE_CALENDAR_ID, eventId: c.event_id, requestBody: { summary: `${em} ${c.servicio} - ${c.nombre}` } });
  } catch (e) { console.error('sync', e.message); }
}

/* ───────── Agente (Claude) ───────── */
async function sistema(a) {
  const oc = await ocupados();
  const llenos = Object.entries(oc).filter(([, n]) => n >= CAP).map(([k]) => k.replace('T', ' ')).sort().join(', ') || 'ninguno';
  const dia = new Date().toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' });
  const cursos = await q('SELECT nombre,horas_teoricas,horas_practicas,precio,inicio::text inicio FROM cursos WHERE activo ORDER BY id');
  const servs = await q('SELECT categoria,nombre,precio FROM servicios WHERE activo ORDER BY categoria,id');
  return `Eres Piloto, el asistente de WhatsApp de CONDUFACIL, escuela de conducción en Colombia. Hablas cálido, claro y breve, en español, estilo WhatsApp. No uses markdown ni asteriscos; separa ideas con saltos de línea.
Hoy es ${dia} ${hoyStr()} (hora de Colombia). Alumno: ${a.nombre || 'sin nombre aún'}.
PRECIOS 2026 (pesos colombianos).
CURSOS DE LICENCIA NUEVA Y RECATEGORIZACIÓN (academia):
${cursos.map((c) => `- ${c.nombre}: ${cop(c.precio)} (${c.horas_teoricas} h teóricas y ${c.horas_practicas} h prácticas; próximo inicio ${c.inicio || 'por definir'})`).join('\n')}
OTROS SERVICIOS (clases, renovaciones, etc.):
${servs.map((s) => `- [${s.categoria}] ${s.nombre}: ${cop(s.precio)}`).join('\n')}
Los derechos de tránsito, tarifas del RUNT y costos oficiales los cobra cada organismo de tránsito y pueden variar: no están incluidos en estos precios.
No se pide pago ni anticipo para agendar; el pago se coordina directamente en la escuela.
HORARIO de clases y citas: lunes a sábado, de 7:00 a 17:00. Cada cita dura 1 hora y empieza en punto (7:00, 8:00... última 16:00). Domingos no hay.
HORARIOS LLENOS (no los ofrezcas): ${llenos}
AGENDAR (clases, certificado médico, trámites): pide nombre completo, servicio, fecha y hora. Cuando el alumno lo confirme, termina tu mensaje con esta etiqueta exacta (el alumno no la ve):
[[CITA:{"nombre":"...","servicio":"...","fecha":"AAAA-MM-DD","hora":"HH:00"}]]
Avísale que le llegará un recordatorio por WhatsApp antes de su cita.
INSCRIBIR a un curso de la academia: pide nombre completo, cédula y curso. Al confirmar agrega:
[[INSCRIBIR:{"nombre":"...","cedula":"...","curso":"..."}]]
RENOVAR licencia (cualquier categoría): pide nombre completo, cédula, categoría de la licencia y fecha de vencimiento si la sabe (AAAA-MM-DD). Explica que la renovación incluye certificado médico y gestión, y ofrece agendar la cita del certificado médico con la etiqueta CITA (servicio "Certificado médico"). Si la licencia vence en más de 45 días, ofrécele avisarle por WhatsApp un mes antes. Al confirmar agrega:
[[RENOVAR:{"nombre":"...","cedula":"...","categoria":"...","vence":"AAAA-MM-DD o vacío","aviso":false}]]
(aviso:true solo si pidió que le avises antes de que venza). Puedes poner RENOVAR y CITA en el mismo mensaje.
Si piden cambiar o cancelar una cita, o algo médico, legal, de requisitos que no estén aquí, o hablar con una persona, remite al asesor humano: ${E.ASESOR_TEL || '(sin número configurado)'}. Nunca inventes precios ni datos.`;
}

let ultimoError = '';
async function ia(system, messages) {
  ultimoError = '';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: E.MODEL || 'claude-sonnet-5-5', max_tokens: 2000, system, messages }),
  });
  const d = await r.json();
  if (!r.ok) { ultimoError = `Anthropic ${r.status}: ${d.error?.message || 'sin detalle'}`; console.error('IA error', JSON.stringify(d)); }
  // une todos los bloques de texto (el modelo puede devolver otros bloques antes, p. ej. de razonamiento)
  const texto = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!texto && r.ok) { ultimoError = `Claude respondió sin texto (stop_reason: ${d.stop_reason})`; console.error('IA sin texto', JSON.stringify(d).slice(0, 600)); }
  return texto || 'Dame un momento, por favor 🙏';
}

async function crearCita(a, d) {
  const { nombre, servicio = '', fecha, hora } = d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:00$/.test(hora)) return { ok: false, msg: 'Necesito una fecha y una hora en punto para agendar. ¿Cuál prefieres?' };
  const dow = new Date(fecha + 'T12:00:00Z').getUTCDay(), h = +hora.slice(0, 2);
  if (fecha < hoyStr() || dow === 0 || h < 7 || h > 16) return { ok: false, msg: 'Atendemos de lunes a sábado, de 7:00 a.m. a 5:00 p.m. ¿Qué otro día u hora te sirve?' };
  if (((await ocupados())[fecha + 'T' + hora] || 0) >= CAP) return { ok: false, msg: 'Ese horario ya se llenó 😕 ¿Te sirve otra hora u otro día?' };
  const estado = 'confirmada';
  const [c] = await q('INSERT INTO citas(alumno_id,telefono,nombre,servicio,fecha,hora,estado) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [a.id, a.telefono, nombre || a.nombre, servicio, fecha, hora, estado]);
  if (nombre) await q('UPDATE alumnos SET nombre=$1 WHERE id=$2', [nombre, a.id]);
  const cl = cal();
  if (cl) {
    try {
      const s = new Date(`${fecha}T${hora}:00${TZ}`);
      const ev = await cl.events.insert({
        calendarId: E.GOOGLE_CALENDAR_ID,
        requestBody: {
          summary: `${estado === 'confirmada' ? '✅' : '⏳'} ${servicio} - ${c.nombre}`,
          description: 'WhatsApp: ' + a.telefono,
          start: { dateTime: s.toISOString() }, end: { dateTime: new Date(s.getTime() + 36e5).toISOString() },
        },
      });
      await q('UPDATE citas SET event_id=$1 WHERE id=$2', [ev.data.id, c.id]);
    } catch (e) { console.error('calendar insert', e.message); }
  }
  return { ok: true, msg: 'Tu cita quedó confirmada ✅ Te enviaremos un recordatorio por WhatsApp. ¡Te esperamos!' };
}

async function inscribir(a, d) {
  if (!d.curso) return { ok: false, msg: '¿En qué curso te quieres inscribir: B1, A2, C1 o recategorización?' };
  const [c] = await q('SELECT * FROM cursos WHERE activo AND (nombre ILIKE $1 OR categoria ILIKE $1) ORDER BY id LIMIT 1', ['%' + d.curso + '%']);
  if (!c) return { ok: false, msg: 'No encontré ese curso. Tenemos B1, A2, C1 y recategorización, ¿cuál te interesa?' };
  await q('INSERT INTO inscripciones(alumno_id,curso_id) VALUES($1,$2)', [a.id, c.id]);
  await q("UPDATE alumnos SET nombre=COALESCE($1,nombre), cedula=COALESCE($2,cedula), categoria=$3, estado='matriculado' WHERE id=$4",
    [d.nombre || null, d.cedula || null, c.categoria, a.id]);
  await alertar(`🎓 Nueva inscripción: ${d.nombre || a.nombre || a.telefono} en ${c.nombre}. WhatsApp ${a.telefono}.`);
  return { ok: true, msg: `Quedaste inscrito en ${c.nombre} 🚗 Un asesor te contactará para coordinar documentos y la fecha de inicio.` };
}

async function renovar(a, d) {
  const vence = /^\d{4}-\d{2}-\d{2}$/.test(d.vence || '') ? d.vence : null;
  const aviso = d.aviso === true && !!vence;
  await q('INSERT INTO renovaciones(alumno_id,telefono,nombre,cedula,categoria,vence,estado) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [a.id, a.telefono, d.nombre || a.nombre, d.cedula || null, d.categoria || null, vence, aviso ? 'aviso' : 'solicitada']);
  await q('UPDATE alumnos SET nombre=COALESCE($1,nombre), cedula=COALESCE($2,cedula) WHERE id=$3', [d.nombre || null, d.cedula || null, a.id]);
  if (!aviso) await alertar(`🪪 Renovación solicitada: ${d.nombre || a.nombre || a.telefono}, categoría ${d.categoria || '?'}. WhatsApp ${a.telefono}.`);
  return { ok: true, msg: '' };
}

async function procesar(tel, texto, nombre) {
  const [a] = await q(`INSERT INTO alumnos(telefono,nombre) VALUES($1,$2)
    ON CONFLICT(telefono) DO UPDATE SET nombre=COALESCE(alumnos.nombre,EXCLUDED.nombre) RETURNING *`, [tel, nombre || null]);
  await q('INSERT INTO mensajes(telefono,rol,texto) VALUES($1,$2,$3)', [tel, 'user', texto]);
  const h = (await q('SELECT rol,texto FROM mensajes WHERE telefono=$1 ORDER BY id DESC LIMIT 14', [tel])).reverse();
  const msgs = [];
  for (const m of h) {
    const role = m.rol === 'user' ? 'user' : 'assistant';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n' + m.texto;
    else msgs.push({ role, content: m.texto });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  const raw = await ia(await sistema(a), msgs);
  let out = raw.replace(/\[\[[\s\S]*?\]\]/g, '').trim();
  for (const m of raw.matchAll(/\[\[(CITA|INSCRIBIR|RENOVAR):\s*(\{[\s\S]*?\})\s*\]\]/g)) {
    try {
      const d = JSON.parse(m[2]);
      const r = await { CITA: crearCita, INSCRIBIR: inscribir, RENOVAR: renovar }[m[1]](a, d);
      out = r.ok ? (r.msg ? out + '\n\n' + r.msg : out) : r.msg;
    } catch (e) { console.error('etiqueta', e.message); }
  }
  await q('INSERT INTO mensajes(telefono,rol,texto) VALUES($1,$2,$3)', [tel, 'assistant', out]);
  return out;
}

/* ───────── Webhook de Meta ───────── */
const vistos = new Set();
async function entrada(b) {
  for (const en of b.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      if (vistos.has(m.id)) continue;
      vistos.add(m.id); if (vistos.size > 500) vistos.clear();
      const tel = m.from, nombre = v.contacts?.[0]?.profile?.name;
      if (m.type === 'text') await wa(tel, await procesar(tel, m.text.body, nombre));
      else await wa(tel, 'Por ahora solo puedo leer mensajes de texto 🙂 ¿En qué te ayudo?');
    }
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-dash-key', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' });
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});
app.get('/health', (_, res) => res.send('Piloto activo 🚗'));
app.get('/webhook', (req, res) => {
  const { 'hub.mode': m, 'hub.verify_token': t, 'hub.challenge': c } = req.query;
  m === 'subscribe' && t === E.VERIFY_TOKEN ? res.status(200).send(c) : res.sendStatus(403);
});
app.post('/webhook', (req, res) => { res.sendStatus(200); entrada(req.body).catch((e) => console.error('webhook', e)); });

/* ───────── API del panel ───────── */
const wrap = (f) => (req, res) => f(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });
app.use('/api', (req, res, next) => (req.get('x-dash-key') === E.DASH_KEY && E.DASH_KEY ? next() : res.sendStatus(401)));

app.post('/api/simular', wrap(async (req, res) => {
  const { telefono = '573000000000', texto } = req.body;
  const respuesta = await procesar(telefono, texto, 'Demo');
  res.json({ respuesta: ultimoError ? `${respuesta}\n⚠️ ${ultimoError}` : respuesta });
}));
app.get('/api/conversaciones', wrap(async (req, res) => {
  res.json(await q(`SELECT m.id,m.telefono,m.rol,m.texto,m.creado,a.nombre FROM mensajes m LEFT JOIN alumnos a ON a.telefono=m.telefono
    WHERE ($1::boolean OR m.creado>now()-interval '7 days') ORDER BY m.id DESC LIMIT 500`, [req.query.todo === '1']));
}));

const T = {
  alumnos: ['telefono', 'nombre', 'cedula', 'categoria', 'estado'],
  cursos: ['nombre', 'categoria', 'horas_teoricas', 'horas_practicas', 'precio', 'cupos', 'inicio', 'activo'],
  instructores: ['nombre', 'telefono', 'categoria', 'activo'],
  vehiculos: ['placa', 'tipo', 'modelo', 'instructor_id', 'estado'],
  citas: ['estado', 'fecha', 'hora', 'servicio'],
  inscripciones: ['alumno_id', 'curso_id', 'horas_hechas', 'estado'],
  renovaciones: ['nombre', 'telefono', 'cedula', 'categoria', 'vence', 'estado'],
  servicios: ['categoria', 'nombre', 'precio', 'activo'],
};
const SEL = {
  citas: 'SELECT id,alumno_id,telefono,nombre,servicio,fecha::text fecha,hora,estado,event_id,r24,r2 FROM citas ORDER BY citas.fecha DESC,hora DESC LIMIT 300',
  cursos: 'SELECT id,nombre,categoria,horas_teoricas,horas_practicas,precio,cupos,inicio::text inicio,activo FROM cursos ORDER BY id',
  inscripciones: 'SELECT i.*,a.nombre alumno,c.nombre curso,c.horas_practicas FROM inscripciones i LEFT JOIN alumnos a ON a.id=i.alumno_id LEFT JOIN cursos c ON c.id=i.curso_id ORDER BY i.id DESC',
};
SEL.renovaciones = 'SELECT id,alumno_id,telefono,nombre,cedula,categoria,vence::text vence,estado,recordado FROM renovaciones ORDER BY id DESC';
SEL.servicios = 'SELECT * FROM servicios ORDER BY categoria,id';
app.get('/api/:t', wrap(async (req, res) => {
  const t = req.params.t;
  if (!T[t]) return res.sendStatus(404);
  res.json(await q(SEL[t] || `SELECT * FROM ${t} ORDER BY id DESC LIMIT 300`));
}));
app.post('/api/:t', wrap(async (req, res) => {
  const t = req.params.t;
  if (!T[t]) return res.sendStatus(404);
  const cols = T[t].filter((k) => req.body[k] !== undefined && req.body[k] !== '');
  if (!cols.length) return res.sendStatus(400);
  res.json((await q(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, cols.map((k) => req.body[k])))[0]);
}));
app.patch('/api/:t/:id', wrap(async (req, res) => {
  const { t, id } = req.params;
  if (!T[t]) return res.sendStatus(404);
  const cols = T[t].filter((k) => req.body[k] !== undefined);
  if (!cols.length) return res.sendStatus(400);
  const [row] = await q(`UPDATE ${t} SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((k) => req.body[k]), id]);
  if (t === 'citas' && req.body.estado && row) await syncEvento(row);
  res.json(row);
}));

/* ───────── Recordatorios automáticos ───────── */
// Fuera de la ventana de 24 h de WhatsApp solo se puede escribir con una plantilla aprobada (WA_TEMPLATE_*)
async function avisar(tel, plantilla, params, texto) {
  if (!(plantilla && (await waPlantilla(tel, plantilla, params)))) await wa(tel, texto);
  await q('INSERT INTO mensajes(telefono,rol,texto) VALUES($1,$2,$3)', [tel, 'assistant', texto]);
}
async function recordar() {
  try {
    const ahora = Date.now();
    const cs = await q(`SELECT *, fecha::text f FROM citas WHERE estado='confirmada' AND NOT (r24 AND r2)
      AND fecha BETWEEN (now()-interval '1 day')::date AND (now()+interval '3 days')::date`);
    for (const c of cs) {
      const ini = new Date(`${c.f}T${c.hora}:00${TZ}`).getTime(), antes = ini - new Date(c.creado).getTime();
      if (ahora >= ini) { await q('UPDATE citas SET r24=true,r2=true WHERE id=$1', [c.id]); continue; }
      const dos = ahora >= ini - 2 * 36e5;
      if (dos ? c.r2 : c.r24 || ahora < ini - 24 * 36e5) continue;
      await q(dos ? 'UPDATE citas SET r24=true,r2=true WHERE id=$1' : 'UPDATE citas SET r24=true WHERE id=$1', [c.id]);
      if (antes <= (dos ? 2.5 : 25) * 36e5) continue; // cita hecha con muy poca antelación: no tiene sentido recordarla
      const nom = c.nombre || 'alumno';
      await avisar(c.telefono, E.WA_TEMPLATE_RECORDATORIO, [nom, c.servicio, fechaBonita(c.f), hora12(c.hora)],
        `Hola ${nom} 👋 Te recordamos tu cita de ${c.servicio} ${dos ? 'hoy' : 'mañana'} ${fechaBonita(c.f)} a las ${hora12(c.hora)} en CONDUFACIL 🚗. Si no puedes asistir, respóndenos y la reprogramamos.`);
    }
    const rs = await q(`SELECT *, vence::text v FROM renovaciones WHERE estado='aviso' AND NOT recordado AND telefono IS NOT NULL
      AND vence <= (now()+interval '30 days')::date`);
    for (const r of rs) {
      await q("UPDATE renovaciones SET recordado=true, estado='avisado' WHERE id=$1", [r.id]);
      const nom = r.nombre || 'alumno';
      await avisar(r.telefono, E.WA_TEMPLATE_RENOVACION, [nom, r.categoria || 'tu categoría', fechaBonita(r.v)],
        `Hola ${nom} 👋 Tu licencia ${r.categoria ? 'categoría ' + r.categoria + ' ' : ''}vence el ${fechaBonita(r.v)}. En CONDUFACIL te la renovamos con certificado médico y gestión incluidos 🚗 ¿Te agendo una cita?`);
    }
  } catch (e) { console.error('recordatorios', e.message); }
}

const port = E.PORT || 3000;
init().then(() => { app.listen(port, () => console.log('Piloto escuchando en', port)); setTimeout(recordar, 30000); setInterval(recordar, 10 * 60 * 1000); }).catch((e) => { console.error('init', e); process.exit(1); });
