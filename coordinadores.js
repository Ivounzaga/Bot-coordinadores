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

const FALLBACK_LAST_CONTACT_COL = "M";
const FALLBACK_STATUS_COL = "N";

const CONTACTED_STATUS = "contactado";
const DUPLICATE_STATUS = "Telefono duplicado";
const INVALID_STATUS = "Telefono invalido";

const REMINDER_3H_HEADER = "Recordatorio 3h enviado";
const REMINDER_1H_HEADER = "Recordatorio 1h enviado";
const REMINDER_3H_TYPE = "reminder_3h";
const REMINDER_1H_TYPE = "reminder_1h";
const REMINDER_3H_MESSAGE =
  "Buenas como estas? Recorda que hoy tenemos la capacitacion, podemos enviar un recordatorio para que esten presentes los jugadores y se registren en la APP? Nos vemos.";
const REMINDER_1H_MESSAGE =
  "Te envio un recordatorio ya que faltan menos de 1 hora para que arranque la reu.";

const MAX_CONTACTS_PER_RUN = 30;
const BETWEEN_MESSAGES_DELAY_MS = 60 * 1000;
const BETWEEN_CHATS_DELAY_MS = 2 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 120 * 1000;
const CHAT_READY_TIMEOUT_MS = 25 * 60 * 1000;
const CHAT_OPEN_RETRIES = 2;
const CHAT_RETRY_DELAY_MS = 15 * 1000;

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

function normalizeText(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeHeader(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function indexToColumn(index) {
  let n = index + 1;
  let column = "";

  while (n > 0) {
    const remainder = (n - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    n = Math.floor((n - 1) / 26);
  }

  return column;
}

function findHeaderColumn(headers, aliases) {
  const normalizedAliases = aliases.map(normalizeHeader);

  for (let i = 0; i < headers.length; i++) {
    const normalizedHeader = normalizeHeader(headers[i]);
    if (normalizedAliases.includes(normalizedHeader)) {
      return {
        index: i,
        letter: indexToColumn(i),
        header: cleanText(headers[i]),
      };
    }
  }

  return null;
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

function formatDateTimeForSheet(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
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
  return `La idea es que sea solamente con dos categorias +15 años. Te queda comodo el dia ${suggested.label}? La capacitacion dura 1 hora, confirmame que hora entre las 8 y 17 te queda bien.`;
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
  return `https://web.whatsapp.com/send/?phone=${phone}&type=phone_number&app_absent=0`;
}

function resolveCoordinadoresColumns(values) {
  const headers = values[0] || [];

  return {
    headers,
    lastContact: findHeaderColumn(headers, ["Ultimo contacto", "Último contacto"]),
    status: findHeaderColumn(headers, ["Estado"]),
    capacitacionDate: findHeaderColumn(headers, [
      "Fecha de la capacitacion",
      "Fecha de capacitacion",
      "Fecha capacitacion",
      "Fecha de la capacitación",
      "Fecha de capacitación",
    ]),
    responsable: findHeaderColumn(headers, ["Responsable"]),
    reminder3h: findHeaderColumn(headers, [REMINDER_3H_HEADER]),
    reminder1h: findHeaderColumn(headers, [REMINDER_1H_HEADER]),
  };
}

async function ensureReminderColumns(sheets, values) {
  const headers = values[0] || [];
  const updates = [];
  let nextIndex = headers.length;
  const columns = resolveCoordinadoresColumns(values);

  if (!columns.capacitacionDate) {
    throw new Error("No encontre la columna Fecha de la capacitacion en la hoja Coordinadores.");
  }

  if (!columns.responsable) {
    throw new Error("No encontre la columna Responsable en la hoja Coordinadores.");
  }

  if (!columns.reminder3h) {
    const letter = indexToColumn(nextIndex);
    columns.reminder3h = {
      index: nextIndex,
      letter,
      header: REMINDER_3H_HEADER,
    };
    headers[nextIndex] = REMINDER_3H_HEADER;
    updates.push({
      range: `${SHEET_NAME}!${letter}1`,
      values: [[REMINDER_3H_HEADER]],
    });
    nextIndex += 1;
  }

  if (!columns.reminder1h) {
    const letter = indexToColumn(nextIndex);
    columns.reminder1h = {
      index: nextIndex,
      letter,
      header: REMINDER_1H_HEADER,
    };
    headers[nextIndex] = REMINDER_1H_HEADER;
    updates.push({
      range: `${SHEET_NAME}!${letter}1`,
      values: [[REMINDER_1H_HEADER]],
    });
  }

  if (updates.length) {
    await batchUpdateValues(sheets, updates);
  }

  return columns;
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
    range: `${SHEET_NAME}!A:AZ`,
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

function buildCoordinatorItemBase(row, rowNumber) {
  const firstName = normalizeWhitespace(row[4]);
  const lastName = normalizeWhitespace(row[5]);
  const club = normalizeWhitespace(row[1]);
  const rawPhone = cleanText(row[10]);
  const rawLink = cleanText(row[11]);

  return {
    rowNumber,
    name: firstName || lastName || `Fila ${rowNumber}`,
    club,
    rawPhone,
    rawLink,
  };
}

function getCanonicalRowByPhone(values, statusIndex) {
  const entriesByPhone = new Map();
  const handledStatusesToIgnore = new Set([
    normalizeText(DUPLICATE_STATUS),
    normalizeText(INVALID_STATUS),
  ]);

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;

    if (!hasContactData(row)) continue;

    const finalPhone = resolvePhone(cleanText(row[10]), cleanText(row[11]));
    if (!finalPhone) continue;

    if (!entriesByPhone.has(finalPhone)) {
      entriesByPhone.set(finalPhone, []);
    }

    entriesByPhone.get(finalPhone).push({
      rowNumber,
      status: cleanText(row[statusIndex]),
    });
  }

  const canonicalRowByPhone = new Map();

  for (const [phone, entries] of entriesByPhone.entries()) {
    const handledEntry = entries.find((entry) => {
      const status = normalizeText(entry.status);
      return entry.status && !handledStatusesToIgnore.has(status);
    });
    const firstBlankEntry = entries.find((entry) => !entry.status);
    const canonical = handledEntry || firstBlankEntry || entries[0];

    if (canonical) {
      canonicalRowByPhone.set(phone, canonical.rowNumber);
    }
  }

  return canonicalRowByPhone;
}

function isHandledContactStatus(status) {
  const normalized = normalizeText(status);

  return Boolean(
    cleanText(status) &&
      normalized !== normalizeText(DUPLICATE_STATUS) &&
      normalized !== normalizeText(INVALID_STATUS)
  );
}

function findHandledPhoneEntry(values, columns, phone) {
  const statusIndex = columns.status?.index ?? 13;

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;

    if (!hasContactData(row)) continue;

    const finalPhone = resolvePhone(cleanText(row[10]), cleanText(row[11]));
    if (finalPhone !== phone) continue;

    const status = cleanText(row[statusIndex]);
    if (isHandledContactStatus(status)) {
      return {
        rowNumber,
        status,
      };
    }
  }

  return null;
}

function prepareRows(values, options = {}) {
  const columns = options.columns || resolveCoordinadoresColumns(values);
  const responsableFilter = normalizeText(options.responsable || "");
  const statusIndex = columns.status?.index ?? 13;
  const responsableIndex = columns.responsable?.index;

  if (responsableFilter && responsableIndex == null) {
    throw new Error("No encontre la columna Responsable en la hoja Coordinadores.");
  }

  const rows = [];
  const invalidos = [];
  const duplicados = [];
  const canonicalRowByPhone = getCanonicalRowByPhone(values, statusIndex);

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;

    if (!hasContactData(row)) continue;

    const estado = cleanText(row[statusIndex]);
    if (estado !== "") continue;

    const matchesResponsable =
      !responsableFilter || normalizeText(row[responsableIndex]) === responsableFilter;
    const itemBase = buildCoordinatorItemBase(row, rowNumber);
    const finalPhone = resolvePhone(itemBase.rawPhone, itemBase.rawLink);

    if (!finalPhone) {
      if (matchesResponsable) {
        invalidos.push({
          ...itemBase,
          reason: INVALID_STATUS,
        });
      }
      continue;
    }

    const canonicalRowNumber = canonicalRowByPhone.get(finalPhone);

    if (canonicalRowNumber && canonicalRowNumber !== rowNumber) {
      duplicados.push({
        ...itemBase,
        phone: finalPhone,
        firstRowNumber: canonicalRowNumber,
        reason: DUPLICATE_STATUS,
      });
      continue;
    }

    if (!matchesResponsable) {
      continue;
    }

    rows.push({
      ...itemBase,
      phone: finalPhone,
    });
  }

  return {
    rows,
    invalidos,
    duplicados,
    uniquePhones: canonicalRowByPhone.size,
  };
}

function parseCapacitacionDate(value, now = new Date()) {
  const raw = normalizeWhitespace(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+hs?\.?/gi, ":00")
    .replace(/\ba las\b/gi, " ");

  if (!raw) {
    return {
      date: null,
      hasTime: false,
      reason: "Fecha de capacitacion vacia",
    };
  }

  const isoMatch = raw.match(
    /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2})(?::|\.)(\d{2}))?/i
  );
  const localMatch = raw.match(
    /(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?(?:\D+(\d{1,2})(?::|\.)(\d{2}))?/i
  );
  const timeOnlyMatch = raw.match(/\b(\d{1,2})(?::|\.)(\d{2})\b/);

  let year;
  let month;
  let day;
  let hour = 0;
  let minute = 0;
  let hasTime = false;

  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]) - 1;
    day = Number(isoMatch[3]);
    hasTime = isoMatch[4] != null && isoMatch[5] != null;
    hour = hasTime ? Number(isoMatch[4]) : 0;
    minute = hasTime ? Number(isoMatch[5]) : 0;
  } else if (localMatch) {
    day = Number(localMatch[1]);
    month = Number(localMatch[2]) - 1;
    year = localMatch[3] ? Number(localMatch[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    hasTime = localMatch[4] != null && localMatch[5] != null;
    hour = hasTime ? Number(localMatch[4]) : 0;
    minute = hasTime ? Number(localMatch[5]) : 0;
  } else {
    return {
      date: null,
      hasTime: false,
      reason: "No pude interpretar la fecha de capacitacion",
    };
  }

  if (!hasTime && timeOnlyMatch) {
    hasTime = true;
    hour = Number(timeOnlyMatch[1]);
    minute = Number(timeOnlyMatch[2]);
  }

  const date = new Date(year, month, day, hour, minute, 0, 0);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    return {
      date: null,
      hasTime: false,
      reason: "Fecha de capacitacion invalida",
    };
  }

  return {
    date,
    hasTime,
    reason: hasTime ? "" : "La fecha de capacitacion no tiene hora",
  };
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function resolveReminderDecision(row, columns, meetingDate, hasTime, now = new Date()) {
  if (!hasTime) {
    return {
      type: "",
      reason: "La fecha de capacitacion no tiene hora",
    };
  }

  if (!isSameLocalDay(meetingDate, now)) {
    return {
      type: "",
      reason: "La capacitacion no es hoy",
    };
  }

  const diffMinutes = Math.ceil((meetingDate.getTime() - now.getTime()) / 60000);

  if (diffMinutes < 0) {
    return {
      type: "",
      reason: "La capacitacion ya empezo o ya paso",
      diffMinutes,
    };
  }

  const sent3h = cleanText(row[columns.reminder3h.index]);
  const sent1h = cleanText(row[columns.reminder1h.index]);

  if (diffMinutes <= 60) {
    if (sent1h) {
      return {
        type: "",
        reason: "Recordatorio de 1h ya enviado",
        diffMinutes,
      };
    }

    return {
      type: REMINDER_1H_TYPE,
      message: REMINDER_1H_MESSAGE,
      markerColumn: columns.reminder1h,
      diffMinutes,
    };
  }

  if (meetingDate.getHours() >= 11 && diffMinutes <= 180) {
    if (sent3h) {
      return {
        type: "",
        reason: "Recordatorio de 3h ya enviado",
        diffMinutes,
      };
    }

    return {
      type: REMINDER_3H_TYPE,
      message: REMINDER_3H_MESSAGE,
      markerColumn: columns.reminder3h,
      diffMinutes,
    };
  }

  return {
    type: "",
    reason: "Todavia no corresponde enviar recordatorio",
    diffMinutes,
  };
}

function prepareReminderRows(values, columns, options = {}) {
  const now = options.now || new Date();
  const responsableFilter = normalizeText(options.responsable || "");
  const statusIndex = columns.status?.index ?? 13;
  const rows = [];
  const invalidos = [];
  const sinHora = [];
  const skipped = [];
  const rowsByPhone = new Map();

  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rowNumber = i + 1;

    if (!hasContactData(row)) continue;

    const estado = normalizeText(row[statusIndex]);
    if (estado === normalizeText(INVALID_STATUS) || estado === normalizeText(DUPLICATE_STATUS)) {
      continue;
    }

    const responsable = normalizeText(row[columns.responsable.index]);
    if (responsableFilter && responsable !== responsableFilter) {
      continue;
    }

    const rawDate = cleanText(row[columns.capacitacionDate.index]);
    if (!rawDate) continue;

    const parsed = parseCapacitacionDate(rawDate, now);
    if (!parsed.date) {
      skipped.push({
        rowNumber,
        name: normalizeWhitespace(row[4]) || `Fila ${rowNumber}`,
        reason: parsed.reason,
        rawDate,
      });
      continue;
    }

    const decision = resolveReminderDecision(row, columns, parsed.date, parsed.hasTime, now);
    if (!decision.type) {
      if (decision.reason === "La fecha de capacitacion no tiene hora") {
        sinHora.push({
          rowNumber,
          name: normalizeWhitespace(row[4]) || `Fila ${rowNumber}`,
          rawDate,
          reason: decision.reason,
        });
      }

      continue;
    }

    const firstName = normalizeWhitespace(row[4]);
    const lastName = normalizeWhitespace(row[5]);
    const club = normalizeWhitespace(row[1]);
    const rawPhone = cleanText(row[10]);
    const rawLink = cleanText(row[11]);
    const finalPhone = resolvePhone(rawPhone, rawLink);

    const itemBase = {
      progressType: "coordinadoresReminder",
      rowNumber,
      rowNumbersToMark: [rowNumber],
      name: firstName || lastName || `Fila ${rowNumber}`,
      club,
      rawPhone,
      rawLink,
      phone: finalPhone,
      responsable: cleanText(row[columns.responsable.index]),
      capacitacionRaw: rawDate,
      capacitacionIso: parsed.date.toISOString(),
      reminderType: decision.type,
      reminderMessage: decision.message,
      markerColumn: decision.markerColumn,
      diffMinutes: decision.diffMinutes,
    };

    if (!finalPhone) {
      invalidos.push({
        ...itemBase,
        reason: INVALID_STATUS,
      });
      continue;
    }

    if (rowsByPhone.has(finalPhone)) {
      rowsByPhone.get(finalPhone).rowNumbersToMark.push(rowNumber);
      continue;
    }

    rowsByPhone.set(finalPhone, itemBase);
    rows.push(itemBase);
  }

  return {
    rows,
    invalidos,
    sinHora,
    skipped,
  };
}

async function getCoordinadoresResponsables() {
  assertRequiredConfig(["GOOGLE_SHEET_ID"]);

  const sheets = await getSheetsClient();
  const values = await fetchSheetRows(sheets);
  const columns = resolveCoordinadoresColumns(values);

  if (!columns.responsable) {
    return [];
  }

  const seen = new Map();

  for (let i = 1; i < values.length; i++) {
    const value = normalizeWhitespace(values[i]?.[columns.responsable.index]);
    if (!value) continue;

    const key = normalizeText(value);
    if (!seen.has(key)) {
      seen.set(key, value);
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, "es"));
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

function getSheetColumnLetter(column, fallback) {
  return column?.letter || fallback;
}

async function markRowsStatus(sheets, items, status, columns = {}) {
  const statusColumn = getSheetColumnLetter(columns.status, FALLBACK_STATUS_COL);
  const data = items.map((item) => ({
    range: `${SHEET_NAME}!${statusColumn}${item.rowNumber}`,
    values: [[status]],
  }));

  await batchUpdateValues(sheets, data);
}

async function markAsContacted(sheets, rowNumber, columns = {}) {
  const today = formatDateForSheet();
  const lastContactColumn = getSheetColumnLetter(
    columns.lastContact,
    FALLBACK_LAST_CONTACT_COL
  );
  const statusColumn = getSheetColumnLetter(columns.status, FALLBACK_STATUS_COL);

  await batchUpdateValues(sheets, [
    {
      range: `${SHEET_NAME}!${lastContactColumn}${rowNumber}`,
      values: [[today]],
    },
    {
      range: `${SHEET_NAME}!${statusColumn}${rowNumber}`,
      values: [[CONTACTED_STATUS]],
    },
  ]);
}

async function markReminderSent(sheets, item) {
  const sentAt = formatDateTimeForSheet();
  const data = item.rowNumbersToMark.map((rowNumber) => ({
    range: `${SHEET_NAME}!${item.markerColumn.letter}${rowNumber}`,
    values: [[sentAt]],
  }));

  await batchUpdateValues(sheets, data);
}

async function waitForWhatsApp(page) {
  await page.waitForFunction(() => document.querySelector("#side"), {
    timeout: 600000,
  });
}

async function getComposer(page) {
  const selectors = [
    '[contenteditable="true"][role="textbox"][aria-placeholder]',
    '[contenteditable="true"][aria-placeholder="Escribe un mensaje"]',
    '[contenteditable="true"][aria-placeholder="Type a message"]',
    '[aria-label^="Escribir un mensaje"]',
    '[aria-label^="Type a message"]',
    '#main footer [contenteditable="true"]',
    'footer [contenteditable="true"][role="textbox"]',
    'footer [contenteditable="true"]',
    '[aria-label="Escribe un mensaje"]',
    '[aria-label="Type a message"]',
  ];

  for (const selector of selectors) {
    const box = await page.waitForSelector(selector, {
      timeout: 5000,
      visible: true,
    }).catch(() => null);

    if (box) return box;
  }

  await page.waitForFunction(() => {
    const main = document.querySelector("#main");
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"]'));

    return boxes.some((box) => {
      const rect = box.getBoundingClientRect();
      const style = window.getComputedStyle(box);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden";

      return visible && (!main || main.contains(box));
    });
  }, { timeout: CHAT_READY_TIMEOUT_MS });

  const boxes = await page.$$('[contenteditable="true"]');

  for (let i = boxes.length - 1; i >= 0; i--) {
    const isVisible = await boxes[i].evaluate((box) => {
      const rect = box.getBoundingClientRect();
      const style = window.getComputedStyle(box);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });

    if (isVisible) return boxes[i];
  }

  throw new Error("No se encontro la caja de mensaje");
}

async function clickSend(page) {
  const selectors = [
    '[data-testid="send"]',
    'button[aria-label="Enviar"]',
    'button[aria-label="Enviar mensaje"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button span[data-icon="send"]',
  ];

  for (const selector of selectors) {
    const btn = await page.$(selector);
    if (btn) {
      const clickable = await btn.evaluateHandle((el) => el.closest("button") || el);
      const element = clickable.asElement();
      if (element) {
        await element.click();
      } else {
        await btn.click();
      }
      return true;
    }
  }

  return false;
}

async function isComposerEmpty(page) {
  return await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const target = boxes[boxes.length - 1];
    if (!target) return true;

    const text = (target.innerText || target.textContent || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .trim();

    return text === "";
  }).catch(() => false);
}

async function waitForComposerEmpty(page, timeout = 8000) {
  return await page.waitForFunction(() => {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const target = boxes[boxes.length - 1];
    if (!target) return true;

    const text = (target.innerText || target.textContent || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .trim();

    return text === "";
  }, { timeout }).then(() => true).catch(() => false);
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

async function isQrVisible(page) {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    const canvasVisible = Array.from(document.querySelectorAll("canvas")).some((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 120 && rect.height > 120;
    });

    return (
      canvasVisible ||
      text.includes("usa whatsapp en tu computadora") ||
      text.includes("use whatsapp on your computer") ||
      text.includes("vincular con el numero de telefono") ||
      text.includes("link with phone number")
    );
  });
}

async function getWhatsAppLoadingLabel(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const patterns = [
      /Cargando tus chats\s*\[\s*\d+\s*%\s*\]/i,
      /Loading your chats\s*\[\s*\d+\s*%\s*\]/i,
      /No cierres esta ventana[^\n.]*/i,
      /Don't close this window[^\n.]*/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }

    return "";
  }).catch(() => "");
}

async function isWhatsAppShellLoaded(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const title = document.title || "";

    if (/Cargando tus chats|Loading your chats|No cierres esta ventana|Don't close this window/i.test(text)) {
      return false;
    }

    const hasKnownShell = [
      "#pane-side",
      '[aria-label="Lista de chats"]',
      '[aria-label="Chat list"]',
      '[data-testid="chat-list"]',
    ].some((selector) => document.querySelector(selector));

    const hasLoadedAppText = /WhatsApp/i.test(title) && (
      /Todos|No leidos|No leídos|Favoritos|Grupos|Chats|Buscar|Search|Unread/i.test(text) ||
      text.length > 250
    );

    return hasKnownShell || hasLoadedAppText;
  }).catch(() => false);
}

async function waitForWhatsAppShellReady(page, control, sendProgress) {
  const progressType = typeof control?.getType === "function"
    ? control.getType()
    : "coordinadores";
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let qrAlreadyReported = false;

  while (Date.now() - startedAt < CHAT_READY_TIMEOUT_MS) {
    await controlCheckpoint(control, sendProgress);

    if (await isQrVisible(page)) {
      if (!qrAlreadyReported) {
        qrAlreadyReported = true;
        sendProgress({
          type: progressType,
          step: "qr_waiting",
          message: "WhatsApp pide QR. Escanealo para continuar.",
        });
      }

      await controlledSleep(control, 1500, sendProgress);
      continue;
    }

    if (await isWhatsAppShellLoaded(page)) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds - lastProgressAt >= 10) {
      lastProgressAt = elapsedSeconds;
      const loadingLabel = await getWhatsAppLoadingLabel(page);
      sendProgress({
        type: progressType,
        step: "whatsapp_loading",
        message: loadingLabel
          ? `${loadingLabel}. Esperando WhatsApp... ${elapsedSeconds}s`
          : `Cargando WhatsApp... ${elapsedSeconds}s`,
      });
    }

    await controlledSleep(control, 1000, sendProgress);
  }

  throw new Error(`Timeout cargando WhatsApp despues de ${Math.round(CHAT_READY_TIMEOUT_MS / 60000)} minutos`);
}

async function getActiveChatSignature(page) {
  return await page.evaluate(() => {
    const selectors = [
      "#main header span[title]",
      "#main header [title]",
      "#main header",
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = (el?.getAttribute("title") || el?.innerText || "").trim();
      if (text) return text.replace(/\s+/g, " ");
    }

    return "";
  }).catch(() => "");
}

async function getComposerSignature(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[contenteditable="true"][role="textbox"][aria-placeholder]',
      '[contenteditable="true"][aria-placeholder]',
      '[aria-label^="Escribir un mensaje"]',
      '[aria-label^="Type a message"]',
      '#main footer [contenteditable="true"]',
      'footer [contenteditable="true"]',
    ];

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };

    for (const selector of selectors) {
      const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
      const text = (
        el?.getAttribute("aria-label") ||
        el?.getAttribute("aria-placeholder") ||
        el?.innerText ||
        ""
      ).trim();

      if (text) return text.replace(/\s+/g, " ");
    }

    return "";
  }).catch(() => "");
}

function signatureMatchesPhone(signature, phone) {
  const signatureDigits = digitsFromValue(signature);
  const phoneDigits = digitsFromValue(phone);
  const suffix = phoneDigits.slice(-8);

  return suffix.length >= 8 && signatureDigits.includes(suffix);
}

function getItemProgressType(item) {
  return item.progressType || "coordinadores";
}

function isLeaveSiteDialog(dialog) {
  const message = normalizeText(dialog.message());

  return (
    dialog.type() === "beforeunload" ||
    message.includes("abandonar") ||
    message.includes("salir del sitio") ||
    message.includes("leave site") ||
    message.includes("reload this site")
  );
}

function attachDialogAutoHandler(page, sendProgress, progressType) {
  if (page.__coordinadoresDialogHandlerAttached) return;
  page.__coordinadoresDialogHandlerAttached = true;

  page.on("dialog", async (dialog) => {
    const message = dialog.message();
    const dialogType = dialog.type();
    const shouldLeave = isLeaveSiteDialog(dialog);

    console.log("[COORDINADORES][DIALOG]", {
      type: dialogType,
      message,
      action: shouldLeave ? "accept" : "dismiss",
    });

    try {
      if (shouldLeave) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }

      sendProgress({
        type: progressType,
        step: "browser_dialog_handled",
        message: shouldLeave
          ? "Se acepto automaticamente el aviso de abandonar WhatsApp para pasar al siguiente chat"
          : `Se cerro automaticamente un aviso del navegador: ${message || dialogType}`,
      });
    } catch (err) {
      console.error("[COORDINADORES][DIALOG ERROR]", err);
    }
  });
}

async function clearBeforeUnloadHandlers(page) {
  await page.evaluate(() => {
    try {
      window.onbeforeunload = null;
    } catch {}
  }).catch(() => {});
}

async function installBeforeUnloadBlocker(page) {
  await page.evaluateOnNewDocument(() => {
    const blockedEvent = "beforeunload";
    const originalAddEventListener = EventTarget.prototype.addEventListener;

    EventTarget.prototype.addEventListener = function patchedAddEventListener(
      type,
      listener,
      options
    ) {
      if (String(type).toLowerCase() === blockedEvent) {
        return undefined;
      }

      return originalAddEventListener.call(this, type, listener, options);
    };

    try {
      Object.defineProperty(window, "onbeforeunload", {
        configurable: true,
        get() {
          return null;
        },
        set() {
          return null;
        },
      });
    } catch {}
  });

  await clearBeforeUnloadHandlers(page);
}

async function prepareWhatsAppPage(page, sendProgress, progressType) {
  attachDialogAutoHandler(page, sendProgress, progressType);
  await installBeforeUnloadBlocker(page);
}

async function hasMessageComposer(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[contenteditable="true"][role="textbox"][aria-placeholder]',
      '[contenteditable="true"][aria-placeholder="Escribe un mensaje"]',
      '[contenteditable="true"][aria-placeholder="Type a message"]',
      '[aria-label^="Escribir un mensaje"]',
      '[aria-label^="Type a message"]',
      '#main footer [contenteditable="true"]',
      'footer [contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"]',
      '[aria-label="Escribe un mensaje"]',
      '[aria-label="Type a message"]',
    ];

    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };

    return selectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some(isVisible);
    });
  });
}

async function waitForChatReady(page, item, control, sendProgress, options = {}) {
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let qrAlreadyReported = false;
  let chatTargetAlreadyReported = false;
  const previousSignature = options.previousSignature || "";

  while (Date.now() - startedAt < CHAT_READY_TIMEOUT_MS) {
    await controlCheckpoint(control, sendProgress);

    if (await isQrVisible(page)) {
      if (!qrAlreadyReported) {
        qrAlreadyReported = true;
        sendProgress({
          type: getItemProgressType(item),
          step: "qr_waiting",
          name: item.name,
          club: item.club,
          rowNumber: item.rowNumber,
          message: "WhatsApp pide QR. Escanealo para continuar.",
        });
      }

      await controlledSleep(control, 1500, sendProgress);
      continue;
    }

    if (await isInvalidWhatsAppNumber(page)) {
      throw new Error(INVALID_STATUS);
    }

    if (await hasMessageComposer(page)) {
      const currentSignature = await getActiveChatSignature(page);
      const composerSignature = await getComposerSignature(page);
      const currentUrl = page.url();
      const urlIncludesPhone = decodeURIComponent(currentUrl).includes(item.phone);
      const signatureChanged = Boolean(
        previousSignature &&
        currentSignature &&
        currentSignature !== previousSignature
      );
      const signatureMatches = signatureMatchesPhone(currentSignature, item.phone);
      const composerMatches = signatureMatchesPhone(composerSignature, item.phone);
      const chatConfirmed = urlIncludesPhone || signatureChanged || signatureMatches || composerMatches;

      if (chatConfirmed) {
        return;
      }

      if (!chatTargetAlreadyReported) {
        chatTargetAlreadyReported = true;
        sendProgress({
          type: getItemProgressType(item),
          step: "chat_loading",
          name: item.name,
          club: item.club,
          rowNumber: item.rowNumber,
          message: `WhatsApp cargo, esperando que abra el chat correcto de ${item.name}`,
        });
      }
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds - lastProgressAt >= 10) {
      lastProgressAt = elapsedSeconds;
      const loadingLabel = await getWhatsAppLoadingLabel(page);
      sendProgress({
        type: getItemProgressType(item),
        step: "chat_loading",
        name: item.name,
        club: item.club,
        rowNumber: item.rowNumber,
        message: loadingLabel
          ? `${loadingLabel}. Esperando WhatsApp... ${elapsedSeconds}s`
          : `Cargando WhatsApp/chat de ${item.name}... ${elapsedSeconds}s`,
      });
    }

    await controlledSleep(control, 1000, sendProgress);
  }

  throw new Error(`Timeout cargando WhatsApp o el chat despues de ${Math.round(CHAT_READY_TIMEOUT_MS / 60000)} minutos`);
}

async function openChat(page, item, url, control, sendProgress) {
  let lastError = null;

  for (let attempt = 1; attempt <= CHAT_OPEN_RETRIES; attempt++) {
    try {
      const previousSignature = await getActiveChatSignature(page);

      sendProgress({
        type: getItemProgressType(item),
        step: "chat_opening",
        name: item.name,
        club: item.club,
        rowNumber: item.rowNumber,
        message: `Abriendo chat de ${item.name} (${attempt}/${CHAT_OPEN_RETRIES})`,
      });

      await controlCheckpoint(control, sendProgress);
      await clearBeforeUnloadHandlers(page);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await clearBeforeUnloadHandlers(page);
      await controlledSleep(control, 3000, sendProgress);
      await waitForChatReady(page, item, control, sendProgress, { previousSignature });
      return;
    } catch (err) {
      if (err.code === "MANUAL_STOP" || err.message === INVALID_STATUS) {
        throw err;
      }

      lastError = err;
      console.error("[COORDINADORES][CHAT OPEN ERROR]", {
        rowNumber: item.rowNumber,
        name: item.name,
        attempt,
        error: err.message,
      });

      if (attempt < CHAT_OPEN_RETRIES) {
        sendProgress({
          type: getItemProgressType(item),
          step: "chat_retry",
          name: item.name,
          club: item.club,
          rowNumber: item.rowNumber,
          message: `Reintentando abrir chat de ${item.name} en 15 segundos`,
        });
        await controlledSleep(control, CHAT_RETRY_DELAY_MS, sendProgress);
      }
    }
  }

  throw lastError || new Error("No se pudo abrir el chat");
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

  const clicked = await clickSend(page);
  if (clicked && (await waitForComposerEmpty(page))) {
    return;
  }

  if (await isComposerEmpty(page)) {
    return;
  }

  await page.keyboard.press("Enter");
  await waitForComposerEmpty(page);
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

  await openChat(page, item, url, control, sendProgress);

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

async function openChatAndSendReminder(page, item, control, sendProgress) {
  const url = buildWhatsAppUrl(item.phone);

  console.log("[COORDINADORES][REMINDER OPEN CHAT]", {
    rowNumber: item.rowNumber,
    name: item.name,
    club: item.club,
    phone: item.phone,
    reminderType: item.reminderType,
    diffMinutes: item.diffMinutes,
  });

  await openChat(page, item, url, control, sendProgress);

  await controlCheckpoint(control, sendProgress);
  await sendMessage(page, item.reminderMessage);

  return {
    message: item.reminderMessage,
    reminderType: item.reminderType,
  };
}

async function runCoordinadoresReminders(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID"]);

  const reminders = [];
  const errores = [];
  let invalidos = [];
  let sinHora = [];
  let rows = [];
  let browser = null;
  let stoppedByLimit = false;

  const control = options.control || createNoopControl();
  const responsable = cleanText(options.responsable);

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[COORDINADORES][REMINDERS] creando cliente Sheets...");
    const sheets = await getSheetsClient();

    console.log("[COORDINADORES][REMINDERS] leyendo sheet...");
    const values = await fetchSheetRows(sheets);
    const columns = await ensureReminderColumns(sheets, values);

    await controlCheckpoint(control, sendProgress);

    const prepared = prepareReminderRows(values, columns, {
      now: new Date(),
      responsable,
    });

    rows = prepared.rows;
    invalidos = prepared.invalidos;
    sinHora = prepared.sinHora;

    console.log("[COORDINADORES][REMINDERS] resumen previo", {
      elegibles: rows.length,
      invalidos: invalidos.length,
      sinHora: sinHora.length,
      responsable: responsable || "(todos)",
      limitePorCorrida: MAX_CONTACTS_PER_RUN,
    });

    sendProgress({
      type: "coordinadoresReminder",
      step: "rows_ready",
      total: rows.length,
      invalidos: invalidos.length,
      sinHora: sinHora.length,
      errores: 0,
      contactados: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      responsable,
      message: `Se encontraron ${rows.length} recordatorios para enviar`,
    });

    await controlCheckpoint(control, sendProgress);
    await markRowsStatus(sheets, invalidos, INVALID_STATUS, columns);

    if (!rows.length) {
      sendProgress({
        type: "coordinadoresReminder",
        step: "done",
        total: 0,
        contactados: 0,
        invalidos: invalidos.length,
        sinHora: sinHora.length,
        errores: 0,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        message: "No hay recordatorios para enviar ahora",
      });

      return {
        date: new Date().toISOString(),
        type: "coordinadoresReminder",
        message: REMINDER_3H_MESSAGE,
        reminderMessage1: REMINDER_3H_MESSAGE,
        reminderMessage2: REMINDER_1H_MESSAGE,
        total: invalidos.length + sinHora.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: false,
        contactados: [],
        reminders: [],
        invalidos,
        sinHora,
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
    await prepareWhatsAppPage(page, sendProgress, "coordinadoresReminder");
    page.setDefaultTimeout(CHAT_READY_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    sendProgress({
      type: "coordinadoresReminder",
      step: "whatsapp_loading",
      message: "Abriendo WhatsApp para recordatorios",
    });

    await page.goto("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForWhatsAppShellReady(page, control, sendProgress);

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (reminders.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;
        break;
      }

      const item = rows[i];

      sendProgress({
        type: "coordinadoresReminder",
        step: "processing",
        current: i + 1,
        total: rows.length,
        name: item.name,
        club: item.club,
        contactados: reminders.length,
        invalidos: invalidos.length,
        sinHora: sinHora.length,
        errores: errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        reminderType: item.reminderType,
        message: `Procesando recordatorio ${i + 1} de ${rows.length}`,
      });

      try {
        const sendResult = await openChatAndSendReminder(
          page,
          item,
          control,
          sendProgress
        );

        await controlCheckpoint(control, sendProgress);
        await markReminderSent(sheets, item);

        reminders.push({
          name: item.name,
          club: item.club,
          phone: item.phone,
          rowNumber: item.rowNumber,
          rowNumbersToMark: item.rowNumbersToMark,
          reminderType: sendResult.reminderType,
          message: sendResult.message,
          capacitacionRaw: item.capacitacionRaw,
          capacitacionIso: item.capacitacionIso,
          diffMinutes: item.diffMinutes,
        });

        sendProgress({
          type: "coordinadoresReminder",
          step: "item_success",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          contactados: reminders.length,
          invalidos: invalidos.length,
          sinHora: sinHora.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
          reminderType: item.reminderType,
        });

        if (reminders.length >= MAX_CONTACTS_PER_RUN) {
          stoppedByLimit = true;
          break;
        }

        sendProgress({
          type: "coordinadoresReminder",
          step: "between_chats",
          name: item.name,
          contactados: reminders.length,
          invalidos: invalidos.length,
          sinHora: sinHora.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
          message: "Esperando 2 minutos antes del proximo recordatorio",
        });

        await controlledSleep(control, BETWEEN_CHATS_DELAY_MS, sendProgress);
      } catch (err) {
        if (err.code === "MANUAL_STOP") {
          throw err;
        }

        const reason = err.message || "Error sin detalle";
        errores.push({
          name: item.name,
          club: item.club,
          phone: item.phone,
          rowNumber: item.rowNumber,
          reminderType: item.reminderType,
          reason,
        });

        sendProgress({
          type: "coordinadoresReminder",
          step: "item_error",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          reason,
          contactados: reminders.length,
          invalidos: invalidos.length,
          sinHora: sinHora.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
        });
      }
    }

    sendProgress({
      type: "coordinadoresReminder",
      step: "done",
      total: rows.length,
      contactados: reminders.length,
      invalidos: invalidos.length,
      sinHora: sinHora.length,
      errores: errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      message: stoppedByLimit
        ? `Recordatorios frenados por limite de ${MAX_CONTACTS_PER_RUN}`
        : "Recordatorios finalizados",
    });

    return {
      date: new Date().toISOString(),
      type: "coordinadoresReminder",
      message: REMINDER_3H_MESSAGE,
      reminderMessage1: REMINDER_3H_MESSAGE,
      reminderMessage2: REMINDER_1H_MESSAGE,
      total: reminders.length + invalidos.length + sinHora.length + errores.length,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: reminders,
      reminders,
      invalidos,
      sinHora,
      errores,
    };
  } catch (err) {
    console.error("[COORDINADORES][REMINDERS] error general:", err);

    if (err.code === "MANUAL_STOP") {
      return {
        date: new Date().toISOString(),
        type: "coordinadoresReminder",
        message: REMINDER_3H_MESSAGE,
        reminderMessage1: REMINDER_3H_MESSAGE,
        reminderMessage2: REMINDER_1H_MESSAGE,
        total: reminders.length + invalidos.length + sinHora.length + errores.length,
        maxPerRun: MAX_CONTACTS_PER_RUN,
        stoppedByLimit: true,
        stoppedManually: true,
        contactados: reminders,
        reminders,
        invalidos,
        sinHora,
        errores,
      };
    }

    sendProgress({
      type: "coordinadoresReminder",
      step: "failed",
      total: rows.length,
      contactados: reminders.length,
      invalidos: invalidos.length,
      sinHora: sinHora.length,
      errores: errores.length + 1,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "coordinadoresReminder",
      message: REMINDER_3H_MESSAGE,
      reminderMessage1: REMINDER_3H_MESSAGE,
      reminderMessage2: REMINDER_1H_MESSAGE,
      total: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      stoppedByLimit,
      contactados: [],
      reminders: [],
      invalidos: [],
      sinHora,
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

async function runCoordinadores(sendProgress = () => {}, options = {}) {
  assertRequiredConfig(["GOOGLE_SHEET_ID"]);

  const contactados = [];
  const errores = [];
  const sentPhonesThisRun = new Set();
  let invalidos = [];
  let duplicados = [];
  let rows = [];
  let browser = null;
  let stoppedByLimit = false;

  const control = options.control || createNoopControl();
  const responsable = cleanText(options.responsable);
  const secondMessage = buildSecondMessage();

  try {
    await controlCheckpoint(control, sendProgress);

    console.log("[COORDINADORES] creando cliente Sheets...");
    const sheets = await getSheetsClient();

    console.log("[COORDINADORES] leyendo sheet...");
    const values = await fetchSheetRows(sheets);
    const columns = resolveCoordinadoresColumns(values);

    await controlCheckpoint(control, sendProgress);

    const prepared = prepareRows(values, {
      columns,
      responsable,
    });
    rows = prepared.rows;
    invalidos = prepared.invalidos;
    duplicados = prepared.duplicados;

    console.log("[COORDINADORES] resumen previo", {
      elegiblesUnicos: rows.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      responsable: responsable || "(todos)",
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
      responsable,
      secondMessage,
      message: `Se encontraron ${rows.length} telefonos unicos para procesar`,
    });

    await controlCheckpoint(control, sendProgress);

    await markRowsStatus(sheets, invalidos, INVALID_STATUS, columns);
    await markRowsStatus(sheets, duplicados, DUPLICATE_STATUS, columns);

    sendProgress({
      type: "coordinadores",
      step: "preclean_done",
      total: rows.length,
      invalidos: invalidos.length,
      duplicados: duplicados.length,
      errores: 0,
      contactados: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      responsable,
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
        responsable,
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
        responsable,
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
    await prepareWhatsAppPage(page, sendProgress, "coordinadores");
    page.setDefaultTimeout(CHAT_READY_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    console.log("[COORDINADORES] navegador listo; espero carga inicial de WhatsApp");
    sendProgress({
      type: "coordinadores",
      step: "whatsapp_loading",
      message: "Abriendo WhatsApp y esperando la carga inicial de chats",
    });

    await page.goto("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForWhatsAppShellReady(page, control, sendProgress);

    console.log("[COORDINADORES] WhatsApp cargado; abro cada chat por telefono");

    for (let i = 0; i < rows.length; i++) {
      await controlCheckpoint(control, sendProgress);

      if (contactados.length >= MAX_CONTACTS_PER_RUN) {
        stoppedByLimit = true;
        break;
      }

      const item = rows[i];

      if (sentPhonesThisRun.has(item.phone)) {
        await markRowsStatus(sheets, [item], DUPLICATE_STATUS, columns);
        duplicados.push({
          name: item.name,
          club: item.club,
          phone: item.phone,
          rowNumber: item.rowNumber,
          reason: DUPLICATE_STATUS,
        });

        sendProgress({
          type: "coordinadores",
          step: "item_duplicate",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          contactados: contactados.length,
          invalidos: invalidos.length,
          duplicados: duplicados.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
          responsable,
          message: `Se saltea ${item.name} porque este telefono ya fue procesado en esta corrida`,
        });
        continue;
      }

      const latestValues = await fetchSheetRows(sheets);
      const handledEntry = findHandledPhoneEntry(latestValues, columns, item.phone);

      if (handledEntry) {
        if (handledEntry.rowNumber !== item.rowNumber) {
          await markRowsStatus(sheets, [item], DUPLICATE_STATUS, columns);
          duplicados.push({
            name: item.name,
            club: item.club,
            phone: item.phone,
            rowNumber: item.rowNumber,
            firstRowNumber: handledEntry.rowNumber,
            reason: `${DUPLICATE_STATUS}: ya figura ${handledEntry.status} en fila ${handledEntry.rowNumber}`,
          });
        }

        sendProgress({
          type: "coordinadores",
          step: "item_already_contacted",
          current: i + 1,
          total: rows.length,
          name: item.name,
          club: item.club,
          contactados: contactados.length,
          invalidos: invalidos.length,
          duplicados: duplicados.length,
          errores: errores.length,
          maxPerRun: MAX_CONTACTS_PER_RUN,
          responsable,
          message:
            handledEntry.rowNumber === item.rowNumber
              ? `Se saltea ${item.name} porque esta fila ya tiene estado ${handledEntry.status}`
              : `Se saltea ${item.name} porque el telefono ya tiene estado ${handledEntry.status} en la fila ${handledEntry.rowNumber}`,
        });
        continue;
      }

      sentPhonesThisRun.add(item.phone);

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
        responsable,
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
        await markAsContacted(sheets, item.rowNumber, columns);

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
          responsable,
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
          responsable,
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
            await markRowsStatus(sheets, [item], INVALID_STATUS, columns);
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
            responsable,
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
          responsable,
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
      responsable,
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
      responsable,
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
        responsable,
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
      responsable,
      message: err.message,
    });

    return {
      date: new Date().toISOString(),
      type: "coordinadores",
      message: secondMessage,
      secondMessage,
      total: 0,
      maxPerRun: MAX_CONTACTS_PER_RUN,
      responsable,
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
  runCoordinadoresReminders,
  getCoordinadoresResponsables,
  buildSecondMessage,
  getSuggestedDate,
};
