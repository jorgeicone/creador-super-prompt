# Creador de Super Prompt · ICONEialabs

Creador de Super Prompt: convierte una idea en un prompt profesional en tres pasos, con Google Gemini.
Producción: https://super-prompt.iconeialabs.com/

- `index.html` — la app.
- `worker/superprompt-worker.js` — Cloudflare Worker que guarda las claves de Gemini como secrets y las rota.

Requisito de operación: al menos 2 claves activas, de proyectos de Google distintos
(la cuota de Google es por proyecto, no por clave).

© 2026 Ing. Jorge Hugo Pérez Gaona · ICONEialabs. Todos los derechos reservados (ver `LICENSE`).
Google y Gemini son marcas de Google LLC, ChatGPT de OpenAI, Copilot de Microsoft y Cloudflare de Cloudflare, Inc.; ICONEialabs no está afiliada a ellas.
En `assets/og-image.png`, la descripción y el pie usan la tipografía Inter (licencia SIL Open Font License); el título y el logo «SP» están rasterizados desde el diseño original, sin fuente identificada.
