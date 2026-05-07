const puppeteer = require("puppeteer");
const { parse } = require("csv-parse/sync");
const { google } = require("googleapis");
const fs = require("fs");
const {
  GOOGLE_SHEET_ID,
  DETAIL_SHEET_NAME,
  DETAIL_SHEET_GID,
  GOOGLE_APPLICATION_CREDENTIALS,
  WHATSAPP_SESSION_DIR,
  CHROME_EXECUTABLE_PATH,
  assertRequiredConfig,
} = require("./config");

console.log("[INITIAL] VERSION PRODUCCION + LIMITE + INVALIDOS A SHEET + CONTROL");

const SHEET_ID = GOOGLE_SHEET_ID;
const SHEET_NAME = DETAIL_SHEET_NAME;
const SHEET_GID = DETAIL_SHEET_GID;

const SESSION_DIR = WHATSAPP_SESSION_DIR;
const CHROME_PATH = CHROME_EXECUTABLE_PATH;
const CREDENTIALS_PATH = GOOGLE_APPLICATION_CREDENTIALS;
const LAST_UPDATE_COL = "AQ";

const MAX_CONTACTS_PER_RUN = 30;

const CHAT_OPEN_DELAY_MIN_MS = 120000; // 2:00
const CHAT_OPEN_DELAY_MAX_MS = 150000; // 2:30

const BETWEEN_MESSAGES_MIN_MS = 18000; // 18s
const BETWEEN_MESSAGES_MAX_MS = 35000; // 35s

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

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function msToHuman(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

function columnToIndex(col) {
  let result = 0;
  for (let i = 0; i < col.length; i++) {
    result = result * 26 + (col.charCodeAt(i) - 64);
  }
  return result - 1;
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function sanitizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (!phone) return "";
  if (phone.startsWith("0")) phone = phone.slice(1);
  if (phone.startsWith("549")) return phone;
  if (phone.startsWith("54") && !phone.startsWith("549")) return "549" + phone.slice(2);
  if (phone.length === 10) return "549" + phone;

  return phone;
}

function formatDateForSheet(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildFirstMessageVariantA(name) {
  const safe = cleanText(name);
  return safe
    ? `Buenasss ${safe}, como estas? Por aca Ivo Unzaga de AFA en GLOOUDS. Te escribo para coordinar una reu de capacitacion con staff, jugadores y padres de los chicos.`
    : `Buenasss, como estas? Por aca Ivo Unzaga de AFA en GLOOUDS. Te escribo para coordinar una reu de capacitacion con staff, jugadores y padres de los chicos.`;
}

function buildFirstMessageVariantB(name) {
  const safe = cleanText(name);
  return safe
    ? `Buenas ${safe}, todo bien? Mi nombre es Ivo Unzaga del proyecto AFA en GLOOUDS. El motivo de mi mensaje es para saber si podiamos hacer un meet o reunion virtual de capacitacion con el staff de las categorias, los jugadores del club y padres.`
    : `Buenas, todo bien? Mi nombre es Ivo Unzaga del proyecto AFA en GLOOUDS. El motivo de mi mensaje es para saber si podiamos hacer un meet o reunion virtual de capacitacion con el staff de las categorias, los jugadores del club y padres.`;
}

function resolveFirstMessage(name, rowNumber) {
  const variants = [
    buildFirstMessageVariantA(name),
    buildFirstMessageVariantB(name),
  ];

  const variantIndex = rowNumber % variants.length;
  return {
    text: variants[variantIndex],
    variant: variantIndex === 0 ? "A" : "B",
  };
}

function getSuggestedDayName(date = new Date()) {
  const dayMap = {
    1: "Miercoles",
    2: "Jueves",
    3: "Viernes",
    4: "Lunes",
    5: "Lunes",
  };

  return dayMap[date.getDay()] || "Lunes";
}

function buildSuggestedSecondMessage(date = new Date()) {
  const dayName = getSuggestedDayName(date);
  return `te queda comodo gestionarla para el ${dayName} a las 20 H?`;
}

function resolveSecondMessage(customMessage) {
  const safe = cleanText(customMessage);
  return safe || buildSuggestedSecondMessage();
}

function buildWhatsAppUrl(phone, link) {
  const normalizedPhone = sanitizePhone(phone);

  if (normalizedPhone) {
    return `https://web.whatsapp.com/send?phone=${normalizedPhone}`;
  }

  if (cleanText(link)) {
    try {
      const url = new URL(link);
      const phoneFromLink = sanitizePhone(url.searchParams.get("phone") || "");

      if (phoneFromLink) {
        return `https://web.whatsapp.com/send?phone=${phoneFromLink}`;
      }
    } catch {
      const fallbackPhone = sanitizePhone(link);
      if (fallbackPhone) {
        return `https://web.whatsapp.com/send?phone=${fallbackPhone}`;
      }
    }
  }

  throw new Error("Telefono invalido");
}

async function fetchSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error leyendo sheet: ${res.status}`);

  const text = await res.text();
  const records = parse(text, {
    relax_column_count: true,
    skip_empty_lines: false,
  });

  return records.slice(1);
}

function prepareRows(body, invalidos) {
  const idxAL = columnToIndex("AL");
  const idxAN = columnToIndex("AN");
  const idxAO = columnToIndex("AO");
  const idxT = columnToIndex("T");
  const idxY = columnToIndex("Y");
  const idxZ = columnToIndex("Z");
  const idxAD = columnToIndex("AD");
  const idxAP = columnToIndex("AP");

  const rows = [];

  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    const rowNumber = i + 2;

    const estadoAP = cleanText(row[idxAP]);
    const acuerdo = normalizeText(row[idxAD]);
    const telefonoAN = sanitizePhone(row[idxAN]);
    const telefonoY = sanitizePhone(row[idxY]);

    console.log("[INITIAL][ROW CHECK]", {
      rowNumber,
      estadoAP,
      acuerdo,
      telefonoAN,
      telefonoY,
    });

    if (estadoAP !== "") continue;
    if (acuerdo !== "si") continue;

    let finalName = "";
    let finalPhone = "";
    let finalLink = "";
    let source = "";

    if (telefonoAN) {
      source = "PRINCIPAL";
      finalName = cleanText(row[idxAL]);
      finalPhone = telefonoAN;
      finalLink = cleanText(row[idxAO]);
    } else if (telefonoY) {
      source = "SECUNDARIO";
      finalName = cleanText(row[idxT]);
      finalPhone = telefonoY;
      finalLink = cleanText(row[idxZ]);
    } else {
      invalidos.push({
        name: cleanText(row[idxAL]) || cleanText(row[idxT]) || `Fila ${rowNumber}`,
        reason: "contacto invalido",
        rowNumber,
      });

      console.log("[INITIAL][ROW INVALIDA] sin telefono", { rowNumber });
      continue;
    }

    rows.push({
      rowNumber,
      source,
      finalName,
      finalPhone,
      finalLink,
    });
  }

  return rows;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function markAsContacted(sheets, rowNumber) {
  const today = formatDateForSheet();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME}!AP${rowNumber}`,
          values: [["contactado"]],
        },
        {
          range: `${SHEET_NAME}!${LAST_UPDATE_COL}${rowNumber}`,
          values: [[today]],
        },
      ],
    },
  });
}

async function markAsInvalidContact(sheets, rowNumber) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME}!AP${rowNumber}`,
          values: [["Desestimar"]],
        },
        {
          range: `${SHEET_NAME}!AS${rowNumber}`,
          values: [["contacto invalido"]],
        },
      ],
    },
  });
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
    "numero no esta en whatsapp",
    "número no está en whatsapp",
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
    if (!target) throw new Error("No se encontró la caja de mensaje");

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
  const firstPayload = resolveFirstMessage(item.finalName, item.rowNumber);
  const first = firstPayload.text;
  const url = buildWhatsAppUrl(item.finalPhone, item.finalLink);

  console.log("[INITIAL][OPEN CHAT]", {
    rowNumber: item.rowNumber,
    name: item.finalName,
    phone: item.finalPhone,
    url,
    firstVariant: firstPayload.variant,
  });

  await controlCheckpoint(control, sendProgress);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await controlledSleep(control, 6000, sendProgress);

  const invalidNumber = await isInvalidWhatsAppNumber(page);
  if (invalidNumber) {
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    console.log("[INITIAL][INVALID DETECTADO]", {
      rowNumber: item.rowNumber,
      phone: item.finalPhone,
      pageTextPreview: pageText.slice(0, 300),
    });

    throw new Error("Telefono invalido");
  }

  await controlCheckpoint(control, sendProgress);

  console.log("[INITIAL][SEND FIRST MESSAGE]", {
    rowNumber: item.rowNumber,
    firstVariant: firstPayload.variant,
    firstMessage: first,
  });

  await sendMessage(page, first);

  const betweenMessagesDelay = randomBetween(
    BETWEEN_MESSAGES_MIN_MS,
    BETWEEN_MESSAGES_MAX_MS
  );

  console.log("[INITIAL][BETWEEN MESSAGES DELAY]", {
    rowNumber: item.rowNumber,
    delayMs: betweenMessagesDelay,
    delayHuman: msToHuman(betweenMessagesDelay),
  });

  await controlledSleep(control, betweenMessagesDelay, sendProgress);
  await controlCheckpoint(control, sendProgress);

  console.log("[INITIAL][SEND SECOND MESSAGE]", {
    rowNumber: item.rowNumber,
    secondMessage,
  });

  await sendMessage(page, secondMessage);

  return {
    firstMessage: first,
    firstVariant: firstPayload.variant,
    secondMessage,
    betweenMessagesDelay,
  };
}

async function runAutomation(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID", "DETAIL_SHEET_GID"]);

  const invalidos = [];
  const contactados = [];
  const errores = [];

  let browser;
  let rows = [];
  let stoppedByLimit = false;

  const secondMessage = resolveSecondMessage(options.secondMessage);
  const control = options.control || createNoopControl();

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[INITIAL] leyendo sheet...");
    const body = await fetchSheetRows();

    await controlCheckpoint(control, sendProgress);

    console.log("[INITIAL] preparando filas...");
    rows = prepareRows(body, invalidos);

    console.log("[INITIAL] resumen previo", {
      totalElegibles: rows.length,
      invalidos: invalidos.length,
      limitePorCorrida: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "initial",
      step: "rows_ready",
      total: rows.length,
      invalidos: invalidos.length,
      errores: 0,
      contactados: 0,
      secondMessage,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: `Se encontraron ${rows.length} contactos para procesar`,
    });

    const sheets = await getSheetsClient();

    for (const invalido of invalidos) {
      await controlCheckpoint(control, sendProgress);

      try {
        await markAsInvalidContact(sheets, invalido.rowNumber);
        console.log("[INITIAL][INVALID SHEET UPDATED]", {
          rowNumber: invalido.rowNumber,
          reason: invalido.reason,
        });
      } catch (err) {
        console.error("[INITIAL][INVALID SHEET ERROR]", invalido.rowNumber, err);
      }
    }

    await controlCheckpoint(control, sendProgress);

    browser = await puppeteer.launch({
      headless: false,
      userDataDir: SESSION_DIR,
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      defaultViewport: null,
      args: ["--start-maximized"],
    });

    const page = await browser.newPage();
    await page.goto("https://web.whatsapp.com/");
    await waitForWhatsApp(page);

    console.log("[INITIAL] WhatsApp listo");

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (contactados.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;

        console.log("[INITIAL] limite alcanzado, frenando corrida", {
          maxPerRun: MAX_CONTACTS_PER_RUN,
          enviados: contactados.length,
          restantesSinProcesar: rows.length - i,
        });

        break;
      }

      const item = rows[i];

      console.log("[INITIAL] procesando fila", {
        index: i + 1,
        totalElegibles: rows.length,
        enviadosHastaAhora: contactados.length,
        rowNumber: item.rowNumber,
        name: item.finalName,
        phone: item.finalPhone,
      });

      sendProgress({
        type: "initial",
        step: "processing",
        current: i + 1,
        total: rows.length,
        name: item.finalName || `Fila ${item.rowNumber}`,
        contactados: contactados.length,
        invalidos: invalidos.length,
        errores: errores.length,
        secondMessage,
        maxPerRun: MAX_CONTACTS_PER_RUN,
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

        console.log("[INITIAL] fila enviada OK", {
          rowNumber: item.rowNumber,
          name: item.finalName,
          firstVariant: sendResult.firstVariant,
        });

        contactados.push({
          name: item.finalName,
          phone: item.finalPhone,
          source: item.source,
          rowNumber: item.rowNumber,
          firstVariant: sendResult.firstVariant,
          firstMessage: sendResult.firstMessage,
          secondMessage: sendResult.secondMessage,
        });

        sendProgress({
          type: "initial",
          step: "item_success",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          contactados: contactados.length,
          invalidos: invalidos.length,
          errores: errores.length,
          secondMessage,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });

        if (contactados.length >= MAX_CONTACTS_PER_RUN) {
          stoppedByLimit = true;

          console.log("[INITIAL] limite alcanzado justo despues del envio", {
            maxPerRun: MAX_CONTACTS_PER_RUN,
            enviados: contactados.length,
          });

          break;
        }

        const nextChatDelay = randomBetween(
          CHAT_OPEN_DELAY_MIN_MS,
          CHAT_OPEN_DELAY_MAX_MS
        );

        console.log("[INITIAL][NEXT CHAT DELAY]", {
          rowNumber: item.rowNumber,
          delayMs: nextChatDelay,
          delayHuman: msToHuman(nextChatDelay),
        });

        await controlledSleep(control, nextChatDelay, sendProgress);
      } catch (err) {
        console.error("[INITIAL] error en fila", item.rowNumber, err);

        const errorMessage = String(err.message || "").toLowerCase();

        if (err.code === "MANUAL_STOP") {
          throw err;
        }

        if (errorMessage.includes("telefono invalido")) {
          try {
            await markAsInvalidContact(sheets, item.rowNumber);
          } catch (sheetErr) {
            console.error("[INITIAL] error marcando invalido en sheet", item.rowNumber, sheetErr);
          }

          invalidos.push({
            name: item.finalName || `Fila ${item.rowNumber}`,
            reason: "contacto invalido",
            rowNumber: item.rowNumber,
          });

          sendProgress({
            type: "initial",
            step: "item_invalid",
            current: i + 1,
            total: rows.length,
            name: item.finalName || `Fila ${item.rowNumber}`,
            reason: "contacto invalido",
            contactados: contactados.length,
            invalidos: invalidos.length,
            errores: errores.length,
            secondMessage,
            maxPerRun: MAX_CONTACTS_PER_RUN,
          });

          continue;
        }

        errores.push({
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          rowNumber: item.rowNumber,
        });

        sendProgress({
          type: "initial",
          step: "item_error",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          contactados: contactados.length,
          invalidos: invalidos.length,
          errores: errores.length,
          secondMessage,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });
      }
    }

    console.log("[INITIAL] proceso finalizado", {
      totalElegibles: rows.length,
      enviados: contactados.length,
      invalidos: invalidos.length,
      errores: errores.length,
      stoppedByLimit,
      maxPerRun: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "initial",
      step: "done",
      total: rows.length,
      contactados: contactados.length,
      invalidos: invalidos.length,
      errores: errores.length,
      secondMessage,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      message: stoppedByLimit
        ? `Proceso frenado por limite de ${MAX_CONTACTS_PER_RUN} contactos`
        : "Proceso finalizado",
    });

    return {
      date: new Date().toISOString(),
      type: "initial",
      message: secondMessage,
      total: contactados.length + invalidos.length + errores.length,
      secondMessage,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados,
      invalidos,
      errores,
    };
  } catch (err) {
    console.error("[INITIAL] error general:", err);

    if (err.code === "MANUAL_STOP") {
      return {
        date: new Date().toISOString(),
        type: "initial",
        message: secondMessage,
        total: contactados.length + invalidos.length + errores.length,
        secondMessage,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: true,
        stoppedManually: true,
        contactados,
        invalidos,
        errores,
      };
    }

    sendProgress({
      type: "initial",
      step: "failed",
      total: rows.length,
      contactados: contactados.length,
      invalidos: invalidos.length,
      errores: errores.length + 1,
      secondMessage,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "initial",
      message: secondMessage,
      total: 0,
      secondMessage,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: [],
      invalidos: [],
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
  runAutomation,
  buildSuggestedSecondMessage,
};
