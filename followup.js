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

console.log("[FOLLOWUP] VERSION PRODUCCION + LIMITE + MIX + CONTROL");

const SHEET_ID = GOOGLE_SHEET_ID;
const SHEET_NAME = DETAIL_SHEET_NAME;
const SHEET_GID = DETAIL_SHEET_GID;

const SESSION_DIR = WHATSAPP_SESSION_DIR;
const CHROME_PATH = CHROME_EXECUTABLE_PATH;
const CREDENTIALS_PATH = GOOGLE_APPLICATION_CREDENTIALS;

const LAST_UPDATE_COL = "AQ";
const RESPONSIBLE_COL = "AT";
const DISMISS_STATUS = "desestimar";

const MAX_CONTACTS_PER_RUN = 30;

const CHAT_OPEN_DELAY_MIN_MS = 120000; // 2:00
const CHAT_OPEN_DELAY_MAX_MS = 150000; // 2:30

const PRE_SEND_DELAY_MIN_MS = 4000;
const PRE_SEND_DELAY_MAX_MS = 12000;

const DEFAULT_FOLLOWUP_MESSAGE =
  "Buenas como estas? Todo bien? Pudiste recibir mi mensaje?";

const DEFAULT_DAYS_THRESHOLD = 2;

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

function formatDateForSheet(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseSheetDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (match) {
    const [, d, m, y] = match;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400 * 1000;
    const parsed = new Date(utcValue);
    return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function isSameDay(a, b = new Date()) {
  return (
    a &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function daysBetween(date1, date2 = new Date()) {
  if (!date1) return 999;

  const start = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const end = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());

  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function resolveFollowupBaseMessage(customMessage) {
  const safe = cleanText(customMessage);
  return safe || DEFAULT_FOLLOWUP_MESSAGE;
}

function resolveDaysThreshold(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_DAYS_THRESHOLD;
  }

  return Math.floor(parsed);
}

function buildFollowupVariant1() {
  return DEFAULT_FOLLOWUP_MESSAGE;
}

function buildFollowupVariant2() {
  return "Holaaa todo bien? Te escribo para saber si pudiste leer el mensaje que te envie";
}

function buildFollowupVariant3() {
  return "Buenas como estas? Queria saber si habias recibido mi mensaje correctamente y si podiamos avanzar con la reunion";
}

function resolveDefaultFollowupVariant(rowNumber, customMessage) {
  const custom = cleanText(customMessage);

  if (custom) {
    return {
      text: custom,
      variant: "CUSTOM",
    };
  }

  const variants = [
    buildFollowupVariant1(),
    buildFollowupVariant2(),
    buildFollowupVariant3(),
  ];

  const variantIndex = rowNumber % variants.length;

  return {
    text: variants[variantIndex],
    variant: `DEFAULT_${variantIndex + 1}`,
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

function buildDelayedReplyMessage(date = new Date()) {
  const dayName = getSuggestedDayName(date);
  return `Hola como estas? Disculpa mi demora en responder, te escribo para retomar la idea de la capacitacion, te queda comodo el ${dayName} a las 20 H?`;
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

function prepareFollowupRows(body, invalidos, daysThreshold = DEFAULT_DAYS_THRESHOLD) {
  const idxAD = columnToIndex("AD");
  const idxAL = columnToIndex("AL");
  const idxAN = columnToIndex("AN");
  const idxAO = columnToIndex("AO");
  const idxT = columnToIndex("T");
  const idxY = columnToIndex("Y");
  const idxZ = columnToIndex("Z");
  const idxAP = columnToIndex("AP");
  const idxAT = columnToIndex(RESPONSIBLE_COL);
  const idxLastUpdate = columnToIndex(LAST_UPDATE_COL);

  const rows = [];

  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    const rowNumber = i + 2;

    const acuerdoAD = normalizeText(row[idxAD]);
    const estadoAP = normalizeText(row[idxAP]);
    const respAT = normalizeText(row[idxAT]);
    const lastUpdate = parseSheetDate(row[idxLastUpdate]);

    const telefonoAN = sanitizePhone(row[idxAN]);
    const telefonoY = sanitizePhone(row[idxY]);

    const acuerdoValido = acuerdoAD === "si";
    const estadoValido = estadoAP === "contactado";
    const respValido = respAT === "ivo";
    const diasDesdeUltimoContacto = lastUpdate ? daysBetween(lastUpdate) : 999;
    const fechaEsHoy = lastUpdate ? isSameDay(lastUpdate) : false;

    console.log("[FOLLOWUP][ROW CHECK]", {
      rowNumber,
      acuerdoAD,
      acuerdoValido,
      estadoAP,
      respAT,
      rawAQ: row[idxLastUpdate],
      parsedAQ: lastUpdate ? formatDateForSheet(lastUpdate) : null,
      fechaEsHoy,
      diasDesdeUltimoContacto,
      daysThreshold,
      telefonoAN,
      telefonoY,
    });

    if (!acuerdoValido) continue;
    if (!estadoValido) continue;
    if (!respValido) continue;
    if (diasDesdeUltimoContacto < daysThreshold) continue;

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
        reason: "Sin telefono válido",
        rowNumber,
      });
      console.log("[FOLLOWUP][ROW INVALIDA] sin telefono", { rowNumber });
      continue;
    }

    rows.push({
      rowNumber,
      source,
      finalName,
      finalPhone,
      finalLink,
      lastUpdate: cleanText(row[idxLastUpdate]),
      diasDesdeUltimoContacto,
      daysThreshold,
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

async function updateFollowupTracking(sheets, rowNumber, shouldDismiss = false) {
  const today = formatDateForSheet();

  const data = [
    {
      range: `${SHEET_NAME}!${LAST_UPDATE_COL}${rowNumber}`,
      values: [[today]],
    },
  ];

  if (shouldDismiss) {
    data.push({
      range: `${SHEET_NAME}!AP${rowNumber}`,
      values: [[DISMISS_STATUS]],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
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

async function getChatResponseStatus(page) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(2500);

    const result = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

      const getMessageText = (wrapper) => {
        const copyable = wrapper.querySelector(".copyable-text");
        if (copyable) {
          return clean(copyable.innerText || "");
        }
        return clean(wrapper.innerText || "");
      };

      const wrappers = Array.from(
        document.querySelectorAll("div.message-in, div.message-out")
      );

      const messages = wrappers
        .map((el) => {
          const className = String(el.className || "");
          let direction = "unknown";

          if (className.includes("message-in")) direction = "incoming";
          if (className.includes("message-out")) direction = "outgoing";

          const text = getMessageText(el);

          return {
            direction,
            text,
            className,
          };
        })
        .filter((item) => item.direction !== "unknown" && item.text !== "");

      const lastFiveMessages = messages.slice(-5).map((m) => ({
        direction: m.direction,
        text: m.text,
      }));

      const last = messages.length ? messages[messages.length - 1] : null;
      const hasIncomingEver = messages.some((m) => m.direction === "incoming");

      return {
        lastMessageDirection: last ? last.direction : "unknown",
        hasIncomingEver,
        responseLabel: hasIncomingEver ? "Me respondió" : "No me respondió",
        lastMessageText: last ? last.text : "",
        totalDetectedMessages: messages.length,
        selectedFrom: "message-in-out",
        lastFiveMessages,
        rawDetectedCount: wrappers.length,
      };
    });

    console.log(`[FOLLOWUP][CHAT STATUS][ATTEMPT ${attempt}]`, JSON.stringify(result, null, 2));

    if (result.totalDetectedMessages > 0) {
      return result;
    }
  }

  return {
    lastMessageDirection: "unknown",
    hasIncomingEver: false,
    responseLabel: "No me respondió",
    lastMessageText: "",
    totalDetectedMessages: 0,
    selectedFrom: "message-in-out",
    lastFiveMessages: [],
    rawDetectedCount: 0,
  };
}

async function resolveFollowupMessageForChat(page, rowNumber, customMessage) {
  const chatStatus = await getChatResponseStatus(page);
  const defaultVariant = resolveDefaultFollowupVariant(rowNumber, customMessage);

  const isDelayedReply = chatStatus.lastMessageDirection === "incoming";

  const selectedTemplate = isDelayedReply
    ? "delayed_reply"
    : defaultVariant.variant;

  const finalMessage = isDelayedReply
    ? buildDelayedReplyMessage()
    : defaultVariant.text;

  console.log("[FOLLOWUP][DECISION]", {
    rowNumber,
    lastMessageDirection: chatStatus.lastMessageDirection,
    hasIncomingEver: chatStatus.hasIncomingEver,
    responseLabel: chatStatus.responseLabel,
    selectedTemplate,
    finalMessage,
    lastMessageText: chatStatus.lastMessageText,
    totalDetectedMessages: chatStatus.totalDetectedMessages,
    selectedFrom: chatStatus.selectedFrom,
  });

  return {
    ...chatStatus,
    selectedTemplate,
    finalMessage,
  };
}

async function openChatAndSendFollowup(page, item, customMessage, control, sendProgress) {
  const url = buildWhatsAppUrl(item.finalPhone, item.finalLink);

  console.log("[FOLLOWUP][OPEN CHAT]", {
    rowNumber: item.rowNumber,
    name: item.finalName,
    phone: item.finalPhone,
    url,
  });

  await controlCheckpoint(control, sendProgress);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await controlledSleep(control, 4000, sendProgress);

  try {
    await page.waitForFunction(() => {
      return document.querySelectorAll("div.message-in, div.message-out").length > 0;
    }, { timeout: 15000 });
    console.log("[FOLLOWUP] historial cargado");
  } catch {
    console.log("[FOLLOWUP] historial no visible todavia, sigo con reintentos internos");
  }

  await controlCheckpoint(control, sendProgress);

  const {
    finalMessage,
    lastMessageDirection,
    hasIncomingEver,
    responseLabel,
    lastMessageText,
    totalDetectedMessages,
    selectedFrom,
    lastFiveMessages,
    rawDetectedCount,
    selectedTemplate,
  } = await resolveFollowupMessageForChat(page, item.rowNumber, customMessage);

  console.log("[FOLLOWUP][LAST 5 MESSAGES]");
  console.log(JSON.stringify(lastFiveMessages, null, 2));

  const preSendDelay = randomBetween(PRE_SEND_DELAY_MIN_MS, PRE_SEND_DELAY_MAX_MS);

  console.log("[FOLLOWUP][PRE SEND DELAY]", {
    rowNumber: item.rowNumber,
    delayMs: preSendDelay,
    delayHuman: msToHuman(preSendDelay),
  });

  await controlledSleep(control, preSendDelay, sendProgress);
  await controlCheckpoint(control, sendProgress);

  console.log("[FOLLOWUP][MESSAGE TO SEND]", {
    rowNumber: item.rowNumber,
    selectedTemplate,
    finalMessage,
    lastMessageDirection,
    responseLabel,
    lastMessageText,
    totalDetectedMessages,
    rawDetectedCount,
    selectedFrom,
  });

  await sendMessage(page, finalMessage);

  return {
    usedMessage: finalMessage,
    lastMessageDirection,
    hasIncomingEver,
    responseLabel,
    lastMessageText,
    totalDetectedMessages,
    selectedFrom,
    rawDetectedCount,
    lastFiveMessages,
    selectedTemplate,
    preSendDelay,
  };
}

async function runFollowup(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID", "DETAIL_SHEET_GID"]);

  const invalidos = [];
  const followups = [];
  const errores = [];

  let browser = null;
  let rows = [];
  let stoppedByLimit = false;

  const customMessage = cleanText(options.message);
  const daysThreshold = resolveDaysThreshold(options.daysThreshold);
  const effectiveMessage = resolveFollowupBaseMessage(customMessage);
  const control = options.control || createNoopControl();

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[FOLLOWUP] leyendo sheet...");
    const body = await fetchSheetRows();

    await controlCheckpoint(control, sendProgress);

    console.log("[FOLLOWUP] preparando filas...");
    rows = prepareFollowupRows(body, invalidos, daysThreshold);

    console.log("[FOLLOWUP] resumen previo", {
      totalElegibles: rows.length,
      invalidos: invalidos.length,
      limitePorCorrida: MAX_CONTACTS_PER_RUN,
      customMessage: customMessage || null,
      daysThreshold,
    });

    sendProgress({
      type: "followup",
      step: "rows_ready",
      total: rows.length,
      invalidos: invalidos.length,
      errores: 0,
      contactados: 0,
      messageTemplate: effectiveMessage,
      daysThreshold,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: `Se encontraron ${rows.length} contactos para follow-up`,
    });

    if (!rows.length) {
      sendProgress({
        type: "followup",
        step: "done",
        total: 0,
        contactados: 0,
        invalidos: invalidos.length,
        errores: 0,
        messageTemplate: effectiveMessage,
        daysThreshold,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        message: "No hay contactos para follow-up",
      });

      return {
        date: new Date().toISOString(),
        type: "followup",
        message: effectiveMessage,
        daysThreshold,
        total: invalidos.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        contactados: [],
        followups: [],
        invalidos,
        errores,
      };
    }

    await controlCheckpoint(control, sendProgress);

    console.log("[FOLLOWUP] creando cliente Sheets...");
    const sheets = await getSheetsClient();

    console.log("[FOLLOWUP] lanzando navegador...");
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: SESSION_DIR,
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      defaultViewport: null,
      args: ["--start-maximized"],
    });

    const page = await browser.newPage();

    console.log("[FOLLOWUP] abriendo WhatsApp...");
    await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForWhatsApp(page);
    console.log("[FOLLOWUP] WhatsApp listo");

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (followups.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;

        console.log("[FOLLOWUP] limite alcanzado, frenando corrida", {
          maxPerRun: MAX_CONTACTS_PER_RUN,
          enviados: followups.length,
          restantesSinProcesar: rows.length - i,
        });

        break;
      }

      const item = rows[i];

      console.log("[FOLLOWUP] procesando fila", {
        index: i + 1,
        totalElegibles: rows.length,
        enviadosHastaAhora: followups.length,
        rowNumber: item.rowNumber,
        name: item.finalName,
        phone: item.finalPhone,
        daysThreshold,
      });

      sendProgress({
        type: "followup",
        step: "processing",
        current: i + 1,
        total: rows.length,
        name: item.finalName || `Fila ${item.rowNumber}`,
        contactados: followups.length,
        invalidos: invalidos.length,
        errores: errores.length,
        messageTemplate: effectiveMessage,
        daysThreshold,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        message: `Procesando ${i + 1} de ${rows.length}`,
      });

      try {
        const {
          usedMessage,
          lastMessageDirection,
          hasIncomingEver,
          responseLabel,
          lastMessageText,
          totalDetectedMessages,
          selectedFrom,
          rawDetectedCount,
          lastFiveMessages,
          selectedTemplate,
          preSendDelay,
        } = await openChatAndSendFollowup(
          page,
          item,
          customMessage,
          control,
          sendProgress
        );

        await controlCheckpoint(control, sendProgress);

        const shouldDismiss = false;
        await updateFollowupTracking(sheets, item.rowNumber, shouldDismiss);

        console.log("[FOLLOWUP] fila enviada OK", {
          rowNumber: item.rowNumber,
          name: item.finalName,
          selectedTemplate,
          daysThreshold,
        });

        followups.push({
          name: item.finalName,
          phone: item.finalPhone,
          source: item.source,
          rowNumber: item.rowNumber,
          usedMessage,
          lastMessageDirection,
          hasIncomingEver,
          responseLabel,
          lastMessageText,
          totalDetectedMessages,
          selectedFrom,
          rawDetectedCount,
          lastFiveMessages,
          selectedTemplate,
          preSendDelay,
          diasDesdeUltimoContacto: item.diasDesdeUltimoContacto,
          daysThreshold,
          finalStatus: shouldDismiss ? DISMISS_STATUS : "contactado",
        });

        sendProgress({
          type: "followup",
          step: "item_success",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          contactados: followups.length,
          invalidos: invalidos.length,
          errores: errores.length,
          messageTemplate: effectiveMessage,
          daysThreshold,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });

        if (followups.length >= MAX_CONTACTS_PER_RUN) {
          stoppedByLimit = true;

          console.log("[FOLLOWUP] limite alcanzado justo despues del envio", {
            maxPerRun: MAX_CONTACTS_PER_RUN,
            enviados: followups.length,
          });

          break;
        }

        const nextChatDelay = randomBetween(
          CHAT_OPEN_DELAY_MIN_MS,
          CHAT_OPEN_DELAY_MAX_MS
        );

        console.log("[FOLLOWUP][NEXT CHAT DELAY]", {
          rowNumber: item.rowNumber,
          delayMs: nextChatDelay,
          delayHuman: msToHuman(nextChatDelay),
        });

        await controlledSleep(control, nextChatDelay, sendProgress);
      } catch (err) {
        console.error("[FOLLOWUP] error en fila", item.rowNumber, err);

        if (err.code === "MANUAL_STOP") {
          throw err;
        }

        errores.push({
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          rowNumber: item.rowNumber,
        });

        sendProgress({
          type: "followup",
          step: "item_error",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          contactados: followups.length,
          invalidos: invalidos.length,
          errores: errores.length,
          messageTemplate: effectiveMessage,
          daysThreshold,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });
      }
    }

    console.log("[FOLLOWUP] proceso finalizado", {
      totalElegibles: rows.length,
      enviados: followups.length,
      invalidos: invalidos.length,
      errores: errores.length,
      stoppedByLimit,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      daysThreshold,
    });

    sendProgress({
      type: "followup",
      step: "done",
      total: rows.length,
      contactados: followups.length,
      invalidos: invalidos.length,
      errores: errores.length,
      messageTemplate: effectiveMessage,
      daysThreshold,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      message: stoppedByLimit
        ? `Proceso frenado por limite de ${MAX_CONTACTS_PER_RUN} contactos`
        : "Proceso de follow-up finalizado",
    });

    return {
      date: new Date().toISOString(),
      type: "followup",
      message: effectiveMessage,
      daysThreshold,
      total: followups.length + invalidos.length + errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: followups,
      followups,
      invalidos,
      errores,
    };
  } catch (err) {
    console.error("[FOLLOWUP] error general:", err);

    if (err.code === "MANUAL_STOP") {
      return {
        date: new Date().toISOString(),
        type: "followup",
        message: effectiveMessage,
        daysThreshold,
        total: followups.length + invalidos.length + errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: true,
        stoppedManually: true,
        contactados: followups,
        followups,
        invalidos,
        errores,
      };
    }

    sendProgress({
      type: "followup",
      step: "failed",
      total: rows.length,
      contactados: followups.length,
      invalidos: invalidos.length,
      errores: errores.length + 1,
      messageTemplate: effectiveMessage,
      daysThreshold,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "followup",
      message: effectiveMessage,
      daysThreshold,
      total: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: [],
      followups: [],
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
  runFollowup,
};
