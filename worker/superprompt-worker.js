/* ====================================================================
   Worker · Creador de Super Prompt
   © Ingeniero Jorge Hugo Pérez — ICONE ialabs. Todos los derechos reservados.
   --------------------------------------------------------------------
   Proxy hacia Gemini con POOL DE CLAVES EN ROTACIÓN.

   Este archivo ES el que corre en producción (Cloudflare Worker
   "superprompt", cuenta 440c8a22…). Si lo editas aquí, despliégalo;
   si lo editas en el panel, tráelo aquí. No dejes que se separen.

   Las claves NO viven en este archivo: se cargan como secrets de
   Cloudflare (GEMINI_KEY_1 … GEMINI_KEY_8). Nunca llegan al navegador.

   Cómo cargarlas:  Workers → superprompt → Settings → Variables and Secrets
                    → Add → tipo "Secret" → nombre GEMINI_KEY_1
                    → valor: la clave de AI Studio
                    (repite por cada clave; el orden define la rotación)

   Comportamiento:
     · Solo atiende a los orígenes de la lista, y EXIGE cabecera Origin:
       sin Origin no se pasa (curl, scripts y bots quedan fuera).
     · Usa la primera clave viva.
     · Si esa clave agota su cuota diaria (o su proyecto se queda sin
       créditos), pasa sola a la siguiente sin que el usuario lo note.
     · Solo cuando TODAS están agotadas devuelve error, con quota:true
       para que la app muestre el mensaje honesto y NO reintente en vano.
   ==================================================================== */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
/* 45 s era un secuestro: con Google lento el usuario miraba el spinner
   tres cuartos de minuto para acabar en error. A los 10 s se corta y se
   prueba el siguiente modelo. Con una cadena de 2 modelos, el peor caso
   posible queda en ~20 s en vez de los 40 s medidos el 2026-08-24. */
const TIMEOUT_MS = 10000;

/* Orígenes que pueden usar este proxy. */
const ORIGEN_PRINCIPAL = "https://jorgeicone.github.io";
const ORIGENES_EXACTOS = [ORIGEN_PRINCIPAL, "https://iconeialabs.com"];
const DOMINIO_PROPIO = ".iconeialabs.com";   // cualquier subdominio https

/* Devuelve el origen si está permitido; "" si no. */
function origenPermitido(request) {
  const o = (request.headers.get("Origin") || "").trim().toLowerCase();
  if (!o) return "";                                   // sin Origin: fuera
  if (ORIGENES_EXACTOS.includes(o)) return o;
  if (o.startsWith("https://") && o.endsWith(DOMINIO_PROPIO)) return o;
  return "";
}

/* Google jubila modelos sin avisar, y a veces algo peor: los deja vivos
   pero devolviendo vacío. Medido contra producción el 2026-08-24:
     · gemini-flash-lite-latest → 0,9 s, responde bien   ← por defecto
     · gemini-3.6-flash         → 1,5 s, gasta tokens pensando (trunca)
     · gemini-3.5-flash-lite    → 200 OK con texto VACÍO
   Por eso nunca se fija UNO solo: si el modelo pedido está muerto o
   devuelve vacío, se pasa al siguiente de la lista. La cadena es corta
   a propósito: cada intento fallido puede costar hasta TIMEOUT_MS, y
   tres intentos convierten un fallo en 45 s de spinner. */
const MODELO_POR_DEFECTO = "gemini-flash-lite-latest";
const MODELOS_RESPALDO = ["gemini-flash-lite-latest", "gemini-3.6-flash"];

/* Modelos que sabemos rotos: pedirlos es gastar un viaje a Google para
   nada. Si el cliente pide uno (una pestaña vieja en caché, por ejemplo)
   se sustituye por el de por defecto sin discutir.
   Para readmitir uno, bórralo de aquí y compruébalo antes en vivo. */
const MODELOS_VETADOS = new Set(["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"]);

/* Recuerda el modelo que sí funcionó, para no volver a probar los muertos. */
let modeloVivo = "";

/* Memoria del isolate: recuerda qué claves ya se agotaron HOY para no
   volver a golpearlas en cada petición. Es gratis (no requiere KV) y se
   reinicia sola al cambiar el día o al reciclarse el isolate. */
let agotadasHoy = new Set();
let diaDeLaMemoria = "";

/* Freno por IP, también en memoria del isolate. No sustituye a un límite
   real con KV o Durable Objects (un atacante repartido entre muchos
   isolates lo diluye), pero encarece el abuso desde una sola máquina. */
const LIMITE_POR_IP = 40;          // peticiones…
const VENTANA_MS = 10 * 60 * 1000; // …por cada 10 minutos
const visitas = new Map();

function demasiadasPeticiones(ip) {
  if (!ip) return false;
  const ahora = Date.now();
  const v = visitas.get(ip);
  if (!v || ahora - v.desde > VENTANA_MS) {
    visitas.set(ip, { desde: ahora, n: 1 });
    if (visitas.size > 5000) visitas.clear();   // techo de memoria
    return false;
  }
  v.n++;
  return v.n > LIMITE_POR_IP;
}

function hoyUTC() {
  return new Date().toISOString().slice(0, 10);
}

function limpiarSiCambioElDia() {
  const d = hoyUTC();
  if (d !== diaDeLaMemoria) {
    diaDeLaMemoria = d;
    agotadasHoy = new Set();
  }
}

/* Lee GEMINI_KEY_1..8 de los secrets, en orden. */
function leerPool(env) {
  const pool = [];
  for (let i = 1; i <= 8; i++) {
    const k = (env["GEMINI_KEY_" + i] || "").trim();
    if (k.length > 10) pool.push({ id: i, key: k });
  }
  return pool;
}

function cors(origen) {
  return {
    "Access-Control-Allow-Origin": origen || ORIGEN_PRINCIPAL,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status, origen) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...cors(origen) }
  });
}

/* ¿Este fallo significa "esta clave está quemada, prueba la siguiente"? */
function claveQuemada(status, detalle) {
  const d = (detalle || "").toLowerCase();
  if (status === 429) return true;                        // cuota diaria o créditos agotados
  if (status === 403) return true;                        // sin permiso sobre la API
  if (status === 400 && /api.?key|api_key_invalid/.test(d)) return true;
  return false;
}

/* ¿Es un bache temporal del servicio? No rota de clave: que reintente la app. */
function esBacheTemporal(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/* ¿El modelo ya no existe? No es culpa de la clave: hay que cambiar de modelo. */
function modeloMuerto(status, detalle) {
  const d = (detalle || "").toLowerCase();
  return status === 404 ||
    d.includes("no longer available") ||
    d.includes("is not found for api version") ||
    d.includes("not supported for generatecontent");
}

/* Modelos a probar, en orden, sin repetir. */
function cadenaDeModelos(pedido) {
  const lista = [];
  for (const m of [modeloVivo, pedido, ...MODELOS_RESPALDO]) {
    if (m && !MODELOS_VETADOS.has(m) && !lista.includes(m)) lista.push(m);
  }
  return lista.length ? lista : [MODELO_POR_DEFECTO];
}

/* Una llamada a Gemini con UNA clave concreta. */
async function llamarGemini({ key, modelo, system, user, max_tokens, wantJson }) {
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: max_tokens || 1500,
      temperature: 0.7
    }
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (wantJson) body.generationConfig.responseMimeType = "application/json";

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_BASE + modelo + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(to);
    const err = new Error("La IA tardó demasiado en responder.");
    err.status = 504;
    throw err;
  }
  clearTimeout(to);

  if (!res.ok) {
    let detalle = "";
    try {
      const j = await res.json();
      detalle = (j.error && j.error.message) || "";
    } catch (e) {
      detalle = res.statusText || "";
    }
    const err = new Error(detalle || "Error " + res.status);
    err.status = res.status;
    err.detalle = detalle;
    throw err;
  }

  const data = await res.json();
  const cand = (data.candidates && data.candidates[0]) || {};
  const partes = (cand.content && cand.content.parts) || [];
  const texto = partes.map(p => p.text || "").join("").trim();
  const razon = cand.finishReason || "";

  /* Respuesta vacía. Dos casos muy distintos:
       · SAFETY  → la IA bloqueó el contenido: cambiar de modelo no ayuda.
       · lo demás → este modelo no está rindiendo (le pasa hoy a
         3.5-flash-lite): se prueba el siguiente, sin tocar la clave. */
  if (!texto) {
    if (razon === "SAFETY") {
      const err = new Error("La IA bloqueó esta petición por sus filtros de contenido. Reformula la idea.");
      err.status = 422;
      err.noRotar = true;
      throw err;
    }
    const err = new Error("La IA no devolvió texto.");
    err.status = 502;
    err.modeloFlojo = true;  // no es culpa de la clave: es del modelo
    throw err;
  }

  return { texto, truncado: razon === "MAX_TOKENS" };
}

export default {
  async fetch(request, env) {
    const origen = origenPermitido(request);

    if (request.method === "OPTIONS") {
      if (!origen) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origen) });
    }
    if (request.method !== "POST") {
      return json({ error: "Método no permitido" }, 405, origen);
    }

    /* Punto 2: se exige Origin permitido. Sin cabecera Origin —curl, un
       script, un servidor, un bot— no se pasa. Origin solo lo mandan los
       navegadores, así que permitir su ausencia era permitirlo todo. */
    if (!origen) {
      return json({ error: "Origen no permitido" }, 403, "");
    }

    if (demasiadasPeticiones(request.headers.get("CF-Connecting-IP"))) {
      return json({
        error: "Demasiadas peticiones desde esta conexión. Espera unos minutos.",
        status: 429,
        rate: true
      }, 429, origen);
    }

    let entrada;
    try {
      entrada = await request.json();
    } catch (e) {
      return json({ error: "Petición inválida" }, 400, origen);
    }

    const modelo = String(entrada.model || MODELO_POR_DEFECTO).trim().replace(/[^a-z0-9.\-]/gi, "");
    const system = entrada.system || "";
    const user = (entrada.user || "").trim();
    const max_tokens = Math.min(Math.max(parseInt(entrada.max_tokens, 10) || 1500, 32), 8192);
    const wantJson = !!entrada.json;

    if (!user) return json({ error: "Falta el texto de la petición." }, 400, origen);

    limpiarSiCambioElDia();

    const pool = leerPool(env);
    if (!pool.length) {
      return json({
        error: "El servicio de IA no tiene ninguna clave configurada.",
        status: 500
      }, 500, origen);
    }

    /* Primero las claves que no sabemos quemadas; las quemadas al final,
       por si Google ya reinició su cuota diaria. */
    const frescas = pool.filter(k => !agotadasHoy.has(k.id));
    const quemadas = pool.filter(k => agotadasHoy.has(k.id));
    const cadena = frescas.concat(quemadas);

    const modelos = cadenaDeModelos(modelo);
    let modelosMuertos = 0;
    let huboVacio = false;
    let huboBache = false;
    let estadoBache = 503;
    /* Un modelo que ya falló no se vuelve a probar con las demás claves:
       si está jubilado o devuelve vacío, no es cuestión de clave, y
       reintentarlo convierte una petición de 1 s en una de 20 s. */
    const descartados = new Set();

    for (let i = 0; i < cadena.length; i++) {
      const id = cadena[i].id;
      const key = cadena[i].key;
      let claveAgotada = false;

      if (descartados.size >= modelos.length) break;

      for (let j = 0; j < modelos.length && !claveAgotada; j++) {
        const m = modelos[j];
        if (descartados.has(m)) continue;
        try {
          const r = await llamarGemini({ key, modelo: m, system, user, max_tokens, wantJson });
          agotadasHoy.delete(id);   // la clave sigue viva
          modeloVivo = m;           // y este modelo también
          return json({ text: r.texto, truncated: r.truncado }, 200, origen);
        } catch (err) {
          if (err.noRotar) {
            return json({ error: err.message, status: err.status }, err.status, origen);
          }
          if (err.modeloFlojo) {
            if (modeloVivo === m) modeloVivo = "";
            descartados.add(m);
            huboVacio = true;
            continue;               // misma clave, siguiente modelo
          }
          if (modeloMuerto(err.status, err.detalle)) {
            if (modeloVivo === m) modeloVivo = "";
            descartados.add(m);
            modelosMuertos++;
            continue;               // misma clave, siguiente modelo
          }
          if (esBacheTemporal(err.status)) {
            /* Bache del servicio (o se agotó el timeout). No es la clave, y
               medido en producción no siempre afecta a todos los modelos:
               antes de rendirse se prueba el siguiente de la cadena. */
            if (modeloVivo === m) modeloVivo = "";
            descartados.add(m);
            huboBache = true;
            estadoBache = err.status;
            continue;
          }
          if (claveQuemada(err.status, err.detalle)) {
            agotadasHoy.add(id);
            claveAgotada = true;    // siguiente clave del pool
            continue;
          }
          /* Error desconocido: no insistimos, y no se filtra el detalle
             crudo de Google (que incluye datos de facturación). */
          return json({ error: "La IA devolvió un error inesperado.", status: err.status || 500 }, err.status || 500, origen);
        }
      }
    }

    /* Ningún modelo respondió y el motivo fue saturación o timeout:
       aquí sí tiene sentido que la app reintente dentro de un rato. */
    if (huboBache && !agotadasHoy.size) {
      return json({
        error: "El servicio de IA está saturado en este momento.",
        status: estadoBache,
        transient: true
      }, estadoBache, origen);
    }

    /* Todos los modelos respondieron vacío: no es cuota ni jubilación.
       Decirlo tal cual, para que la app no reintente en vano. */
    if (huboVacio && !agotadasHoy.size) {
      return json({
        error: "La IA no devolvió texto. Reformula la idea e inténtalo de nuevo.",
        status: 502
      }, 502, origen);
    }

    /* Si nunca fue cuestión de cuota sino de que TODOS los modelos están
       jubilados, el mensaje de "vuelve mañana" sería mentira. */
    if (modelosMuertos && !agotadasHoy.size) {
      return json({
        error: "El servicio de IA necesita mantenimiento: los modelos configurados ya no están disponibles.",
        status: 503
      }, 503, origen);
    }

    /* Se acabaron todas las claves. Mensaje honesto + quota:true para que
       la app NO reintente 4 veces ni mienta diciendo "espera un momento".
       El detalle crudo de Google (incluida la facturación) NO se expone. */
    return json({
      error: "Se agotó la cuota gratuita de IA por hoy. Se reinicia mañana.",
      status: 429,
      quota: true
    }, 429, origen);
  }
};
