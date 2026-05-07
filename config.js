const fs = require("fs");
const path = require("path");

const ROOT_DIR = __dirname;
const ENV_PATH = path.join(ROOT_DIR, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;

  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function resolveFromRoot(value, fallback) {
  const selected = value || fallback;
  if (!selected) return "";
  return path.isAbsolute(selected) ? selected : path.join(ROOT_DIR, selected);
}

loadEnvFile();

const config = {
  PORT: Number(process.env.PORT || 3000),
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || "",
  DETAIL_SHEET_NAME: process.env.DETAIL_SHEET_NAME || "Detalle",
  DETAIL_SHEET_GID: process.env.DETAIL_SHEET_GID || "",
  COORDINADORES_SHEET_NAME: process.env.COORDINADORES_SHEET_NAME || "Coordinadores",
  GOOGLE_APPLICATION_CREDENTIALS: resolveFromRoot(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    "credentials.json"
  ),
  WHATSAPP_SESSION_DIR: resolveFromRoot(process.env.WHATSAPP_SESSION_DIR, "session"),
  CHROME_EXECUTABLE_PATH:
    process.env.CHROME_EXECUTABLE_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};

function assertRequiredConfig(names) {
  const missing = names.filter((name) => !config[name]);

  if (missing.length) {
    throw new Error(`Falta configurar: ${missing.join(", ")}. Revisa el archivo .env.`);
  }
}

module.exports = {
  ...config,
  assertRequiredConfig,
};
