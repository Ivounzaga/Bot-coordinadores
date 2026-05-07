const puppeteer = require("puppeteer");
const { parse } = require("csv-parse/sync");
const fs = require("fs");
const {
  GOOGLE_SHEET_ID,
  DETAIL_SHEET_GID,
  WHATSAPP_SESSION_DIR,
  CHROME_EXECUTABLE_PATH,
  assertRequiredConfig,
} = require("./config");

console.log("[REMINDER] VERSION RECORDATORIO REUNION + CONTROL CARGADA");

const SHEET_ID = GOOGLE_SHEET_ID;
const SHEET_GID = DETAIL_SHEET_GID;

const SESSION_DIR = WHATSAPP_SESSION_DIR;
const CHROME_PATH = CHROME_EXECUTABLE_PATH;

const MAX_CONTACTS_PER_RUN = 30;

const CHAT_OPEN_DELAY_MIN_MS = 120000;
const CHAT_OPEN_DELAY_MAX_MS = 150000;

const PRE_SEND_DELAY_MIN_MS = 4000;
const PRE_SEND_DELAY_MAX_MS = 12000;

const DEFAULT_REMINDER_MESSAGE_1 =
  "Buenasss como estas? Te recuerdo la reunion de hoy, mas que nada para enviarles a los grupos de los chicos y que se registren antes de la reunion";

const DEFAULT_REMINDER_MESSAGE_2 =
  "Buenass te tiro un ultimo recordatorio para que puedas enviarle a los chicos, que estamos a una 40 min del inicio de la reu";

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

function isSameDay(a, b = new Date()) {
  return (
    a &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function resolveReminderMessage1(customMessage) {
  const safe = cleanText(customMessage);
  return safe || DEFAULT_REMINDER_MESSAGE_1;
}

function resolveReminderMessage2(customMessage) {
  const safe = cleanText(customMessage);
  return safe || DEFAULT_REMINDER_MESSAGE_2;
}

function parseObsMeetingDate(rawValue) {
  const raw = cleanText(rawValue);
  if (!raw) return null;

  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find(Boolean);

  if (!firstLine) return null;

  const normalizedFirstLine = firstLine.replace(/\/{2,}/g, "/");

  const match = normalizedFirstLine.match(
    /(\d{1,2})\/+(\d{1,2})\/+(\d{4})(?:\s*(?:a las)?\s*(\d{1,2})[:.](\d{2}))?/i
  );

  if (!match) {
    console.log("[REMINDER][OBS PARSE] sin fecha valida en primera linea", {
      raw,
      firstLine,
      normalizedFirstLine,
    });
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  const hasTime = match[4] != null && match[5] != null;
  const hour = hasTime ? Number(match[4]) : 0;
  const minute = hasTime ? Number(match[5]) : 0;

  const date = new Date(year, month, day, hour, minute, 0, 0);

  if (Number.isNaN(date.getTime())) {
    console.log("[REMINDER][OBS PARSE] fecha invalida", {
      raw,
      firstLine,
      normalizedFirstLine,
    });
    return null;
  }

  console.log("[REMINDER][OBS PARSE]", {
    raw,
    firstLine,
    normalizedFirstLine,
    selectedIso: date.toISOString(),
    hasTime,
    sourceType: "dd/mm/yyyy",
  });

  return date;
}

function getReminderType(meetingDate, now = new Date()) {
  if (!meetingDate) return null;
  if (!isSameDay(meetingDate, now)) return null;

  const hasExplicitTime =
    !(meetingDate.getHours() === 0 && meetingDate.getMinutes() === 0);

  const targetDate = hasExplicitTime
    ? meetingDate
    : new Date(
        meetingDate.getFullYear(),
        meetingDate.getMonth(),
        meetingDate.getDate(),
        20,
        0,
        0,
        0
      );

  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs < 0) return null;

  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes <= 40) {
    return {
      type: "reminder_2",
      diffMinutes,
      hasExplicitTime,
      targetIso: targetDate.toISOString(),
    };
  }

  return {
    type: "reminder_1",
    diffMinutes,
    hasExplicitTime,
    targetIso: targetDate.toISOString(),
  };
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

function prepareReminderRows(body, invalidos, options = {}) {
  const idxAL = columnToIndex("AL");
  const idxAN = columnToIndex("AN");
  const idxAO = columnToIndex("AO");
  const idxT = columnToIndex("T");
  const idxY = columnToIndex("Y");
  const idxZ = columnToIndex("Z");
  const idxAP = columnToIndex("AP"); // estado
  const idxAS = columnToIndex("AS"); // obs / fecha
  const idxAT = columnToIndex("AT"); // responsable

  const rows = [];
  const now = options.now || new Date();

  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    const rowNumber = i + 2;

    const rawEstadoAP = row[idxAP];
    const rawObsAS = row[idxAS];
    const rawRespAT = row[idxAT];

    const estadoAP = normalizeText(rawEstadoAP);
    const obsAS = cleanText(rawObsAS);
    const respAT = normalizeText(rawRespAT);

    const telefonoAN = sanitizePhone(row[idxAN]);
    const telefonoY = sanitizePhone(row[idxY]);

    console.log("[REMINDER][FILTRO BASE]", {
      rowNumber,
      rawEstadoAP,
      estadoAP,
      rawObsAS,
      obsAS,
      rawRespAT,
      respAT,
    });

    if (estadoAP !== "capacitacion agendada") continue;
    if (respAT !== "ivo") continue;

    const meetingDate = parseObsMeetingDate(obsAS);
    const reminderDecision = getReminderType(meetingDate, now);

    console.log("[REMINDER][ROW CHECK]", {
      rowNumber,
      estadoAP,
      obsAS,
      respAT,
      parsedMeetingDate: meetingDate ? meetingDate.toISOString() : null,
      reminderDecision,
      telefonoAN,
      telefonoY,
    });

    if (!meetingDate) continue;
    if (!reminderDecision) continue;

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
      console.log("[REMINDER][ROW INVALIDA] sin telefono", { rowNumber });
      continue;
    }

    rows.push({
      rowNumber,
      source,
      finalName,
      finalPhone,
      finalLink,
      obsAS,
      meetingDate,
      reminderType: reminderDecision.type,
      diffMinutes: reminderDecision.diffMinutes,
      hasExplicitTime: reminderDecision.hasExplicitTime,
      targetIso: reminderDecision.targetIso,
    });
  }

  return rows;
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

async function openChatAndSendReminder(page, item, reminderMessage1, reminderMessage2, control, sendProgress) {
  const url = buildWhatsAppUrl(item.finalPhone, item.finalLink);

  console.log("[REMINDER][OPEN CHAT]", {
    rowNumber: item.rowNumber,
    name: item.finalName,
    phone: item.finalPhone,
    url,
    reminderType: item.reminderType,
    diffMinutes: item.diffMinutes,
    targetIso: item.targetIso,
  });

  await controlCheckpoint(control, sendProgress);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await controlledSleep(control, 4000, sendProgress);

  const preSendDelay = randomBetween(PRE_SEND_DELAY_MIN_MS, PRE_SEND_DELAY_MAX_MS);

  console.log("[REMINDER][PRE SEND DELAY]", {
    rowNumber: item.rowNumber,
    delayMs: preSendDelay,
    delayHuman: msToHuman(preSendDelay),
  });

  await controlledSleep(control, preSendDelay, sendProgress);
  await controlCheckpoint(control, sendProgress);

  const finalMessage =
    item.reminderType === "reminder_2" ? reminderMessage2 : reminderMessage1;

  console.log("[REMINDER][MESSAGE TO SEND]", {
    rowNumber: item.rowNumber,
    reminderType: item.reminderType,
    finalMessage,
  });

  await sendMessage(page, finalMessage);

  return {
    usedMessage: finalMessage,
    reminderType: item.reminderType,
    preSendDelay,
  };
}

async function runReminder(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID", "DETAIL_SHEET_GID"]);

  const invalidos = [];
  const reminders = [];
  const errores = [];

  let browser = null;
  let rows = [];
  let stoppedByLimit = false;

  const reminderMessage1 = resolveReminderMessage1(options.reminderMessage1);
  const reminderMessage2 = resolveReminderMessage2(options.reminderMessage2);
  const control = options.control || createNoopControl();

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[REMINDER] leyendo sheet...");
    const body = await fetchSheetRows();

    await controlCheckpoint(control, sendProgress);

    console.log("[REMINDER] preparando filas...");
    rows = prepareReminderRows(body, invalidos, { now: new Date() });

    console.log("[REMINDER] resumen previo", {
      totalElegibles: rows.length,
      invalidos: invalidos.length,
      limitePorCorrida: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "reminder",
      step: "rows_ready",
      total: rows.length,
      invalidos: invalidos.length,
      errores: 0,
      contactados: 0,
      reminderMessage1,
      reminderMessage2,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: `Se encontraron ${rows.length} contactos para recordatorio`,
    });

    if (!rows.length) {
      sendProgress({
        type: "reminder",
        step: "done",
        total: 0,
        contactados: 0,
        invalidos: invalidos.length,
        errores: 0,
        reminderMessage1,
        reminderMessage2,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        message: "No hay contactos para recordatorio",
      });

      return {
        date: new Date().toISOString(),
        type: "reminder",
        message: reminderMessage1,
        reminderMessage1,
        reminderMessage2,
        total: invalidos.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        contactados: [],
        reminders: [],
        invalidos,
        errores,
      };
    }

    await controlCheckpoint(control, sendProgress);

    console.log("[REMINDER] lanzando navegador...");
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: SESSION_DIR,
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      defaultViewport: null,
      args: ["--start-maximized"],
    });

    const page = await browser.newPage();

    console.log("[REMINDER] abriendo WhatsApp...");
    await page.goto("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await waitForWhatsApp(page);
    console.log("[REMINDER] WhatsApp listo");

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (reminders.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;

        console.log("[REMINDER] limite alcanzado, frenando corrida", {
          maxPerRun: MAX_CONTACTS_PER_RUN,
          enviados: reminders.length,
          restantesSinProcesar: rows.length - i,
        });

        break;
      }

      const item = rows[i];

      console.log("[REMINDER] procesando fila", {
        index: i + 1,
        totalElegibles: rows.length,
        enviadosHastaAhora: reminders.length,
        rowNumber: item.rowNumber,
        name: item.finalName,
        phone: item.finalPhone,
        reminderType: item.reminderType,
        targetIso: item.targetIso,
      });

      sendProgress({
        type: "reminder",
        step: "processing",
        current: i + 1,
        total: rows.length,
        name: item.finalName || `Fila ${item.rowNumber}`,
        contactados: reminders.length,
        invalidos: invalidos.length,
        errores: errores.length,
        reminderMessage1,
        reminderMessage2,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        message: `Procesando ${i + 1} de ${rows.length}`,
      });

      try {
        const sendResult = await openChatAndSendReminder(
          page,
          item,
          reminderMessage1,
          reminderMessage2,
          control,
          sendProgress
        );

        console.log("[REMINDER] fila enviada OK", {
          rowNumber: item.rowNumber,
          name: item.finalName,
          reminderType: sendResult.reminderType,
        });

        reminders.push({
          name: item.finalName,
          phone: item.finalPhone,
          source: item.source,
          rowNumber: item.rowNumber,
          usedMessage: sendResult.usedMessage,
          reminderType: sendResult.reminderType,
          preSendDelay: sendResult.preSendDelay,
          obsAS: item.obsAS,
          meetingDate: item.meetingDate ? item.meetingDate.toISOString() : null,
          diffMinutes: item.diffMinutes,
          targetIso: item.targetIso,
        });

        sendProgress({
          type: "reminder",
          step: "item_success",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          contactados: reminders.length,
          invalidos: invalidos.length,
          errores: errores.length,
          reminderMessage1,
          reminderMessage2,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });

        if (reminders.length >= MAX_CONTACTS_PER_RUN) {
          stoppedByLimit = true;

          console.log("[REMINDER] limite alcanzado justo despues del envio", {
            maxPerRun: MAX_CONTACTS_PER_RUN,
            enviados: reminders.length,
          });

          break;
        }

        const nextChatDelay = randomBetween(
          CHAT_OPEN_DELAY_MIN_MS,
          CHAT_OPEN_DELAY_MAX_MS
        );

        console.log("[REMINDER][NEXT CHAT DELAY]", {
          rowNumber: item.rowNumber,
          delayMs: nextChatDelay,
          delayHuman: msToHuman(nextChatDelay),
        });

        await controlledSleep(control, nextChatDelay, sendProgress);
      } catch (err) {
        console.error("[REMINDER] error en fila", item.rowNumber, err);

        if (err.code === "MANUAL_STOP") {
          throw err;
        }

        errores.push({
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          rowNumber: item.rowNumber,
        });

        sendProgress({
          type: "reminder",
          step: "item_error",
          current: i + 1,
          total: rows.length,
          name: item.finalName || `Fila ${item.rowNumber}`,
          reason: err.message,
          contactados: reminders.length,
          invalidos: invalidos.length,
          errores: errores.length,
          reminderMessage1,
          reminderMessage2,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });
      }
    }

    console.log("[REMINDER] proceso finalizado", {
      totalElegibles: rows.length,
      enviados: reminders.length,
      invalidos: invalidos.length,
      errores: errores.length,
      stoppedByLimit,
      maxPerRun: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "reminder",
      step: "done",
      total: rows.length,
      contactados: reminders.length,
      invalidos: invalidos.length,
      errores: errores.length,
      reminderMessage1,
      reminderMessage2,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      message: stoppedByLimit
        ? `Proceso frenado por limite de ${MAX_CONTACTS_PER_RUN} contactos`
        : "Proceso de recordatorios finalizado",
    });

    return {
      date: new Date().toISOString(),
      type: "reminder",
      message: reminderMessage1,
      reminderMessage1,
      reminderMessage2,
      total: reminders.length + invalidos.length + errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: reminders,
      reminders,
      invalidos,
      errores,
    };
  } catch (err) {
    console.error("[REMINDER] error general:", err);

    if (err.code === "MANUAL_STOP") {
      return {
        date: new Date().toISOString(),
        type: "reminder",
        message: reminderMessage1,
        reminderMessage1,
        reminderMessage2,
        total: reminders.length + invalidos.length + errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: true,
        stoppedManually: true,
        contactados: reminders,
        reminders,
        invalidos,
        errores,
      };
    }

    sendProgress({
      type: "reminder",
      step: "failed",
      total: rows.length,
      contactados: reminders.length,
      invalidos: invalidos.length,
      errores: errores.length + 1,
      reminderMessage1,
      reminderMessage2,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "reminder",
      message: reminderMessage1,
      reminderMessage1,
      reminderMessage2,
      total: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: [],
      reminders: [],
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
  runReminder,
};
