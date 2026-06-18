#!/usr/bin/env node

const fs = require("fs");
const puppeteer = require("puppeteer");
const {
  WHATSAPP_SESSION_DIR,
  CHROME_EXECUTABLE_PATH,
} = require("./config");

const CRM_URL =
  process.env.CRM_SUPABASE_URL || "https://nsqqoiprxedhefurdmsn.supabase.co";
const CRM_ANON_KEY =
  process.env.CRM_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zcXFvaXByeGVkaGVmdXJkbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwODkwNzIsImV4cCI6MjA5NTY2NTA3Mn0.7tVMw3i8JKmp1XIEGC8sjihnBoWxnsmTPWd7JjuIQnQ";

const URGENCY_CRITICAL = "Cr\u00edtico";
const STATE_NEW = "Nuevo";
const STATE_IN_PROGRESS = "En gesti\u00f3n";
const INVALID_WHATSAPP_NUMBER = "Telefono invalido o sin WhatsApp";
const CONTACTED_RESULT = "En espera de respuesta";

const CRM_BOT_USERS = ["Ivo Unzaga", "Santiago Muller", "Facundo Lugo"];
const CRM_CREDENTIAL_ENV_KEYS = {
  "Ivo Unzaga": {
    user: ["CRM_IVO_USER", "CRM_IVO_UNZAGA_USER"],
    password: ["CRM_IVO_PASSWORD", "CRM_IVO_UNZAGA_PASSWORD"],
  },
  "Santiago Muller": {
    user: ["CRM_SANTIAGO_USER", "CRM_SANTIAGO_MULLER_USER"],
    password: ["CRM_SANTIAGO_PASSWORD", "CRM_SANTIAGO_MULLER_PASSWORD"],
  },
  "Facundo Lugo": {
    user: ["CRM_FACUNDO_USER", "CRM_FACUNDO_LUGO_USER"],
    password: ["CRM_FACUNDO_PASSWORD", "CRM_FACUNDO_LUGO_PASSWORD"],
  },
};

const DEFAULT_TUTOR_MESSAGE =
  "Buenas {tutor} c\u00f3mo est\u00e1s? Soy {responsable} de AFA en GLOOUDS. La idea era llamarte para charlar sobre el perfil de tu hijo {jugador}. Tenes 5 min para que te llame?";

const DEFAULT_PLAYER_MESSAGES = {
  Vencido:
    "Buenas {nombre}, como va? Soy {responsable} de AFA en GLOOUDS.\n\nChe te escribo para veamos que cosas tenemos podes mejorar de tu perfil para que que los seleccionadores de la AFA te elijan a vos por sobre el resto  \u00bfTen\u00e9s 5 minutos para que te llame?",
  [URGENCY_CRITICAL]:
    "Buenas {nombre}, como va? Soy {responsable} de AFA en GLOOUDS.\n\nChe te escribo para veamos que cosas tenemos podes mejorar de tu perfil para que que los seleccionadores de la AFA te elijan a vos por sobre el resto  \u00bfTen\u00e9s 5 minutos para que te llame?",
  "Pr\u00f3ximos":
    "Buenas {nombre}, como va? Soy {responsable} de AFA en GLOOUDS.\n\nChe te escribo para veamos que cosas tenemos podes mejorar de tu perfil para que que los seleccionadores de la AFA te elijan a vos por sobre el resto  \u00bfTen\u00e9s 5 minutos para que te llame?",
  Enganche:
    "Buenas {nombre}, como va? Soy {responsable} de AFA en GLOOUDS.\n\nChe te escribo para veamos que cosas tenemos podes mejorar de tu perfil para que que los seleccionadores de la AFA te elijan a vos por sobre el resto  \u00bfTen\u00e9s 5 minutos para que te llame?",
  Tranquilo:
    "Buenas {nombre}, como va? Soy {responsable} de AFA en GLOOUDS.\n\nChe te escribo para veamos que cosas tenemos podes mejorar de tu perfil para que que los seleccionadores de la AFA te elijan a vos por sobre el resto  \u00bfTen\u00e9s 5 minutos para que te llame?",
};

const CHAT_READY_TIMEOUT_MS = 25 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 120 * 1000;
const CHAT_OPEN_RETRIES = 2;
const CHAT_RETRY_DELAY_MS = 15 * 1000;
const SEND_CONFIRM_TIMEOUT_MS = 20 * 1000;
const DEFAULT_AFTER_SEND_SETTLE_MS = 15000;
const DEFAULT_BETWEEN_CONTACTS_MS = 90 * 1000;
const DEFAULT_BETWEEN_PLAYERS_MS = 90 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNoopControl() {
  return {
    async checkpoint() {},
    async interruptibleSleep(ms) {
      await sleep(ms);
    },
  };
}

async function controlCheckpoint(control, sendProgress) {
  const safeControl = control || createNoopControl();
  if (typeof safeControl.checkpoint === "function") {
    await safeControl.checkpoint(sendProgress);
  }
}

async function controlledSleep(control, ms, sendProgress) {
  const safeControl = control || createNoopControl();
  if (typeof safeControl.interruptibleSleep === "function") {
    await safeControl.interruptibleSleep(ms, sendProgress);
    return;
  }

  await sleep(ms);
}

function emitProgress(sendProgress, payload) {
  if (typeof sendProgress === "function") {
    sendProgress(payload);
  }
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

function getCrmBotUsers() {
  return [...CRM_BOT_USERS];
}

function findAllowedOperatorName(value) {
  const normalized = normalizeText(value);
  return CRM_BOT_USERS.find((name) => normalizeText(name) === normalized) || "";
}

function assertAllowedOperatorName(value) {
  const name = findAllowedOperatorName(value);
  if (!name) {
    throw new Error(`Usuario invalido. Elegi uno de: ${CRM_BOT_USERS.join(", ")}.`);
  }

  return name;
}

function normalizeResponsiblePlaceholder(template) {
  return cleanText(template)
    .replace(/Soy\s+Ivo\s+Unzaga\s+de\s+AFA/gi, "Soy {responsable} de AFA")
    .replace(/Soy\s+Ivo\s+de\s+AFA/gi, "Soy {responsable} de AFA");
}

function firstEnvValue(names) {
  for (const name of names) {
    const value = cleanText(process.env[name]);
    if (value) return value;
  }

  return "";
}

function getCrmCredentialKeysForOperator(operatorName) {
  const allowedName = findAllowedOperatorName(operatorName);
  return allowedName ? CRM_CREDENTIAL_ENV_KEYS[allowedName] : null;
}

function resolveCrmCredentials(operatorName) {
  const operatorKeys = getCrmCredentialKeysForOperator(operatorName);
  const username =
    (operatorKeys ? firstEnvValue(operatorKeys.user) : "") || cleanText(process.env.CRM_USER);
  const password =
    (operatorKeys ? firstEnvValue(operatorKeys.password) : "") ||
    cleanText(process.env.CRM_PASSWORD);

  if (username && password) {
    return {
      username,
      password,
    };
  }

  const expected = operatorKeys
    ? `${operatorKeys.user[0]} y ${operatorKeys.password[0]}`
    : "CRM_USER y CRM_PASSWORD";

  throw new Error(
    `Falta configurar ${expected} en .env. El usuario va sin @gloouds.app.`
  );
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ["true", "si", "yes", "1"].includes(normalizeText(value));
}

function parseBooleanEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = normalizeText(value);
  if (["1", "true", "si", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

function maskPhone(phone) {
  const digits = digitsFromValue(phone);
  if (digits.length <= 4) return digits || "-";
  return `${digits.slice(0, 5)}...${digits.slice(-4)}`;
}

function formatFullName(firstName, lastName, fallback) {
  return normalizeWhitespace([firstName, lastName].filter(Boolean).join(" ")) || fallback;
}

function getPlayerName(player) {
  return formatFullName(player.nombre, player.apellido, `Jugador ${player.id_usuario || ""}`.trim());
}

function getTutorName(player) {
  return formatFullName(player.tutor_nombre, player.tutor_apellido, "");
}

function parseCrmDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayAtMidnight() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function isEngagement(player, today) {
  if (player.tipo === "paga" || !player.inicio_trial) return false;
  const end = parseCrmDate(player.fin_trial);
  if (!end || end < today) return false;
  const start = parseCrmDate(player.inicio_trial);
  if (!start) return false;
  return Math.floor((today - start) / 864e5) >= 10;
}

function getUrgency(player, today = todayAtMidnight()) {
  if (player.tipo === "paga") return "Paga";
  const end = parseCrmDate(player.fin_trial);

  if (!end) return "Sin fecha";

  const daysLeft = Math.floor((end - today) / 864e5);

  if (daysLeft < 0) return "Vencido";
  if (daysLeft <= 10) return URGENCY_CRITICAL;
  if (daysLeft <= 20) return "Pr\u00f3ximos";
  if (isEngagement(player, today)) return "Enganche";

  return "Tranquilo";
}

function renderTemplate(template, player, profile, contact) {
  const playerName = getPlayerName(player);
  const tutorName = getTutorName(player);
  const responsibleName = normalizeWhitespace(profile.nombre);
  const club = player.clubes || {};
  const values = {
    nombre: playerName,
    jugador: playerName,
    jugador_nombre: playerName,
    jugador_email: cleanText(player.email),
    jugador_telefono: cleanText(player.telefono || player.telefono_priv),
    edad: cleanText(player.edad),
    tutor: tutorName,
    tutor_nombre: tutorName,
    tutor_telefono: cleanText(player.tutor_telefono),
    tutor_email: cleanText(player.tutor_email),
    responsable: responsibleName,
    contacto: contact?.label || "",
    urgencia: player.urgencia || getUrgency(player),
    club: cleanText(club.nombre),
    liga: cleanText(club.liga),
  };

  return normalizeResponsiblePlaceholder(template)
    .replace(/\\n/g, "\n")
    .replace(/\{([a-zA-Z_]+)\}/g, (match, key) => {
      return values[key] != null ? values[key] : match;
    })
    .replace(/\s+,/g, ",")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function resolveConfigMessage(configRows, type, urgency) {
  const row = configRows.find((item) => {
    if (item.tipo !== type) return false;

    try {
      return JSON.parse(item.valor).urgencia === urgency;
    } catch {
      return false;
    }
  });

  if (!row) return "";

  try {
    return cleanText(JSON.parse(row.valor).texto);
  } catch {
    return "";
  }
}

function buildPlayerMessage(player, profile, configRows, templates = {}) {
  const urgency = player.urgencia || getUrgency(player);
  const template =
    cleanText(templates.playerMessage) ||
    cleanText(process.env.CRM_PLAYER_MESSAGE) ||
    DEFAULT_PLAYER_MESSAGES[urgency] ||
    DEFAULT_PLAYER_MESSAGES.Tranquilo;

  return renderTemplate(template, player, profile, { label: "jugador" });
}

function buildTutorMessage(player, profile, templates = {}) {
  const template =
    cleanText(templates.tutorMessage) ||
    cleanText(process.env.CRM_TUTOR_MESSAGE) ||
    DEFAULT_TUTOR_MESSAGE;
  return renderTemplate(template, player, profile, { label: "tutor" });
}

function parseArgs(argv) {
  const options = {
    dryRun: parseBooleanEnv(process.env.CRM_DRY_RUN, true),
    updateCrm: parseBooleanEnv(process.env.CRM_UPDATE_CRM, true),
    limit: parseNumberEnv(process.env.CRM_CRITICAL_LIMIT, 20),
    fetchLimit: parseNumberEnv(process.env.CRM_CANDIDATE_FETCH_LIMIT, 20000),
    delayMs: parseNumberEnv(process.env.CRM_SEND_DELAY_MS, DEFAULT_BETWEEN_PLAYERS_MS),
    betweenContactsMs: parseNumberEnv(
      process.env.CRM_BETWEEN_CONTACTS_MS,
      DEFAULT_BETWEEN_CONTACTS_MS
    ),
    afterSendSettleMs: parseNumberEnv(
      process.env.CRM_AFTER_SEND_SETTLE_MS,
      DEFAULT_AFTER_SEND_SETTLE_MS
    ),
    operatorName: cleanText(process.env.CRM_OPERATOR_NAME),
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--send") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-crm-update") {
      options.updateCrm = false;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parseNumberEnv(arg.slice("--limit=".length), options.limit);
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = parseNumberEnv(arg.slice("--delay-ms=".length), options.delayMs);
    } else if (arg.startsWith("--between-contacts-ms=")) {
      options.betweenContactsMs = parseNumberEnv(
        arg.slice("--between-contacts-ms=".length),
        options.betweenContactsMs
      );
    } else if (arg.startsWith("--after-send-ms=")) {
      options.afterSendSettleMs = parseNumberEnv(
        arg.slice("--after-send-ms=".length),
        options.afterSendSettleMs
      );
    } else if (arg.startsWith("--user=")) {
      options.operatorName = cleanText(arg.slice("--user=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Bot CRM criticos

Uso:
  npm run crm:critical
  npm run crm:critical -- --send
  npm run crm:critical -- --limit=5 --dry-run
  npm run crm:critical -- --user="Ivo Unzaga" --send

Variables principales:
  CRM_IVO_USER          Usuario CRM de Ivo, sin @gloouds.app
  CRM_IVO_PASSWORD      Clave CRM de Ivo
  CRM_SANTIAGO_USER     Usuario CRM de Santiago, sin @gloouds.app
  CRM_SANTIAGO_PASSWORD Clave CRM de Santiago
  CRM_FACUNDO_USER      Usuario CRM de Facundo, sin @gloouds.app
  CRM_FACUNDO_PASSWORD  Clave CRM de Facundo
  CRM_OPERATOR_NAME     Ivo Unzaga, Santiago Muller o Facundo Lugo
  CRM_DRY_RUN           true por defecto; false manda mensajes
  CRM_CRITICAL_LIMIT    Jugadores maximos por corrida (20 por defecto)
  CRM_AFTER_SEND_SETTLE_MS Pausa despues de apretar enviar (15000 por defecto)
  CRM_BETWEEN_CONTACTS_MS  Pausa entre tutor/jugador (90000 por defecto)
  CRM_SEND_DELAY_MS        Pausa entre jugadores (90000 por defecto)
`);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseErrorMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  return payload.message || payload.msg || payload.error_description || payload.error || JSON.stringify(payload);
}

async function signInToCrm(operatorName = "") {
  if (!CRM_URL || !CRM_ANON_KEY) {
    throw new Error("Falta CRM_SUPABASE_URL o CRM_SUPABASE_ANON_KEY.");
  }

  const existingToken = cleanText(process.env.CRM_ACCESS_TOKEN);
  if (existingToken) {
    const user = await getAuthUser(existingToken);
    return {
      accessToken: existingToken,
      user,
    };
  }

  const { username, password } = resolveCrmCredentials(operatorName);

  const email = username.includes("@")
    ? username.toLowerCase()
    : `${username.toLowerCase()}@gloouds.app`;

  const response = await fetch(`${CRM_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: CRM_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Login CRM fallido: ${responseErrorMessage(payload)}`);
  }

  const accessToken = payload.access_token || payload.session?.access_token;
  const user = payload.user || payload.session?.user || (await getAuthUser(accessToken));

  if (!accessToken || !user) {
    throw new Error("Login CRM fallido: no se recibio sesion.");
  }

  return {
    accessToken,
    user,
  };
}

async function getAuthUser(accessToken) {
  const response = await fetch(`${CRM_URL}/auth/v1/user`, {
    headers: {
      apikey: CRM_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`No pude leer el usuario autenticado: ${responseErrorMessage(payload)}`);
  }

  return payload;
}

function makeContext(session) {
  return {
    accessToken: session.accessToken,
    user: session.user,
  };
}

function makeRestUrl(path, params = {}) {
  const url = new URL(`${CRM_URL}/rest/v1/${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    url.searchParams.append(key, String(value));
  }

  return url;
}

async function crmRest(ctx, method, path, params = {}, body, prefer) {
  const headers = {
    apikey: CRM_ANON_KEY,
    Authorization: `Bearer ${ctx.accessToken}`,
    Accept: "application/json",
  };

  if (body != null) {
    headers["Content-Type"] = "application/json";
  }

  if (prefer) {
    headers.Prefer = prefer;
  }

  const response = await fetch(makeRestUrl(path, params), {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`${method} ${path} fallo: ${responseErrorMessage(payload)}`);
  }

  return payload;
}

async function selectRows(ctx, table, params = {}) {
  const rows = await crmRest(ctx, "GET", table, params);
  return Array.isArray(rows) ? rows : [];
}

async function invokeVincularPerfil(ctx) {
  const response = await fetch(`${CRM_URL}/functions/v1/vincular-perfil`, {
    method: "POST",
    headers: {
      apikey: CRM_ANON_KEY,
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) return null;

  const payload = await readJsonResponse(response);
  return payload?.perfil || null;
}

async function resolveProfile(ctx) {
  const authUser = ctx.user;
  const email = cleanText(authUser.email);

  const byId = await selectRows(ctx, "usuarios", {
    select: "*",
    id: `eq.${authUser.id}`,
    limit: 1,
  });

  if (byId[0]) return byId[0];

  if (email) {
    const byEmail = await selectRows(ctx, "usuarios", {
      select: "*",
      email: `eq.${email}`,
      limit: 1,
    });

    if (byEmail[0]) {
      const linked = await invokeVincularPerfil(ctx).catch(() => null);
      return linked || { ...byEmail[0], id: authUser.id };
    }
  }

  if (email) {
    const prefix = email.split("@")[0];
    const byName = await selectRows(ctx, "usuarios", {
      select: "*",
      nombre: `ilike.${prefix}%`,
      limit: 1,
    });

    if (byName[0]) {
      const linked = await invokeVincularPerfil(ctx).catch(() => null);
      return linked || { ...byName[0], id: authUser.id };
    }
  }

  throw new Error("No encontre el perfil del usuario CRM en la tabla usuarios.");
}

function matchesOperatorProfile(user, allowedName) {
  const userName = normalizeText(user.nombre);
  const selected = normalizeText(allowedName);

  if (userName === selected) return true;
  if (selected === "santiago muller") return userName.startsWith("santiago") && /\bm/.test(userName);

  return userName.includes(selected);
}

async function resolveOperatorProfile(ctx, operatorName, fallbackProfile) {
  const selectedName = cleanText(operatorName);

  if (!selectedName) {
    return fallbackProfile;
  }

  const allowedName = assertAllowedOperatorName(selectedName);
  const activeUsers = await selectRows(ctx, "usuarios", {
    select: "id,nombre,email,rol,empresa,activo",
    activo: "eq.true",
    limit: 1000,
    order: "nombre.asc",
  });

  const exact = activeUsers.find((user) => matchesOperatorProfile(user, allowedName));
  if (exact) return exact;

  throw new Error(`No encontre a ${allowedName} como usuario activo en el CRM.`);
}

async function fetchActiveConfig(ctx) {
  return await selectRows(ctx, "config", {
    select: "tipo,valor,orden,activo",
    activo: "eq.true",
    limit: 1000,
    order: "tipo.asc,orden.asc",
  });
}

async function fetchCandidateRows(ctx, fetchLimit) {
  const params = {
    select: "*,clubes(nombre,liga)",
    responsable: "is.null",
    trazabilidad: "eq.true",
    limit: fetchLimit,
    order: "fin_trial.asc.nullslast",
  };

  try {
    return await selectRows(ctx, "v_jugadores", params);
  } catch (err) {
    console.warn(`[CRM] No pude traer clubes embebidos, reintento simple: ${err.message}`);
    return await selectRows(ctx, "v_jugadores", {
      ...params,
      select: "*",
    });
  }
}

function filterCriticalCandidates(rows) {
  const today = todayAtMidnight();

  return rows.filter((row) => {
    if (!isTruthy(row.trazabilidad)) return false;
    if (cleanText(row.responsable)) return false;

    const urgency = row.urgencia || getUrgency(row, today);
    return urgency === URGENCY_CRITICAL;
  });
}

function buildContactsForPlayer(player, profile, configRows, templates = {}) {
  const contacts = [];
  const isMinor = isTruthy(player.es_menor);
  const playerPhone = sanitizeArgentinaPhone(player.telefono || player.telefono_priv);
  const tutorPhone = sanitizeArgentinaPhone(player.tutor_telefono);
  const playerName = getPlayerName(player);
  const tutorName = getTutorName(player);

  if (isMinor) {
    if (tutorPhone) {
      contacts.push({
        role: "tutor",
        label: tutorName || "Tutor",
        phone: tutorPhone,
        message: buildTutorMessage(player, profile, templates),
      });
    }

    if (playerPhone) {
      contacts.push({
        role: "jugador",
        label: playerName,
        phone: playerPhone,
        message: buildPlayerMessage(player, profile, configRows, templates),
      });
    }
  } else if (playerPhone) {
    contacts.push({
      role: "jugador",
      label: playerName,
      phone: playerPhone,
      message: buildPlayerMessage(player, profile, configRows, templates),
    });
  }

  return contacts;
}

function prepareWorkItems(rows, profile, configRows, limit, templates = {}) {
  const seenPhones = new Set();
  const selectedRows = rows.slice(0, limit || rows.length);

  return selectedRows.map((player) => {
    const rawContacts = buildContactsForPlayer(player, profile, configRows, templates);
    const contacts = [];
    const skippedContacts = [];

    for (const contact of rawContacts) {
      if (seenPhones.has(contact.phone)) {
        skippedContacts.push({
          ...contact,
          reason: "Telefono duplicado en esta corrida",
        });
        continue;
      }

      seenPhones.add(contact.phone);
      contacts.push(contact);
    }

    return {
      player,
      playerName: getPlayerName(player),
      isMinor: isTruthy(player.es_menor),
      contacts,
      skippedContacts,
    };
  });
}

function getWorkItemSkipReason(item) {
  if (item.contacts.length) return "";
  if (item.skippedContacts.length) {
    return item.skippedContacts.map((contact) => contact.reason).join(" | ");
  }

  return "Sin telefono util para jugador/tutor";
}

function makeSkippedWorkItem(item, reason = getWorkItemSkipReason(item)) {
  return {
    id: item.player.id_usuario,
    name: item.playerName,
    reason,
  };
}

function selectContactableWorkItems(workItems, limit) {
  const selected = [];
  const skipped = [];
  const target = limit || workItems.length;

  for (const item of workItems) {
    if (selected.length >= target) break;

    if (!item.contacts.length) {
      skipped.push(makeSkippedWorkItem(item));
      continue;
    }

    selected.push(item);
  }

  return {
    workItems: selected,
    skipped,
  };
}

function summarizeWorkItems(workItems) {
  const totalContacts = workItems.reduce((sum, item) => sum + item.contacts.length, 0);
  const withoutContacts = workItems.filter((item) => item.contacts.length === 0).length;
  const minors = workItems.filter((item) => item.isMinor).length;

  return {
    players: workItems.length,
    contacts: totalContacts,
    minors,
    withoutContacts,
  };
}

function printDryRun(workItems, totalCandidates) {
  const summary = summarizeWorkItems(workItems);

  console.log("[CRM] Modo prueba activado. No se manda WhatsApp ni se escribe el CRM.");
  console.log(
    `[CRM] Candidatos criticos sin responsable: ${totalCandidates}. En esta corrida: ${summary.players} jugadores, ${summary.contacts} contactos.`
  );
  console.log(`[CRM] Menores: ${summary.minors}. Sin telefono util: ${summary.withoutContacts}.`);

  workItems.forEach((item, index) => {
    const type = item.isMinor ? "menor" : "mayor";
    const targets = item.contacts
      .map((contact) => `${contact.role} ${maskPhone(contact.phone)}`)
      .join(", ");
    const skipped = item.skippedContacts.length
      ? ` | salteados: ${item.skippedContacts.map((contact) => contact.role).join(", ")}`
      : "";

    console.log(
      `[${index + 1}] ${item.playerName} (${type}, id ${item.player.id_usuario}) -> ${
        targets || "sin contacto"
      }${skipped}`
    );
  });
}

function buildWhatsAppUrl(phone) {
  return `https://web.whatsapp.com/send/?phone=${phone}&type=phone_number&app_absent=0`;
}

async function getComposer(page) {
  const selectors = [
    '[contenteditable="true"][role="textbox"][aria-placeholder]',
    '[contenteditable="true"][aria-placeholder="Escribe un mensaje"]',
    '[contenteditable="true"][aria-placeholder="Type a message"]',
    '[aria-label^="Escribir un mensaje"]',
    '[aria-label^="Type a message"]',
    "#main footer [contenteditable=\"true\"]",
    'footer [contenteditable="true"][role="textbox"]',
    'footer [contenteditable="true"]',
    '[aria-label="Escribe un mensaje"]',
    '[aria-label="Type a message"]',
  ];

  for (const selector of selectors) {
    const box = await page
      .waitForSelector(selector, {
        timeout: 5000,
        visible: true,
      })
      .catch(() => null);

    if (box) return box;
  }

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
    const button = await page.$(selector);

    if (button) {
      const clickable = await button.evaluateHandle((el) => el.closest("button") || el);
      const element = clickable.asElement();

      if (element) {
        await element.click();
      } else {
        await button.click();
      }

      return true;
    }
  }

  return false;
}

async function waitForComposerEmpty(page, timeout = SEND_CONFIRM_TIMEOUT_MS) {
  return await page
    .waitForFunction(
      () => {
        const selectors = [
          "#main footer [contenteditable=\"true\"]",
          'footer [contenteditable="true"][role="textbox"]',
          'footer [contenteditable="true"]',
          '[contenteditable="true"][role="textbox"][aria-placeholder]',
          '[contenteditable="true"][aria-placeholder]',
        ];

        const isVisible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };

        const seen = new Set();
        const boxes = [];

        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (!seen.has(element) && isVisible(element)) {
              seen.add(element);
              boxes.push(element);
            }
          }
        }

        const target = boxes[boxes.length - 1];
        if (!target) return true;

        const text = (target.innerText || target.textContent || "")
          .replace(/\u200b/g, "")
          .replace(/\u00a0/g, " ")
          .trim();

        return text === "";
      },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function isInvalidWhatsAppNumber(page) {
  const patterns = [
    "no esta en whatsapp",
    "no est\u00e1 en whatsapp",
    "isn't on whatsapp",
    "not on whatsapp",
    "phone number shared via url is invalid",
    "numero de telefono no es valido",
    "n\u00famero de tel\u00e9fono no es v\u00e1lido",
  ];

  return await page
    .evaluate((items) => {
      const bodyText = (document.body?.innerText || "").toLowerCase();
      return items.some((item) => bodyText.includes(item));
    }, patterns)
    .catch(() => false);
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
  return await page
    .evaluate(() => {
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
    })
    .catch(() => "");
}

async function isWhatsAppShellLoaded(page) {
  return await page
    .evaluate(() => {
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

      const hasLoadedAppText =
        /WhatsApp/i.test(title) &&
        (/Todos|No leidos|No le\u00eddos|Favoritos|Grupos|Chats|Buscar|Search|Unread/i.test(text) ||
          text.length > 250);

      return hasKnownShell || hasLoadedAppText;
    })
    .catch(() => false);
}

async function waitForWhatsAppShellReady(page) {
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let qrAlreadyReported = false;

  while (Date.now() - startedAt < CHAT_READY_TIMEOUT_MS) {
    if (await isQrVisible(page)) {
      if (!qrAlreadyReported) {
        qrAlreadyReported = true;
        console.log("[WHATSAPP] Escanea el QR para continuar.");
      }

      await sleep(1500);
      continue;
    }

    if (await isWhatsAppShellLoaded(page)) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds - lastProgressAt >= 10) {
      lastProgressAt = elapsedSeconds;
      const loadingLabel = await getWhatsAppLoadingLabel(page);
      console.log(
        `[WHATSAPP] ${loadingLabel || "Cargando WhatsApp"}... ${elapsedSeconds}s`
      );
    }

    await sleep(1000);
  }

  throw new Error("Timeout cargando WhatsApp.");
}

async function getActiveChatSignature(page) {
  return await page
    .evaluate(() => {
      const selectors = ["#main header span[title]", "#main header [title]", "#main header"];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = (element?.getAttribute("title") || element?.innerText || "").trim();
        if (text) return text.replace(/\s+/g, " ");
      }

      return "";
    })
    .catch(() => "");
}

async function getComposerSignature(page) {
  return await page
    .evaluate(() => {
      const selectors = [
        '[contenteditable="true"][role="textbox"][aria-placeholder]',
        '[contenteditable="true"][aria-placeholder]',
        '[aria-label^="Escribir un mensaje"]',
        '[aria-label^="Type a message"]',
        "#main footer [contenteditable=\"true\"]",
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
        const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
        const text = (
          element?.getAttribute("aria-label") ||
          element?.getAttribute("aria-placeholder") ||
          element?.innerText ||
          ""
        ).trim();

        if (text) return text.replace(/\s+/g, " ");
      }

      return "";
    })
    .catch(() => "");
}

function signatureMatchesPhone(signature, phone) {
  const signatureDigits = digitsFromValue(signature);
  const phoneDigits = digitsFromValue(phone);
  const suffix = phoneDigits.slice(-8);

  return suffix.length >= 8 && signatureDigits.includes(suffix);
}

async function hasMessageComposer(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[contenteditable="true"][role="textbox"][aria-placeholder]',
      '[contenteditable="true"][aria-placeholder="Escribe un mensaje"]',
      '[contenteditable="true"][aria-placeholder="Type a message"]',
      '[aria-label^="Escribir un mensaje"]',
      '[aria-label^="Type a message"]',
      "#main footer [contenteditable=\"true\"]",
      'footer [contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"]',
      '[aria-label="Escribe un mensaje"]',
      '[aria-label="Type a message"]',
    ];

    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
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

async function clearBeforeUnloadHandlers(page) {
  await page
    .evaluate(() => {
      try {
        window.onbeforeunload = null;
      } catch {}
    })
    .catch(() => {});
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

function attachDialogAutoHandler(page) {
  if (page.__crmCriticalDialogHandlerAttached) return;
  page.__crmCriticalDialogHandlerAttached = true;

  page.on("dialog", async (dialog) => {
    const message = normalizeText(dialog.message());
    const shouldLeave =
      dialog.type() === "beforeunload" ||
      message.includes("abandonar") ||
      message.includes("salir del sitio") ||
      message.includes("leave site") ||
      message.includes("reload this site");

    try {
      if (shouldLeave) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    } catch (err) {
      console.error("[WHATSAPP] No pude cerrar un dialogo del navegador:", err.message);
    }
  });
}

async function prepareWhatsAppPage(page) {
  attachDialogAutoHandler(page);
  await installBeforeUnloadBlocker(page);
}

async function waitForChatReady(page, contact, previousSignature) {
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let qrAlreadyReported = false;

  while (Date.now() - startedAt < CHAT_READY_TIMEOUT_MS) {
    if (await isQrVisible(page)) {
      if (!qrAlreadyReported) {
        qrAlreadyReported = true;
        console.log("[WHATSAPP] Escanea el QR para continuar.");
      }

      await sleep(1500);
      continue;
    }

    if (await isInvalidWhatsAppNumber(page)) {
      throw new Error(INVALID_WHATSAPP_NUMBER);
    }

    if (await hasMessageComposer(page)) {
      const currentSignature = await getActiveChatSignature(page);
      const composerSignature = await getComposerSignature(page);
      const currentUrl = page.url();
      const urlIncludesPhone = decodeURIComponent(currentUrl).includes(contact.phone);
      const signatureChanged = Boolean(
        previousSignature &&
          currentSignature &&
          currentSignature !== previousSignature
      );
      const signatureMatches = signatureMatchesPhone(currentSignature, contact.phone);
      const composerMatches = signatureMatchesPhone(composerSignature, contact.phone);

      if (urlIncludesPhone || signatureChanged || signatureMatches || composerMatches) {
        return;
      }
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds - lastProgressAt >= 10) {
      lastProgressAt = elapsedSeconds;
      const loadingLabel = await getWhatsAppLoadingLabel(page);
      console.log(
        `[WHATSAPP] ${loadingLabel || `Abriendo chat de ${contact.label}`}... ${elapsedSeconds}s`
      );
    }

    await sleep(1000);
  }

  throw new Error(`Timeout abriendo el chat de ${contact.label}.`);
}

async function openChat(page, contact) {
  let lastError = null;

  for (let attempt = 1; attempt <= CHAT_OPEN_RETRIES; attempt++) {
    try {
      const previousSignature = await getActiveChatSignature(page);
      const url = buildWhatsAppUrl(contact.phone);

      console.log(
        `[WHATSAPP] Abriendo ${contact.role} ${contact.label} (${attempt}/${CHAT_OPEN_RETRIES})`
      );

      await clearBeforeUnloadHandlers(page);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await clearBeforeUnloadHandlers(page);
      await sleep(3000);
      await waitForChatReady(page, contact, previousSignature);
      return;
    } catch (err) {
      if (err.message === INVALID_WHATSAPP_NUMBER) {
        throw err;
      }

      lastError = err;
      console.error(`[WHATSAPP] Error abriendo chat: ${err.message}`);

      if (attempt < CHAT_OPEN_RETRIES) {
        await sleep(CHAT_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error("No se pudo abrir el chat.");
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    const clicked = await clickSend(page);
    if (clicked && (await waitForComposerEmpty(page))) {
      return;
    }

    await page.keyboard.press("Enter");
    if (await waitForComposerEmpty(page)) {
      return;
    }
  }

  const stillHasText = !(await waitForComposerEmpty(page, 1000));
  if (stillHasText) {
    throw new Error("WhatsApp no confirmo el envio: el mensaje quedo en la caja.");
  }
}

async function openChatAndSend(page, contact) {
  await openChat(page, contact);
  await sendMessage(page, contact.message);
}

async function launchWhatsApp() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: WHATSAPP_SESSION_DIR,
    executablePath: fs.existsSync(CHROME_EXECUTABLE_PATH)
      ? CHROME_EXECUTABLE_PATH
      : undefined,
    defaultViewport: null,
    args: ["--start-maximized"],
  });

  const page = await browser.newPage();
  await prepareWhatsAppPage(page);
  page.setDefaultTimeout(CHAT_READY_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  console.log("[WHATSAPP] Abriendo WhatsApp Web...");
  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await waitForWhatsAppShellReady(page);

  return { browser, page };
}

async function claimPlayerForOperator(ctx, profile, item, options = {}) {
  const player = item.player;
  const now = new Date().toISOString();
  const update = {
    responsable: profile.id,
    updated_at: now,
  };

  if (!cleanText(player.estado) || cleanText(player.estado) === STATE_NEW) {
    update.estado = STATE_IN_PROGRESS;
  }

  const params = {
    id_usuario: `eq.${player.id_usuario}`,
    select: "id_usuario,responsable,estado,updated_at",
  };

  if (options.onlyIfUnassigned) {
    params.responsable = "is.null";
  }

  const updatedRows = await crmRest(
    ctx,
    "PATCH",
    "jugadores",
    params,
    update,
    "return=representation"
  );
  const updatedRow = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;

  if (options.onlyIfUnassigned && !updatedRow) {
    return {
      claimed: false,
      reason: "Ya fue tomado por otro usuario",
    };
  }

  await crmRest(
    ctx,
    "POST",
    "actividad",
    {},
    {
      caso_tipo: "jugador",
      caso_id: player.id_usuario,
      usuario: profile.id,
      texto: `Bot CRM criticos: tomo el caso y guardo gestion para ${profile.nombre || profile.id}`,
    }
  );

  item.player = {
    ...item.player,
    ...update,
    ...(updatedRow || {}),
  };

  return {
    claimed: true,
  };
}

async function claimWorkBatchForOperator(
  ctx,
  profile,
  candidateWorkItems,
  options,
  sendProgress = () => {}
) {
  const claimed = [];
  const skipped = [];
  const target = options.limit || candidateWorkItems.length;

  emitProgress(sendProgress, {
    step: "claiming_batch",
    total: target,
    current: 0,
    contactados: 0,
    skipped: 0,
    errores: 0,
    message: `Tomando hasta ${target} casos antes de contactar`,
  });

  for (const item of candidateWorkItems) {
    if (claimed.length >= target) break;

    await controlCheckpoint(options.control, sendProgress);

    if (!item.contacts.length) {
      skipped.push(makeSkippedWorkItem(item));
      emitProgress(sendProgress, {
        step: "case_claim_skipped",
        total: target,
        current: claimed.length,
        name: item.playerName,
        skipped: skipped.length,
        message: `${item.playerName} salteado: ${getWorkItemSkipReason(item)}`,
      });
      continue;
    }

    emitProgress(sendProgress, {
      step: "claiming_case",
      total: target,
      current: claimed.length + 1,
      name: item.playerName,
      skipped: skipped.length,
      message: `Tomando caso ${claimed.length + 1}/${target}: ${item.playerName}`,
    });

    const result = await claimPlayerForOperator(ctx, profile, item, {
      onlyIfUnassigned: true,
    });

    if (!result.claimed) {
      skipped.push(makeSkippedWorkItem(item, result.reason));
      emitProgress(sendProgress, {
        step: "case_claim_skipped",
        total: target,
        current: claimed.length,
        name: item.playerName,
        skipped: skipped.length,
        message: `${item.playerName} ya fue tomado por otra persona`,
      });
      continue;
    }

    claimed.push(item);
    emitProgress(sendProgress, {
      step: "case_claimed",
      total: target,
      current: claimed.length,
      name: item.playerName,
      skipped: skipped.length,
      message: `Caso tomado: ${item.playerName}`,
    });
  }

  return {
    workItems: claimed,
    skipped,
  };
}

async function registerContactAttempt(ctx, profile, item, contact, result = CONTACTED_RESULT) {
  const player = item.player;

  await crmRest(
    ctx,
    "POST",
    "intentos",
    {},
    {
      caso_tipo: "jugador",
      caso_id: player.id_usuario,
      canal: "WhatsApp",
      resultado: result,
      usuario: profile.id,
    }
  );

  await crmRest(
    ctx,
    "POST",
    "actividad",
    {},
    {
      caso_tipo: "jugador",
      caso_id: player.id_usuario,
      usuario: profile.id,
      texto:
        result === CONTACTED_RESULT
          ? `Bot CRM criticos: envio WhatsApp a ${contact.role}`
          : `Bot CRM criticos: intento WA a ${contact.role} - ${result}`,
    }
  );
}

async function runSending(ctx, profile, workItems, options, sendProgress = () => {}) {
  const results = {
    sentPlayers: [],
    errors: [],
    skipped: [],
  };

  let browser = null;

  try {
    const launched = await launchWhatsApp();
    browser = launched.browser;
    const page = launched.page;

    for (let index = 0; index < workItems.length; index++) {
      await controlCheckpoint(options.control, sendProgress);

      const item = workItems[index];

      if (!item.contacts.length) {
        results.skipped.push({
          id: item.player.id_usuario,
          name: item.playerName,
          reason: "Sin telefono util para jugador/tutor",
        });
        continue;
      }

      console.log(
        `[CRM] Procesando ${index + 1}/${workItems.length}: ${item.playerName} (${item.contacts.length} contacto/s)`
      );
      emitProgress(sendProgress, {
        step: "processing",
        current: index + 1,
        total: workItems.length,
        name: item.playerName,
        contactados: results.sentPlayers.length,
        skipped: results.skipped.length,
        errores: results.errors.length,
        message: `Procesando ${item.playerName}`,
      });

      emitProgress(sendProgress, {
        step: "management_saved",
        current: index + 1,
        total: workItems.length,
        name: item.playerName,
        message: `Caso ya tomado y gestion guardada para ${item.playerName}`,
      });

      const contactResults = [];
      const contactErrors = [];

      for (let contactIndex = 0; contactIndex < item.contacts.length; contactIndex++) {
        const contact = item.contacts[contactIndex];
        await controlCheckpoint(options.control, sendProgress);

        try {
          emitProgress(sendProgress, {
            step: "contact_opening",
            current: index + 1,
            total: workItems.length,
            name: item.playerName,
            role: contact.role,
            message: `Abriendo WhatsApp de ${contact.role}`,
          });

          await openChatAndSend(page, contact);

          if (options.afterSendSettleMs > 0) {
            emitProgress(sendProgress, {
              step: "after_send_wait",
              current: index + 1,
              total: workItems.length,
              name: item.playerName,
              role: contact.role,
              message: `Esperando ${Math.round(options.afterSendSettleMs / 1000)}s para confirmar el envio`,
            });
            await controlledSleep(options.control, options.afterSendSettleMs, sendProgress);
          }

          if (options.updateCrm) {
            await registerContactAttempt(ctx, profile, item, contact, CONTACTED_RESULT);
          }

          contactResults.push({
            role: contact.role,
            phone: contact.phone,
          });
          console.log(`[CRM] Mensaje enviado a ${contact.role} ${maskPhone(contact.phone)}`);
          emitProgress(sendProgress, {
            step: "contact_success",
            current: index + 1,
            total: workItems.length,
            name: item.playerName,
            role: contact.role,
            contactados: results.sentPlayers.length,
            message: `WhatsApp enviado a ${contact.role}`,
          });

          if (contactIndex < item.contacts.length - 1 && options.betweenContactsMs > 0) {
            emitProgress(sendProgress, {
              step: "between_contacts",
              current: index + 1,
              total: workItems.length,
              name: item.playerName,
              role: contact.role,
              message: `Pausa de ${Math.round(options.betweenContactsMs / 1000)}s antes del proximo contacto`,
            });
            await controlledSleep(options.control, options.betweenContactsMs, sendProgress);
          }
        } catch (err) {
          contactErrors.push({
            role: contact.role,
            phone: contact.phone,
            reason: err.message || "Error sin detalle",
          });
          console.error(
            `[CRM] Error con ${item.playerName} / ${contact.role}: ${err.message}`
          );
        }
      }

      if (contactResults.length) {
        results.sentPlayers.push({
          id: item.player.id_usuario,
          name: item.playerName,
          contacts: contactResults,
          contactErrors,
        });
      } else {
        results.errors.push({
          id: item.player.id_usuario,
          name: item.playerName,
          reason: contactErrors.map((error) => error.reason).join(" | "),
        });
      }

      if (index < workItems.length - 1 && options.delayMs > 0) {
        console.log(`[CRM] Pausa de ${Math.round(options.delayMs / 1000)}s antes del proximo jugador.`);
        emitProgress(sendProgress, {
          step: "between_players",
          current: index + 1,
          total: workItems.length,
          name: item.playerName,
          message: `Pausa de ${Math.round(options.delayMs / 1000)}s antes del proximo jugador`,
        });
        await controlledSleep(options.control, options.delayMs, sendProgress);
      }
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return results;
}

function buildRuntimeOptions(options = {}) {
  return {
    dryRun: parseBooleanEnv(process.env.CRM_DRY_RUN, true),
    updateCrm: parseBooleanEnv(process.env.CRM_UPDATE_CRM, true),
    limit: parseNumberEnv(process.env.CRM_CRITICAL_LIMIT, 20),
    fetchLimit: parseNumberEnv(process.env.CRM_CANDIDATE_FETCH_LIMIT, 20000),
    delayMs: parseNumberEnv(process.env.CRM_SEND_DELAY_MS, DEFAULT_BETWEEN_PLAYERS_MS),
    betweenContactsMs: parseNumberEnv(
      process.env.CRM_BETWEEN_CONTACTS_MS,
      DEFAULT_BETWEEN_CONTACTS_MS
    ),
    afterSendSettleMs: parseNumberEnv(
      process.env.CRM_AFTER_SEND_SETTLE_MS,
      DEFAULT_AFTER_SEND_SETTLE_MS
    ),
    operatorName: cleanText(process.env.CRM_OPERATOR_NAME),
    playerMessage: "",
    tutorMessage: "",
    ...options,
  };
}

async function runCrmCriticalBot(sendProgress = () => {}, options = {}) {
  const runtimeOptions = buildRuntimeOptions(options);
  runtimeOptions.operatorName = cleanText(runtimeOptions.operatorName);

  await controlCheckpoint(runtimeOptions.control, sendProgress);

  emitProgress(sendProgress, {
    step: "starting",
    operatorName: runtimeOptions.operatorName,
    dryRun: runtimeOptions.dryRun,
    message: runtimeOptions.dryRun
      ? "Buscando jugadores criticos en modo prueba"
      : "Iniciando bot CRM criticos",
  });

  if (runtimeOptions.operatorName) {
    assertAllowedOperatorName(runtimeOptions.operatorName);
  }

  console.log("[CRM] Login...");
  const session = await signInToCrm(runtimeOptions.operatorName);
  const ctx = makeContext(session);
  const authProfile = await resolveProfile(ctx);
  const profile = await resolveOperatorProfile(ctx, runtimeOptions.operatorName, authProfile);
  console.log(`[CRM] Perfil operador: ${profile.nombre || profile.email || profile.id}`);

  await controlCheckpoint(runtimeOptions.control, sendProgress);

  const [configRows, rawRows] = await Promise.all([
    fetchActiveConfig(ctx),
    fetchCandidateRows(ctx, runtimeOptions.fetchLimit),
  ]);

  const candidates = filterCriticalCandidates(rawRows);
  const allWorkItems = prepareWorkItems(candidates, profile, configRows, undefined, {
    playerMessage: runtimeOptions.playerMessage,
    tutorMessage: runtimeOptions.tutorMessage,
  });

  let workItems = [];
  let claimSkipped = [];

  if (runtimeOptions.dryRun || !runtimeOptions.updateCrm) {
    const selection = selectContactableWorkItems(allWorkItems, runtimeOptions.limit);
    workItems = selection.workItems;
    claimSkipped = selection.skipped;
  } else {
    const claimResult = await claimWorkBatchForOperator(
      ctx,
      profile,
      allWorkItems,
      runtimeOptions,
      sendProgress
    );
    workItems = claimResult.workItems;
    claimSkipped = claimResult.skipped;
  }

  const summary = summarizeWorkItems(workItems);

  emitProgress(sendProgress, {
    step: "rows_ready",
    total: workItems.length,
    candidates: candidates.length,
    contacts: summary.contacts,
    menores: summary.minors,
    sinTelefono: summary.withoutContacts + claimSkipped.length,
    contactados: 0,
    skipped: claimSkipped.length,
    errores: 0,
    dryRun: runtimeOptions.dryRun,
    operatorName: profile.nombre || runtimeOptions.operatorName,
    message: runtimeOptions.dryRun || !runtimeOptions.updateCrm
      ? `Se encontraron ${candidates.length} jugadores criticos sin asignar`
      : `Se tomaron ${workItems.length} casos de ${candidates.length} candidatos`,
  });

  if (runtimeOptions.dryRun) {
    printDryRun(workItems, candidates.length);
    return {
      date: new Date().toISOString(),
      type: "crmCritical",
      dryRun: true,
      operatorName: profile.nombre || runtimeOptions.operatorName || "",
      total: workItems.length,
      candidates: candidates.length,
      contacts: summary.contacts,
      menores: summary.minors,
      sinTelefono: summary.withoutContacts + claimSkipped.length,
      contactados: [],
      skipped: claimSkipped,
      errores: [],
    };
  }

  if (!workItems.length) {
    console.log("[CRM] No se pudo tomar ningun caso contactable para esta corrida.");
    return {
      date: new Date().toISOString(),
      type: "crmCritical",
      dryRun: false,
      operatorName: profile.nombre || runtimeOptions.operatorName || "",
      total: 0,
      candidates: candidates.length,
      contacts: 0,
      menores: 0,
      sinTelefono: claimSkipped.length,
      contactados: [],
      skipped: claimSkipped,
      errores: [],
    };
  }

  console.log(
    `[CRM] Modo envio activo. Se procesan ${workItems.length} jugadores de ${candidates.length} candidatos.`
  );

  const results = await runSending(ctx, profile, workItems, runtimeOptions, sendProgress);
  const allSkipped = [...claimSkipped, ...results.skipped];

  console.log(
    `[CRM] Listo. Jugadores contactados: ${results.sentPlayers.length}. Errores: ${results.errors.length}. Salteados: ${allSkipped.length}.`
  );

  if (results.errors.length) {
    console.log("[CRM] Errores:");
    results.errors.forEach((error) => {
      console.log(`- ${error.name} (${error.id}): ${error.reason}`);
    });
  }

  emitProgress(sendProgress, {
    step: "finished",
    total: workItems.length,
    contactados: results.sentPlayers.length,
    skipped: allSkipped.length,
    errores: results.errors.length,
    operatorName: profile.nombre || runtimeOptions.operatorName,
    message: "Bot CRM criticos finalizado",
  });

  return {
    date: new Date().toISOString(),
    type: "crmCritical",
    dryRun: false,
    operatorName: profile.nombre || runtimeOptions.operatorName || "",
    total: workItems.length,
    candidates: candidates.length,
    contacts: summary.contacts,
    menores: summary.minors,
    sinTelefono: summary.withoutContacts + claimSkipped.length,
    contactados: results.sentPlayers,
    skipped: allSkipped,
    errores: results.errors,
  };
}

async function main() {
  const options = parseArgs(process.argv);

  if (options.help) {
    printHelp();
    return;
  }

  await runCrmCriticalBot(() => {}, options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[CRM] ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CRM_BOT_USERS,
  getCrmBotUsers,
  runCrmCriticalBot,
};
