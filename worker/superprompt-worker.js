/* ====================================================================
   Worker · Creador de Super Prompt
   © Ingeniero Jorge Hugo Pérez — ICONE ialabs. Todos los derechos reservados.
   --------------------------------------------------------------------
   Proxy hacia Gemini con POOL DE CLAVES EN ROTACIÓN.

   Las claves NO viven en este archivo: se cargan como secrets de
   Cloudflare (GEMINI_KEY_1 … GEMINI_KEY_8). Nunca llegan al navegador.

   Cómo cargarlas:  Workers → tu worker → Settings → Variables and Secrets
                    → Add → tipo "Secret" → nombre GEMINI_KEY_1
                    → valor: la clave de AI Studio
                    (repite por cada clave; el orden define la rotación)

   Comportamiento:
     · Usa la primera clave viva.
     · Si esa clave agota su cuota diaria (o su proyecto se queda sin
       créditos), pasa sola a la siguiente sin que el usuario lo note.
     · Solo cuando TODAS están agotadas devuelve error, con quota:true
       para que la app muestre el mensaje honesto y NO reintente en vano.
   ==================================================================== */

const ORIGEN_PERMITIDO = "https://jorgeicone.github.io";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const TIMEOUT_MS = 45000;

/* Google jubila modelos sin avisar: gemini-2.5-flash-lite dejó de servirse a
   proyectos nuevos y tumbó la app entera. Por eso ya no se fija UNO solo:
   si el modelo pedido está muerto, se pasa al siguiente de la lista.
   Medido en producción: 3.5-flash-lite ≈0,8 s; flash-lite-latest 3-8 s. */
const MODELO_POR_DEFECTO = "gemini-3.5-flash-lite";
const MODELOS_RESPALDO = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

/* Recuerda el modelo que sí funcionó, para no volver a probar los muertos. */
let modeloVivo = "";

/* Memoria del isolate: recuerda qué claves ya se agotaron HOY para no
   volver a golpearlas en cada petición. Es gratis (no requiere KV) y se
   reinicia sola al cambiar el día o al reciclarse el isolate. */
let agotadasHoy = new Set();
let diaDeLaMemoria = "";

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
    "Access-Control-Allow-Origin": origen || ORIGEN_PERMITIDO,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400"
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
    if (m && !lista.includes(m)) lista.push(m);
  }
  return lista;
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

  if (!texto) {
    const err = new Error(
      razon === "SAFETY"
        ? "La IA bloqueó esta petición por sus filtros de contenido. Reformula la idea."
        : "La IA no devolvió texto."
    );
    err.status = razon === "SAFETY" ? 422 : 502;
    err.noRotar = true;      // no es culpa de la clave
    throw err;
  }

  return { texto, truncado: razon === "MAX_TOKENS" };
}

export default {
  async fetch(request, env) {
    const origen = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origen) });
    }
    if (request.method !== "POST") {
      return json({ error: "Método no permitido" }, 405, origen);
    }

    /* NOTA: el control de origen y el límite por IP se endurecen en el
       punto 2. Aquí se conserva el comportamiento actual a propósito. */
    if (origen && origen !== ORIGEN_PERMITIDO) {
      return json({ error: "Origen no permitido" }, 403, origen);
    }

    let entrada;
    try {
      entrada = await request.json();
    } catch (e) {
      return json({ error: "Petición inválida" }, 400, origen);
    }

    const modelo = (entrada.model || MODELO_POR_DEFECTO).trim();
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

    for (let i = 0; i < cadena.length; i++) {
      const id = cadena[i].id;
      const key = cadena[i].key;
      let claveAgotada = false;

      for (let j = 0; j < modelos.length && !claveAgotada; j++) {
        const m = modelos[j];
        try {
          const r = await llamarGemini({ key, modelo: m, system, user, max_tokens, wantJson });
          agotadasHoy.delete(id);   // la clave sigue viva
          modeloVivo = m;           // y este modelo también
          return json({ text: r.texto, truncated: r.truncado }, 200, origen);
        } catch (err) {
          if (err.noRotar) {
            return json({ error: err.message, status: err.status }, err.status, origen);
          }
          if (modeloMuerto(err.status, err.detalle)) {
            if (modeloVivo === m) modeloVivo = "";
            modelosMuertos++;
            continue;               // mismo clave, siguiente modelo
          }
          if (esBacheTemporal(err.status)) {
            // bache del servicio, no de la clave: que la app reintente
            return json({
              error: "El servicio de IA está saturado en este momento.",
              status: err.status,
              transient: true
            }, err.status, origen);
          }
          if (claveQuemada(err.status, err.detalle)) {
            agotadasHoy.add(id);
            claveAgotada = true;    // siguiente clave del pool
            continue;
          }
          // error desconocido: no insistimos
          return json({ error: err.message, status: err.status || 500 }, err.status || 500, origen);
        }
      }
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
