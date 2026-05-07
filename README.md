# WhatsApp Sheet Bot Dashboard

Dashboard local para ejecutar campañas de WhatsApp Web con Puppeteer y actualizar Google Sheets.

## Que hace

- Lee contactos desde Google Sheets.
- Usa WhatsApp Web con una sesion local de Chrome/Puppeteer.
- Ejecuta flujos de primer contacto, follow-up, recordatorios y coordinadores.
- Guarda historial local de corridas.
- Permite pausar, reanudar y detener corridas desde la web.

## Pantallas

- Dashboard general: `http://localhost:3000`
- Coordinadores: `http://localhost:3000/coordinadores.html`

## Configuracion local

1. Instalar dependencias:

```bash
npm install
```

2. Copiar el ejemplo de variables:

```bash
cp .env.example .env
```

3. Completar `.env` con:

- `GOOGLE_SHEET_ID`
- `DETAIL_SHEET_GID`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `WHATSAPP_SESSION_DIR`

4. Colocar el archivo de credenciales de Google en la ruta indicada por `GOOGLE_APPLICATION_CREDENTIALS`.

5. Iniciar:

```bash
npm start
```

## WhatsApp

Este proyecto no usa la API paga de WhatsApp. Usa WhatsApp Web con Puppeteer.

La primera vez hay que escanear el QR. Luego la sesion se guarda localmente en `session/`.

No subir a GitHub:

- `.env`
- `credentials.json`
- `session/`
- `node_modules/`
- `data/history.json`

## GitHub

GitHub sirve para versionar y compartir el codigo. No sirve, por si solo, para alojar el bot completo porque Puppeteer y la sesion de WhatsApp deben correr en una maquina con navegador y sesion local.

Para que sea usable por otros usuarios sin API paga, la arquitectura recomendada es:

- Repo GitHub con el codigo.
- App local o servidor propio por usuario.
- Sesion de WhatsApp guardada localmente en cada maquina.
