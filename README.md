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
- Bot CRM criticos: `http://localhost:3000/crm-bot.html`

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

### Abrir y detener con doble click en macOS

Tambien podes usar estos archivos desde Finder:

- `Abrir Bot Coordinadores.command`: instala dependencias si faltan, levanta el servidor y abre `http://localhost:3000/coordinadores.html`.
- `Abrir Bot CRM.command`: usa el mismo servidor y abre `http://localhost:3000/crm-bot.html`.
- `Detener Bot Coordinadores.command`: pide al dashboard que frene corridas activas, apaga el scheduler de recordatorios y cierra el servidor.
- `Detener Bot CRM.command`: hace lo mismo, pero con nombre separado para el bot de jugadores.

## WhatsApp

Este proyecto no usa la API paga de WhatsApp. Usa WhatsApp Web con Puppeteer.

La primera vez hay que escanear el QR. Luego la sesion se guarda localmente en `session/`.

## Bot CRM jugadores criticos

Tambien hay un bot local para `https://crm-gloouds.vercel.app/jugadores`.

Selecciona jugadores con:

- urgencia `Critico`
- `trazabilidad = true`
- sin responsable asignado

Para menores, intenta escribirle al tutor y al jugador. Para mayores, solo al jugador. Antes de abrir WhatsApp, toma el lote de casos en el CRM con el usuario logueado y pasa el estado a `En gestion` si estaba vacio o `Nuevo`. Despues de cada WhatsApp enviado registra intento/actividad en el CRM con resultado `En espera de respuesta`.

La pantalla web esta en `http://localhost:3000/crm-bot.html`. El login es solo por nombre: Ivo Unzaga, Santiago Muller o Facundo Lugo. El backend usa las credenciales CRM de la persona elegida en la pantalla y asigna el caso a ese mismo usuario.

Primero completar en `.env`:

```bash
CRM_IVO_USER=ivo
CRM_IVO_PASSWORD=tu_clave_ivo
CRM_SANTIAGO_USER=santiago
CRM_SANTIAGO_PASSWORD=tu_clave_santiago
CRM_FACUNDO_USER=facundo
CRM_FACUNDO_PASSWORD=tu_clave_facundo
CRM_OPERATOR_NAME=Ivo Unzaga
CRM_DRY_RUN=true
CRM_AFTER_SEND_SETTLE_MS=15000
CRM_BETWEEN_CONTACTS_MS=90000
CRM_SEND_DELAY_MS=90000
CRM_ALLOWED_ORIGINS=https://tu-app.vercel.app
```

Probar sin mandar mensajes:

```bash
npm run crm:critical
```

Mandar de verdad:

```bash
npm run crm:critical -- --send
```

El mensaje al tutor de menores se puede ajustar con `CRM_TUTOR_MESSAGE`. El mensaje al jugador usa el texto fijo del bot, salvo que completes `CRM_PLAYER_MESSAGE`.

### Uso por equipo

Cada persona debe correr el bot de jugadores en su propia PC para usar su sesion local de WhatsApp Web. El flujo recomendado es:

- Descargar este proyecto completo desde GitHub, o clonarlo.
- Instalar dependencias con `npm install`.
- Completar `.env` con las credenciales CRM.
- Abrir `Abrir Bot CRM.command` o entrar a `http://localhost:3000/crm-bot.html`.
- Elegir su nombre en el login.
- Escanear WhatsApp Web la primera vez. La sesion queda guardada en `session/`.

Para Mac, no descargar archivos sueltos: hace falta el proyecto completo porque el bot usa `server.js`, `runner.js`, `crm-critical-bot.js`, `config.js`, `package.json`, `package-lock.json`, `public/crm-bot.html` y los `.command` de CRM. No compartir `.env`, `session/` ni `node_modules/`.

Guia corta para el equipo: `README-MAC-CRM.md`.

Vercel puede servir una interfaz, pero no puede mantener Chrome/WhatsApp Web con sesion persistente. La parte que envia WhatsApp tiene que correr localmente en cada PC o en una maquina dedicada con navegador.

Si la pantalla se publica en Vercel, cada PC igual tiene que abrir el motor local con `Abrir Bot CRM.command`. La web publicada llama al motor local en `http://localhost:3000`; para permitir esa conexion, agregar la URL de Vercel en `CRM_ALLOWED_ORIGINS`.

No subir a GitHub:

- `.env`
- `credentials.json`
- `session/`
- `node_modules/`
- `data/history.json`

## GitHub

Repositorio: `https://github.com/Ivounzaga/Bot-coordinadores`

GitHub sirve para versionar y compartir el codigo. No sirve, por si solo, para alojar el bot completo porque Puppeteer y la sesion de WhatsApp deben correr en una maquina con navegador y sesion local.

Para que sea usable por otros usuarios sin API paga, la arquitectura recomendada es:

- Repo GitHub con el codigo.
- App local o servidor propio por usuario.
- Sesion de WhatsApp guardada localmente en cada maquina.

La pantalla del bot de jugadores permite editar los mensajes antes de correr. Los campos personalizables se insertan con llaves, por ejemplo `{nombre}`, `{tutor}`, `{responsable}`, `{jugador_telefono}` o `{club}`.
