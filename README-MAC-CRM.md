# Bot CRM Jugadores - Mac

Este instructivo es solo para el bot de jugadores criticos del CRM.

## Que descargar

Descargar el proyecto completo desde GitHub. No descargar archivos sueltos.

El bot necesita, como minimo:

- `package.json`
- `package-lock.json`
- `server.js`
- `runner.js`
- `config.js`
- `crm-critical-bot.js`
- `public/crm-bot.html`
- `.env.example`
- `Abrir Bot CRM.command`
- `Detener Bot CRM.command`

No descargar ni compartir:

- `.env`
- `session/`
- `node_modules/`
- `credentials.json`

## Primera vez

1. Instalar Node.js 20 o superior.
2. Instalar Google Chrome.
3. Abrir Terminal en la carpeta del proyecto.
4. Ejecutar `npm install`.
5. Copiar `.env.example` como `.env`.
6. Completar las credenciales CRM en `.env`.
7. Abrir `Abrir Bot CRM.command`.
8. Entrar a `http://localhost:3000/crm-bot.html`.
9. Escanear WhatsApp Web la primera vez.

La sesion de WhatsApp queda guardada localmente en `session/` en esa Mac.
