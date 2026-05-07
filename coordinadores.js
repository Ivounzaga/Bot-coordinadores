const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const fs = require("fs");
const {
  GOOGLE_SHEET_ID,
  COORDINADORES_SHEET_NAME,
  GOOGLE_APPLICATION_CREDENTIALS,
  WHATSAPP_SESSION_DIR,
  CHROME_EXECUTABLE_PATH,
  assertRequiredConfig,
} = require("./config");

console.log("[COORDINADORES] VERSION SHEET + DUPLICADOS + INVALIDOS + CONTROL");

const SHEET_ID = GOOGLE_SHEET_ID;
const SHEET_NAME = COORDINADORES_SHEET_NAME;

const SESSION_DIR = WHATSAPP_SESSION_DIR;
const CHROME_PATH = CHROME_EXECUTABLE_PATH;
const CREDENTIALS_PATH = GOOGLE_APPLICATION_CREDENTIALS;

const LAST_CONTACT_COL = "M";
const STATUS_COL = "N";

const CONTACTED_STATUS = "contactado";
const DUPLICATE_STATUS = "Telefono duplicado";
const INVALID_STATUS = "Telefono invalido";

const MAX_CONTACTS_PER_RUN = 30;
const BETWEEN_MESSAGES_DELAY_MS = 60 * 1000;
const BETWEEN_CHATS_DELAY_MS = 2 * 60 * 1000;
const CHAT_LOAD_DELAY_MS = 6000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNoopControl() {
  return {
    async checkpoint() {},
    async interruptibleSleep(ms) {
      await sleep(ms);
    },
    isStopping() {
      return false;
    },
    isPaused() {
      return false;
    },
    isRunning() {
      return true;
    },
    getStatus() {
      return "running";
    },
  };
}

async function controlledSleep(control, ms, sendProgress) {
  const safeControl = control || createNoopControl();
  await safeControl.interruptibleSleep(ms, sendProgress);
}

async function controlCheckpoint(control, sendProgress) {
  const safeControl = control || createNoopControl();
  await safeControl.checkpoint(sendProgress);
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeWhitespace(value) {
  return cleanText(value).replace(/\s+/g, " ");
}

function digitsFromValue(value) {
  const raw = cleanText(value)
    .replace(/[\u202a-\u202e]/g, "")
    .replace(/\u00a0/g, " ");

  if (!raw) return "";

  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return String(Math.round(parsed));
    }
  }

  return raw.replace(/\D/g, "");
}

function phoneFromLink(link) {
  const raw = cleanText(link);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const phone = url.searchParams.get("phone") || "";
    return digitsFromValue(phone);
  } catch {
    const match = raw.match(/[?&]phone=([^&]+)/i);
    if (match) return digitsFromValue(decodeURIComponent(match[1]));
  }

  return "";
}

function sanitizeArgentinaPhone(value) {
  let phone = digitsFromValue(value);

  if (!phone) return "";
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = phone.slice(1);

  if (phone.startsWith("549")) return phone;

  if (phone.startsWith("54")) {
    const local = phone.slice(2).replace(/^0+/, "");
    return `549${local}`;
  }

  return `549${phone.replace(/^0+/, "")}`;
}

function resolvePhone(rawPhone, rawLink) {
  const fromLink = phoneFromLink(rawLink);
  const normalized = sanitizeArgentinaPhone(fromLink || rawPhone);

  if (!/^549\d{10}$/.test(normalized)) {
    return "";
  }

  return normalized;
}

function formatDateForSheet(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDayMonth(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

function getSuggestedDate(date = new Date()) {
  const dayTargets = {
    1: 3, // lunes -> miercoles
    2: 4, // martes -> jueves
    3: 5, // miercoles -> viernes
    4: 1, // jueves -> lunes
    5: 2, // viernes -> martes
  };

  const dayNames = {
    1: "lunes",
    2: "martes",
    3: "miercoles",
    4: "jueves",
    5: "viernes",
  };

  const currentDay = date.getDay();
  const targetDay = dayTargets[currentDay] || 1;
  let daysToAdd = (targetDay - currentDay + 7) % 7;

  if (daysToAdd === 0) {
    daysToAdd = 7;
  }

  const targetDate = new Date(date);
  targetDate.setDate(date.getDate() + daysToAdd);

  return {
    dayName: dayNames[targetDay],
    date: targetDate,
    label: `${dayNames[targetDay]} ${formatDayMonth(targetDate)}`,
  };
}

function buildSecondMessage(date = new Date()) {
  const suggested = getSuggestedDate(date);
  return `Te queda comodo el dia ${suggested.label} entre la franja horaria 8 a 17?`;
}

function buildFirstMessageVariantA(name) {
  return `Buenas ${name}. Como estas? Todo bien? Te escribo para coordinar la capacitacion con jugadores y STAFF del club.`;
}

function buildFirstMessageVariantB(name) {
  return `Hola ${name}. Como va? Te contacto para coordinar la capacitacion con jugadores y STAFF del club.`;
}

function buildFirstMessageVariantC(name) {
  return `Buenas ${name}. Espero que estes bien. Te escribo para organizar la capacitacion con jugadores y STAFF del club.`;
}

function resolveFirstMessage(name, rowNumber) {
  const safeName = normalizeWhitespace(name) || "como estas";
  const variants = [
    buildFirstMessageVariantA(safeName),
    buildFirstMessageVariantB(safeName),
    buildFirstMessageVariantC(safeName),
  ];
  const variantIndex = rowNumber % variants.length;

  return {
    text: variants[variantIndex],
    variant: `V${variantIndex + 1}`,
  };
}

function buildWhatsAppUrl(phone) {
  return `https://web.whatsapp.com/send?phone=${phone}`;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function fetchSheetRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:V`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  return res.data.values || [];
}

function hasContactData(row) {
  const club = cleanText(row[1]);
  const firstName = cleanText(row[4]);
  const lastName = cleanText(row[5]);
  const email = cleanText(row[8]);
  const phone = cleanText(row[10]);
  const link = cleanText(row[11]);

  return Boolean(club || firstName || lastName || email || phone || link);
}

function prepareRows(values) {
  const rows = [];
  const invalidos = [];
  const duplicados = [];
  const firstRowByPhone = new Map();

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;

    if (!hasContactData(row)) continue;

    const estado = cleanText(row[13]);
    if (estado !== "") continue;

    const firstName = normalizeWhitespace(row[4]);
    const lastName = normalizeWhitespace(row[5]);
    const club = normalizeWhitespace(row[1]);
    const rawPhone = cleanText(row[10]);
    const rawLink = cleanText(row[11]);
    const finalPhone = resolvePhone(rawPhone, rawLink);

    const itemBase = {
      rowNumber,
      name: firstName || lastName || `Fila ${rowNumber}`,
      club,
      rawPhone,
      rawLink,
    };

    if (!finalPhone) {
      invalidos.push({
        ...itemBase,
        reason: INVALID_STATUS,
      });
      continue;
    }

    if (firstRowByPhone.has(finalPhone)) {
      duplicados.push({
        ...itemBase,
        phone: finalPhone,
        firstRowNumber: firstRowByPhone.get(finalPhone),
        reason: DUPLICATE_STATUS,
      });
      continue;
    }

    firstRowByPhone.set(finalPhone, rowNumber);

    rows.push({
      ...itemBase,
      phone: finalPhone,
    });
  }

  return {
    rows,
    invalidos,
    duplicados,
    uniquePhones: firstRowByPhone.size,
  };
}

async function batchUpdateValues(sheets, data) {
  if (!data.length) return;

  const chunkSize = 400;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: chunk,
      },
    });
  }
}

async function markRowsStatus(sheets, items, status) {
  const data = items.map((item) => ({
    range: `${SHEET_NAME}!${STATUS_COL}${item.rowNumber}`,
    values: [[status]],
  }));

  await batchUpdateValues(sheets, data);
}

async function markAsContacted(sheets, rowNumber) {
  const today = formatDateForSheet();

  await batchUpdateValues(sheets, [
    {
      range: `${SHEET_NAME}!${LAST_CONTACT_COL}${rowNumber}`,
      values: [[today]],
    },
    {
      range: `${SHEET_NAME}!${STATUS_COL}${rowNumber}`,
      values: [[CONTACTED_STATUS]],
    },
  ]);
}

async function waitForWhatsApp(page) {
  await page.waitForFunction(() => document.querySelector("#side"), {
    timeout: 600000,
  });
}

async function getComposer(page) {
  await page.waitForFunction(() => {
    return document.querySelectorAll('[contenteditable="true"]').length > 0;
  }, { timeout: 60000 });

  const boxes = await page.$$('[contenteditable="true"]');
  return boxes[boxes.length - 1];
}

async function clickSend(page) {
  const selectors = [
    '[data-testid="send"]',
    'button[aria-label="Enviar"]',
    'button[aria-label="Send"]',
  ];

  for (const selector of selectors) {
    const btn = await page.$(selector);
    if (btn) {
      await btn.click();
      return true;
    }
  }

  return false;
}

async function isInvalidWhatsAppNumber(page) {
  const patterns = [
    "no esta en whatsapp",
    "no está en whatsapp",
    "isn't on whatsapp",
    "not on whatsapp",
    "phone number shared via url is invalid",
    "numero de telefono no es valido",
    "número de teléfono no es válido",
  ];

  return await page.evaluate((patterns) => {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    return patterns.some((pattern) => bodyText.includes(pattern));
  }, patterns);
}

async function sendMessage(page, message) {
  const box = await getComposer(page);
  await box.click();
  await sleep(300);

  await page.evaluate((text) => {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const target = boxes[boxes.length - 1];
    if (!target) throw new Error("No se encontro la caja de mensaje");

    target.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, text);
  }, message);

  await sleep(400);

  const sent = await clickSend(page);
  if (!sent) {
    await page.keyboard.press("Enter");
  }
}

async function openChatAndSend(page, item, secondMessage, control, sendProgress) {
  const firstPayload = resolveFirstMessage(item.name, item.rowNumber);
  const url = buildWhatsAppUrl(item.phone);

  console.log("[COORDINADORES][OPEN CHAT]", {
    rowNumber: item.rowNumber,
    name: item.name,
    club: item.club,
    phone: item.phone,
    firstVariant: firstPayload.variant,
  });

  await controlCheckpoint(control, sendProgress);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await controlledSleep(control, CHAT_LOAD_DELAY_MS, sendProgress);

  if (await isInvalidWhatsAppNumber(page)) {
    throw new Error(INVALID_STATUS);
  }

  await controlCheckpoint(control, sendProgress);
  await sendMessage(page, firstPayload.text);

  sendProgress({
    type: "coordinadores",
    step: "between_messages",
    name: item.name,
    rowNumber: item.rowNumber,
    message: "Esperando 1 minuto antes del segundo mensaje",
  });

  await controlledSleep(control, BETWEEN_MESSAGES_DELAY_MS, sendProgress);
  await controlCheckpoint(control, sendProgress);
  await sendMessage(page, secondMessage);

  return {
    firstMessage: firstPayload.text,
    firstVariant: firstPayload.variant,
    secondMessage,
  };
}

async function runCoordinadores(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID"]);

  const contactados = [];
  const errores = [];
  let invalidos = [];
  let duplicados = [];
  let rows = [];
  let browser = null;
  let stoppedByLimit = false;

  const control = options.control || createNoopControl();
  const secondMessage = buildSecondMessage();

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[COORDINADORES] creando cliente Sheets...");
    const sheets = await getSheetsClient();

    console.log("[COORDINADORES] leyendo sheet...");
    const values = await fetchSheetRows(sheets);

    await controlCheckpoint(control, sendProgress);

    const prepared = prepareRows(values);
    rows = prepared.rows;
    invalidos = prepared.invalidos;
    duplicados = prepared.duplicados;

    console.log("[COORDINADORES] resumen previo", {
      elegiblesUnicos: rows.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      limitePorCorrida: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "coordinadores",
      step: "rows_ready",
      total: rows.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      errores: 0,
      contactados: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      secondMessage,
      message: `Se encontraron ${rows.length} telefonos unicos para procesar`,
    });

    await controlCheckpoint(control, sendProgress);

    await markRowsStatus(sheets, invalidos, INVALID_STATUS);
    await markRowsStatus(sheets, duplicados, DUPLICATE_STATUS);

    sendProgress({
      type: "coordinadores",
      step: "preclean_done",
      total: rows.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      errores: 0,
      contactados: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: "Duplicados e invalidos marcados en el Sheet",
    });

    if (!rows.length) {
      sendProgress({
        type: "coordinadores",
        step: "done",
        total: 0,
        contactados: 0,
        invalidos: invalidos.length,
        duplicados: duplicados.length,
        errores: 0,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        message: "No hay coordinadores para contactar",
      });

      return {
        date: new Date().toISOString(),
        type: "coordinadores",
        message: secondMessage,
        secondMessage,
        total: invalidos.length + duplicados.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        contactados: [],
        invalidos,
        duplicados,
        errores,
      };
    }

    browser = await puppeteer.launch({
      headless: false,
      userDataDir: SESSION_DIR,
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      defaultViewport: null,
      args: ["--start-maximized"],
    });

    const page = await browser.newPage();
    await page.goto("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await waitForWhatsApp(page);

    console.log("[COORDINADORES] WhatsApp listo");

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (contactados.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;
        break;
      }

      const item = rows[i];

      sendProgress({
        type: "coordinadores",
        step: "processing",
        current: i + 1,
        total: rows.length,
        name: item.name,
        club: item.club,
        contactados: contactados.length,
        invalidos: invalidos.length,
        duplicados: duplicados.length,
        errores: errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        secondMessage,
        message: `Procesando ${i + 1} de ${rows.length}`,
      });

      try {
        const sendResult = await openChatAndSend(
          page,
          item,
          secondMessage,
          control,
          sendProgress
        );

        await controlCheckpoint(control, sendProgress);
        await markAsContacted(sheets, item.rowNumber);

        contactados.push({
          name: item.name,
          club: item.club,
          phone: item.phone,
          rowNumber: item.rowNumber,
          firstVariant: sendResult.firstVariant,
          firstMessage: sendResult.firstMessage,
          secondMessage: sendResult.secondMessage,
        });

        sendProgress({
          type: "coordinadores",
          step: "item_success",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          contactados: contactados.length,
          invalidos: invalidos.length,
          duplicados: duplicados.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });

        if (contactados.length >= MAX_CONTACTS_PER_RUN) {
          stoppedByLimit = true;
          break;
        }

        sendProgress({
          type: "coordinadores",
          step: "between_chats",
          name: item.name,
          contactados: contactados.length,
          invalidos: invalidos.length,
          duplicados: duplicados.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
          message: "Esperando 2 minutos antes del proximo chat",
        });

        await controlledSleep(control, BETWEEN_CHATS_DELAY_MS, sendProgress);
      } catch (err) {
        if (err.code === "MANUAL_STOP") {
          throw err;
        }

        const reason = err.message || "Error sin detalle";

        if (reason === INVALID_STATUS) {
          try {
            await markRowsStatus(sheets, [item], INVALID_STATUS);
          } catch (sheetErr) {
            console.error("[COORDINADORES] error marcando invalido", item.rowNumber, sheetErr);
          }

          invalidos.push({
            name: item.name,
            club: item.club,
            phone: item.phone,
            rowNumber: item.rowNumber,
            reason: INVALID_STATUS,
          });

          sendProgress({
            type: "coordinadores",
            step: "item_invalid",
            current: i + 1,
            total: rows.length,
            name: item.name,
            club: item.club,
            reason: INVALID_STATUS,
            contactados: contactados.length,
            invalidos: invalidos.length,
            duplicados: duplicados.length,
            errores: errores.length,
            maxPerRun: MAX_CONTACTS_PER_RUN,
          });

          continue;
        }

        errores.push({
          name: item.name,
          club: item.club,
          phone: item.phone,
          rowNumber: item.rowNumber,
          reason,
        });

        sendProgress({
          type: "coordinadores",
          step: "item_error",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          reason,
          contactados: contactados.length,
          invalidos: invalidos.length,
          duplicados: duplicados.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });
      }
    }

    sendProgress({
      type: "coordinadores",
      step: "done",
      total: rows.length,
      contactados: contactados.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      errores: errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      message: stoppedByLimit
        ? `Proceso frenado por limite de ${MAX_CONTACTS_PER_RUN} contactos`
        : "Proceso de coordinadores finalizado",
    });

    return {
      date: new Date().toISOString(),
      type: "coordinadores",
      message: secondMessage,
      secondMessage,
      total: contactados.length + invalidos.length + duplicados.length + errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados,
      invalidos,
      duplicados,
      errores,
    };
  } catch (err) {
    console.error("[COORDINADORES] error general:", err);

    if (err.code === "MANUAL_STOP") {
      return {
        date: new Date().toISOString(),
        type: "coordinadores",
        message: secondMessage,
        secondMessage,
        total: contactados.length + invalidos.length + duplicados.length + errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: true,
        stoppedManually: true,
        contactados,
        invalidos,
        duplicados,
        errores,
      };
    }

    sendProgress({
      type: "coordinadores",
      step: "failed",
      total: rows.length,
      contactados: contactados.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      errores: errores.length + 1,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "coordinadores",
      message: secondMessage,
      secondMessage,
      total: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: [],
      invalidos: [],
      duplicados: [],
      errores: [
        {
          name: "Error general",
          reason: err.message,
        },
      ],
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  runCoordinadores,
  buildSecondMessage,
  getSuggestedDate,
};
