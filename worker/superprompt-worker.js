/* ====================================================================
   Worker · Creador de Super Prompt
   © 2026 Ing. Jorge Hugo Pérez Gaona · ICONEialabs. Todos los derechos reservados.
   --------------------------------------------------------------------
   Proxy hacia Gemini con POOL DE CLAVES EN ROTACIÓN.

   Este archivo ES el que corre en producción (Cloudflare Worker
   "superprompt"). Si lo editas aquí, despliégalo;
   si lo editas en el panel, tráelo aquí. No dejes que se separen.

   Las claves NO viven en este archivo: se cargan como secrets de
   Cloudflare (GEMINI_KEY_1 … GEMINI_KEY_8). Nunca llegan al navegador.

   Cómo cargarlas:  Workers → superprompt → Settings → Variables and Secrets
                    → Add → tipo "Secret" → nombre GEMINI_KEY_1
                    → valor: la clave de AI Studio
                    (repite por cada clave; el orden define la rotación)

   Comportamiento:
     · Solo atiende a los orígenes de la lista y exige cabecera Origin.
       El control de abuso de fondo se configura en Cloudflare (reglas de
       límite de peticiones), no en este archivo.
     · Usa la primera clave viva.
     · Si esa clave agota su cuota diaria (o su proyecto se queda sin
       créditos), pasa sola a la siguiente sin que el usuario lo note.
       Google cuenta la cuota POR PROYECTO, no por clave: el pool solo
       suma cuota si cada clave es de un proyecto de Google distinto.
     · Si ninguna clave tiene cupo (agotadas hoy, o inválidas) y al menos
       una se agotó, devuelve quota:true para que la app no reintente en
       vano. Los baches pasajeros llevan transient:true; los fallos que
       necesitan mantenimiento (modelos jubilados, claves inválidas, sin
       claves) no, y la app ofrece entonces la clave propia.
   ==================================================================== */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
/* Corte por modelo: a los 10 s se pasa al siguiente. El peor caso total
   lo acota PRESUPUESTO_MS (25 s), incluida la lectura de la respuesta. */
const TIMEOUT_MS = 10000;
const TIMEOUT_LARGO_MS = 45000;   // búsqueda en Google o respuestas largas (Laboratorio)
/* Presupuesto TOTAL por petición, sumando todos los modelos y claves que se
   prueben. Debe quedar por debajo del corte del navegador (30 s en la app
   principal, 100 s en el Laboratorio) para que la app reciba un mensaje
   honesto en vez de cortar ella y culpar a la conexión. */
const PRESUPUESTO_MS = 25000;
const PRESUPUESTO_LARGO_MS = 90000;

/* Topes de entrada. */
const MAX_USER = 20000;
const MAX_SYSTEM = 8000;
const MAX_CUERPO = 64 * 1024;     // bytes del cuerpo de la petición, antes de leerlo

/* Solo estos modelos; cualquier otro se sustituye por el de por defecto. */
const MODELOS_PERMITIDOS = new Set([
  "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash"
]);

/* Orígenes que pueden usar este proxy. */
const ORIGEN_PRINCIPAL = "https://jorgeicone.github.io";
/* Lista exacta de orígenes. Si otra app de ICONEialabs usa este Worker,
   agrega aquí su origen. jorgeicone.github.io cubre todas las páginas de
   esa cuenta de GitHub Pages: quitarlo cuando ninguna app lo necesite. */
const ORIGENES_EXACTOS = [
  ORIGEN_PRINCIPAL,
  "https://iconeialabs.com",
  "https://www.iconeialabs.com",
  "https://super-prompt.iconeialabs.com"
];

/* Devuelve el origen si está permitido; "" si no. */
function origenPermitido(request) {
  const o = (request.headers.get("Origin") || "").trim().toLowerCase();
  if (!o) return "";                                   // sin Origin: fuera
  if (ORIGENES_EXACTOS.includes(o)) return o;
  return "";
}

/* Modelos. Google jubila modelos y mueve los alias -latest de un modelo a
   otro sin avisar (en septiembre de 2026 flash-lite-latest apuntaba a
   gemini-3.5-flash-lite). Por eso nunca se fija uno solo: si el modelo
   pedido está retirado, devuelve vacío o rechaza la petición, se pasa al
   siguiente de la cadena (hasta 4: el pedido, el último que funcionó y
   los 2 de respaldo, sin repetir). El tiempo total lo acota
   PRESUPUESTO_MS. Antes de cambiar el modelo por defecto, medirlo en vivo. */
const MODELO_POR_DEFECTO = "gemini-flash-lite-latest";
const MODELOS_RESPALDO = ["gemini-flash-lite-latest", "gemini-3.6-flash"];

/* Recuerda el modelo que sí funcionó, para no volver a probar los muertos. */
let modeloVivo = "";

/* Memoria del isolate: recuerda qué claves ya se agotaron HOY para no
   volver a golpearlas en cada petición. Es gratis (no requiere KV) y se
   reinicia al cambiar el día en hora del Pacífico (cuando Google reinicia
   la cuota diaria) o al reciclarse el isolate. */
let agotadasHoy = new Set();
let diaDeLaMemoria = "";

/* Freno básico por IP en memoria del isolate (un salón entero comparte
   la IP del wifi, por eso el número es alto). Complementa, no sustituye,
   las reglas de límite de Cloudflare. */
const LIMITE_POR_IP = 300;         // peticiones…
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
/* Una petición que Google no pudo atender (bache pasajero) no cuenta para
   el freno: si no, una tormenta de 503 de Google expulsaba al salón entero. */
function devolverVisita(ip) {
  const v = visitas.get(ip);
  if (v && v.n > 0) v.n--;
}

function hoyUTC() {
  /* Nombre histórico: devuelve el día en hora del Pacífico, que es cuando
     Google reinicia la cuota diaria de la API de Gemini. */
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
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
/* Tipo de 429. Manda el quotaId de Google (PerMinute / PerDay); solo si no
   viene, se mira si habla de créditos agotados. La palabra "billing" sola
   no basta: Google la menciona también en los límites por minuto. Ante la
   duda, es pasajero: nunca un "vuelve mañana" en falso. */
function tipo429(detalle) {
  const d = (detalle || "").toLowerCase();
  if (/perminute|per minute/.test(d)) return "minuto";
  if (/perday|per day/.test(d)) return "dia";
  if (/credits are depleted|prepayment|credit balance/.test(d)) return "dia";
  return "minuto";
}
function claveQuemada(status, detalle) {
  return status === 429 && tipo429(detalle) === "dia";
}

/* Un 429 por minuto no es la cuota del día: en un salón lleno se pasa solo
   en segundos. No quema la clave y no debe decir "vuelve mañana". */
function limitePorMinuto(status, detalle) {
  return status === 429 && tipo429(detalle) === "minuto";
}

/* ¿La clave no sirve (inválida o sin permiso)? También se rota, pero no es
   cuota: si todas fallan así, "vuelve mañana" sería mentira. */
function claveInvalida(status, detalle) {
  const d = (detalle || "").toLowerCase();
  if (status === 401 || status === 403) return true;      // clave rechazada o sin permiso
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
  /* Primero el que pidió la app (el Laboratorio pide uno más capaz que la
     app principal); luego el último que funcionó y los de respaldo. */
  for (const m of [pedido, modeloVivo, ...MODELOS_RESPALDO]) {
    if (m && MODELOS_PERMITIDOS.has(m) && !lista.includes(m)) lista.push(m);
  }
  return lista.length ? lista : [MODELO_POR_DEFECTO];
}

/* Una llamada a Gemini con UNA clave concreta. */
async function llamarGemini({ key, modelo, system, user, max_tokens, wantJson, temperature, grounded, restante }) {
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: max_tokens || 1500
    }
  };
  /* La temperatura solo viaja si la app la pide: los modelos Gemini 3.x la
     ignoran y Google anuncia que generaciones futuras responderán 400. */
  if (temperature !== undefined) body.generationConfig.temperature = temperature;
  if (system) body.system_instruction = { parts: [{ text: system }] };
  /* La búsqueda en Google y el modo JSON no se pueden pedir a la vez:
     con búsqueda, la app recibe texto y lo parsea ella. */
  if (grounded) body.tools = [{ google_search: {} }];
  else if (wantJson) body.generationConfig.responseMimeType = "application/json";

  /* Un dossier con búsqueda y 4.000 tokens tarda más que un prompt corto:
     10 s lo cortaría siempre. */
  const porModelo = (grounded || (max_tokens || 0) > 2000) ? TIMEOUT_LARGO_MS : TIMEOUT_MS;
  const limite = Math.max(1000, Math.min(porModelo, restante || porModelo));
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), limite);
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
  /* El corte sigue activo mientras se lee la respuesta: si Google manda
     las cabeceras y luego se cuelga, el presupuesto se respeta igual. */
  try {
    return await leerRespuesta(res);
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("La IA tardó demasiado en responder.");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

async function leerRespuesta(res) {
  if (!res.ok) {
    let detalle = "";
    try {
      const j = await res.json();
      /* El tipo de cuota (PerDay / PerMinute) viene en error.details
         (quotaId); el mensaje solo no basta para distinguirlas. */
      detalle = ((j.error && j.error.message) || "") + " " +
        JSON.stringify((j.error && j.error.details) || []);
    } catch (e) {
      detalle = res.statusText || "";
    }
    const err = new Error(detalle || "Error " + res.status);
    err.status = res.status;
    err.detalle = detalle;
    throw err;
  }

  /* Un 200 con cuerpo que no es JSON es un tropiezo del modelo, no de la
     clave: se prueba el siguiente modelo. */
  let data;
  try {
    data = await res.json();
  } catch (e) {
    const err = new Error("La IA devolvió una respuesta ilegible.");
    err.status = 502;
    err.modeloFlojo = true;
    throw err;
  }
  const cand = (data && data.candidates && data.candidates[0]) || {};
  const partes = (cand.content && cand.content.parts) || [];
  const texto = partes.map(p => p.text || "").join("").trim();
  const razon = cand.finishReason || "";

  /* Respuesta vacía. Dos casos muy distintos:
       · SAFETY  → la IA bloqueó el contenido: cambiar de modelo no ayuda.
       · lo demás → este modelo no está rindiendo (le pasa hoy a
         3.5-flash-lite): se prueba el siguiente, sin tocar la clave. */
  if (!texto) {
    if (razon === "SAFETY") {
      const err = new Error("Los filtros de Google frenaron esta petición (a veces pasa con temas sensibles). Prueba a contarlo con otras palabras.");
      err.status = 422;
      err.noRotar = true;
      throw err;
    }
    const err = new Error("La IA no devolvió texto.");
    err.status = 502;
    err.modeloFlojo = true;  // no es culpa de la clave: es del modelo
    throw err;
  }

  const gm = cand.groundingMetadata || {};
  const fuentes = (gm.groundingChunks || []).map(c => c && c.web).filter(w => w && w.uri)
    .slice(0, 12).map(w => ({ titulo: String(w.title || w.uri), url: String(w.uri) }));
  return { texto, truncado: razon === "MAX_TOKENS", fuentes };
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

    /* Punto 2: se exige Origin permitido. Frena a páginas de otros sitios
       y a clientes que no lo envían; quien lo falsifique a mano choca con
       el freno por IP. */
    if (!origen) {
      return json({ error: "Origen no permitido" }, 403, "");
    }

    /* En Cloudflare toda petición real trae CF-Connecting-IP. Sin ella no
       hay forma de aplicar el freno, así que no se atiende. */
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) {
      return json({ error: "Petición inválida" }, 400, origen);
    }
    if (demasiadasPeticiones(ip)) {
      return json({
        error: "Muchas personas están usando la IA desde esta misma red. Espera unos minutos.",
        status: 429,
        rate: true
      }, 429, origen);
    }

    let entrada;
    try {
      const largoDeclarado = parseInt(request.headers.get("content-length") || "0", 10);
      if (largoDeclarado > MAX_CUERPO) {
        return json({ error: "El texto es demasiado largo. Resúmelo e inténtalo de nuevo.", status: 413 }, 413, origen);
      }
      const crudo = await request.text();
      if (crudo.length > MAX_CUERPO) {
        return json({ error: "El texto es demasiado largo. Resúmelo e inténtalo de nuevo.", status: 413 }, 413, origen);
      }
      entrada = JSON.parse(crudo);
    } catch (e) {
      return json({ error: "Petición inválida" }, 400, origen);
    }

    if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) {
      return json({ error: "Petición inválida" }, 400, origen);
    }
    const pedido = typeof entrada.model === "string" ? entrada.model.trim() : "";
    const modelo = MODELOS_PERMITIDOS.has(pedido) ? pedido : MODELO_POR_DEFECTO;
    const system = typeof entrada.system === "string" ? entrada.system : "";
    const user = typeof entrada.user === "string" ? entrada.user.trim() : "";
    if (user.length > MAX_USER || system.length > MAX_SYSTEM) {
      return json({ error: "El texto es demasiado largo. Resúmelo e inténtalo de nuevo.", status: 413 }, 413, origen);
    }
    const max_tokens = Math.min(Math.max(parseInt(entrada.max_tokens, 10) || 1500, 32), 8192);
    const wantJson = !!entrada.json;
    const tempPedida = Number(entrada.temperature);
    const temperature = (entrada.temperature !== undefined && Number.isFinite(tempPedida))
      ? Math.min(Math.max(tempPedida, 0), 1) : undefined;
    /* Búsqueda en Google: si la clave o el modelo no la admiten, se sigue
       sin ella en vez de fallar (la app lo nota porque no llegan fuentes). */
    let usarBusqueda = !!entrada.grounded;

    if (!user) return json({ error: "Falta el texto de la petición." }, 400, origen);

    const largo = usarBusqueda || max_tokens > 2000;
    const fin = Date.now() + (largo ? PRESUPUESTO_LARGO_MS : PRESUPUESTO_MS);
    let sinTiempo = false;

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
    /* Si todas constan agotadas hoy, basta probar una (por si Google ya
       reinició): recorrerlas todas solo alarga la espera. */
    const cadena = frescas.length ? frescas.concat(quemadas) : quemadas.slice(0, 1);

    const modelos = cadenaDeModelos(modelo);
    let modelosMuertos = 0;
    let huboVacio = false;
    let huboBache = false;
    let estadoBache = 503;
    /* Claves quemadas EN ESTA petición. agotadasHoy es memoria del isolate
       y puede traer claves quemadas por peticiones anteriores: decidir
       "se acabó la cuota" con ella convertía un bache en un falso
       "vuelve mañana". Solo es cuota si TODAS se quemaron aquí. */
    let quemadasAhora = 0;
    let invalidasAhora = 0;
    let huboMinuto = false;
    let hubo400 = false;
    /* Un modelo que ya falló no se vuelve a probar con las demás claves:
       si está jubilado o devuelve vacío, no es cuestión de clave, y
       reintentarlo convierte una petición de 1 s en una de 20 s. */
    const descartados = new Set();

    for (let i = 0; i < cadena.length; i++) {
      const id = cadena[i].id;
      const key = cadena[i].key;
      let claveAgotada = false;
      /* La cuota diaria es por proyecto Y por modelo: que un modelo la agote
         no significa que los otros también. Solo se da la clave por
         quemada si agotó la cuota en todos los modelos que se probaron. */
      let cuotaEnEstaClave = 0;
      let probadosEnEstaClave = 0;

      if (descartados.size >= modelos.length || sinTiempo) break;

      for (let j = 0; j < modelos.length && !claveAgotada; j++) {
        const m = modelos[j];
        if (descartados.has(m)) continue;
        const restante = fin - Date.now();
        if (restante < 1500) { sinTiempo = true; break; }
        probadosEnEstaClave++;
        try {
          const r = await llamarGemini({ key, modelo: m, system, user, max_tokens, wantJson, temperature, grounded: usarBusqueda, restante });
          agotadasHoy.delete(id);   // la clave sigue viva
          modeloVivo = m;           // y este modelo también
          return json({ text: r.texto, truncated: r.truncado, sources: r.fuentes }, 200, origen);
        } catch (err) {
          if (usarBusqueda && (err.status === 400 || err.status === 403 || err.status === 429) &&
              !claveInvalida(err.status, err.detalle)) {
            usarBusqueda = false;   // la búsqueda tiene su propia cuota: sin ella
            j--;                    // mismo modelo, misma clave
            probadosEnEstaClave--;  // el reintento no cuenta como otro modelo
            continue;
          }
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
            probadosEnEstaClave--;  // un modelo retirado no dice nada de la cuota de la clave
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
          if (limitePorMinuto(err.status, err.detalle)) {
            huboMinuto = true;      // el límite es por modelo: se prueba el siguiente,
            continue;               // y si no hay más, la siguiente clave
          }
          if (claveInvalida(err.status, err.detalle)) {
            invalidasAhora++;
            claveAgotada = true;    // siguiente clave del pool
            continue;
          }
          if (claveQuemada(err.status, err.detalle)) {
            cuotaEnEstaClave++;
            continue;               // misma clave, siguiente modelo
          }
          /* Error desconocido: no insistimos, y no se filtra el detalle
             crudo de Google (que incluye datos de facturación). */
          if (err.status === 400) {
            /* Un 400 que no es de la clave suele ser un parámetro que ese
               modelo ya no acepta: se prueba el siguiente modelo. */
            descartados.add(m);
            hubo400 = true;
            probadosEnEstaClave--;
            continue;
          }
          return json({ error: "La IA no pudo responder esta vez. Inténtalo de nuevo en un momento.", status: err.status || 500 }, err.status || 500, origen);
        }
      }
      if (!claveAgotada && probadosEnEstaClave && cuotaEnEstaClave === probadosEnEstaClave) {
        agotadasHoy.add(id);        // agotó la cuota en todos sus modelos
        quemadasAhora++;
      }
    }

    const todasQuemadas = quemadasAhora > 0 && quemadasAhora + invalidasAhora >= cadena.length;

    /* Ningún modelo respondió y el motivo fue saturación o timeout:
       aquí sí tiene sentido que la app reintente dentro de un rato. */
    if (huboBache && !todasQuemadas) {
      devolverVisita(ip);
      return json({
        error: "El servicio de IA está saturado en este momento.",
        status: estadoBache,
        transient: true
      }, estadoBache, origen);
    }

    /* Todos los modelos respondieron vacío: no es cuota ni jubilación.
       Decirlo tal cual, para que la app no reintente en vano. */
    if (huboVacio && !todasQuemadas) {
      return json({
        error: "La IA no pudo responder esta vez. Inténtalo de nuevo en un momento.",
        status: 502
      }, 502, origen);
    }

    /* Todos los modelos rechazaron la petición (400 que no es de clave). */
    if (hubo400 && !todasQuemadas) {
      return json({
        error: "La IA no pudo procesar esta petición. Inténtalo de nuevo; si se repite, puedes usar tu propia clave gratis.",
        status: 502
      }, 502, origen);
    }

    /* Si nunca fue cuestión de cuota sino de que TODOS los modelos están
       jubilados, el mensaje de "vuelve mañana" sería mentira. */
    if (modelosMuertos && !todasQuemadas) {
      return json({
        error: "El servicio de IA necesita mantenimiento: los modelos configurados ya no están disponibles.",
        status: 503
      }, 503, origen);
    }

    /* Se acabaron todas las claves. Mensaje honesto + quota:true para que
       la app NO reintente ni mienta diciendo "espera un momento".
       El detalle crudo de Google (incluida la facturación) NO se expone. */
    if (sinTiempo && !todasQuemadas) {
      devolverVisita(ip);
      return json({
        error: "La IA está tardando demasiado en responder. Inténtalo de nuevo en un momento.",
        status: 504,
        transient: true
      }, 504, origen);
    }
    if (huboMinuto && !todasQuemadas) {
      devolverVisita(ip);
      return json({
        error: "Hay mucha demanda en este momento. Espera un minuto e inténtalo de nuevo.",
        status: 503,
        transient: true
      }, 503, origen);
    }
    if (invalidasAhora && !quemadasAhora) {
      return json({
        error: "El servicio de IA necesita mantenimiento: las claves configuradas no son válidas.",
        status: 503
      }, 503, origen);
    }
    if (!todasQuemadas) {
      devolverVisita(ip);
      return json({
        error: "El servicio de IA no respondió. Inténtalo de nuevo en un momento.",
        status: 503,
        transient: true
      }, 503, origen);
    }
    return json({
      error: "Se agotó la cuota gratuita de IA por hoy. Se reinicia mañana.",
      status: 429,
      quota: true
    }, 429, origen);
  }
};
