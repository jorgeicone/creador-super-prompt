# Creador de Super Prompt · ICONEialabs

Creador de Super Prompt: convierte una idea en un prompt profesional en tres pasos, con Google Gemini.
Producción: https://super-prompt.iconeialabs.com/

- `index.html` — la app.
- `worker/superprompt-worker.js` — Cloudflare Worker que guarda las claves de Gemini como secrets y las rota.

Antes de usarla con un salón: comprobar que el Worker tenga al menos 2 claves activas
(con una sola, una sala de 30 personas ve con frecuencia «Hay mucha demanda»).

© 2026 Ing. Jorge Hugo Pérez Gaona · ICONEialabs. Todos los derechos reservados (ver `LICENSE`).
Google y Gemini son marcas de Google LLC; ICONEialabs no está afiliada a Google.
En `assets/og-image.png`, la descripción y el pie usan la tipografía Inter (licencia SIL Open Font License); el título y el logo «SP» están rasterizados desde el diseño original, sin fuente identificada.
