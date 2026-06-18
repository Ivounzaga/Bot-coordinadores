const express = require("express");
const fs = require("fs");
const path = require("path");
const { PORT } = require("./config");

const app = express();

const historyPath = path.join(__dirname, "data/history.json");

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getAllowedCorsOrigins() {
  return String(process.env.CRM_ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (origin === "null") return true;
  const normalized = normalizeOrigin(origin);
  return isLocalOrigin(normalized) || getAllowedCorsOrigins().includes(normalized);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isAllowedCorsOrigin(origin)) {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin));
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(isAllowedCorsOrigin(origin) ? 204 : 403);
  }

  next();
});

app.use(express.json());
app.use(express.static("public"));

function readHistory() {
  if (!fs.existsSync(historyPath)) return [];
  return JSON.parse(fs.readFileSync(historyPath, "utf8"));
}

function saveHistory(data) {
  fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
}

function appendHistory(entry) {
  const history = readHistory();
  history.unshift(entry);
  saveHistory(history);
}

let clients = [];
let lastProgressByType = {};

function sendProgress(payload) {
  const timestamp = new Date().toLocaleString("es-AR");

  console.log(`[PROGRESS ${timestamp}]`, JSON.stringify(payload, null, 2));

  if (payload?.type) {
    lastProgressByType[payload.type] = {
      ...payload,
      timestamp: new Date().toISOString(),
    };
  }

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((client) => client.write(data));
}

const executionState = {
  initial: createFlowState("initial"),
  followup: createFlowState("followup"),
  reminder: createFlowState("reminder"),
  coordinadores: createFlowState("coordinadores"),
  coordinadoresReminder: createFlowState("coordinadoresReminder"),
  crmCritical: createFlowState("crmCritical"),
};

const FLOW_TYPES = Object.keys(executionState);
const COORDINADORES_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

const coordinadoresReminderScheduler = {
  enabled: false,
  responsable: "",
  intervalId: null,
  lastRunAt: null,
  nextRunAt: null,
  lastResult: null,
  lastSkipReason: "",
};

function createFlowState(type) {
  return {
    type,
    status: "idle", // idle | running | paused | stopping
    startedAt: null,
    currentRunPromise: null,
  };
}

function getFlowLabel(type) {
  if (type === "followup") return "follow-up";
  if (type === "reminder") return "recordatorios";
  if (type === "coordinadores") return "coordinadores";
  if (type === "coordinadoresReminder") return "recordatorios de coordinadores";
  if (type === "crmCritical") return "CRM críticos";
  return "primer mensaje";
}

function getAllFlowStates() {
  return FLOW_TYPES.reduce((acc, type) => {
    acc[type] = getPublicFlowState(type);
    return acc;
  }, {});
}

function hasActiveFlow() {
  return FLOW_TYPES.some((type) => getFlowState(type).status !== "idle");
}

function getActiveFlowLabels() {
  return FLOW_TYPES
    .filter((type) => getFlowState(type).status !== "idle")
    .map(getFlowLabel);
}

function getFlowState(type) {
  const flow = executionState[type];
  if (!flow) {
    throw new Error(`Flujo inválido: ${type}`);
  }
  return flow;
}

function getPublicFlowState(type) {
  const flow = getFlowState(type);
  return {
    type: flow.type,
    status: flow.status,
    startedAt: flow.startedAt,
    isRunning: flow.status === "running",
    isPaused: flow.status === "paused",
    isStopping: flow.status === "stopping",
    isIdle: flow.status === "idle",
  };
}

function broadcastFlowState(type, extra = {}) {
  const flow = getFlowState(type);

  sendProgress({
    type,
    step: "control_state",
    controlStatus: flow.status,
    startedAt: flow.startedAt,
    ...extra,
  });
}

function startFlow(type) {
  const flow = getFlowState(type);

  if (flow.status === "running" || flow.status === "paused" || flow.status === "stopping") {
    return {
      ok: false,
      reason: `Ya hay una ejecución en curso para ${getFlowLabel(type)}.`,
      status: flow.status,
    };
  }

  const activeOtherType = FLOW_TYPES.find(
    (otherType) => otherType !== type && getFlowState(otherType).status !== "idle"
  );

  if (activeOtherType) {
    return {
      ok: false,
      reason: `Ya hay una ejecución en curso para ${getFlowLabel(activeOtherType)}.`,
      status: getFlowState(activeOtherType).status,
    };
  }

  flow.status = "running";
  flow.startedAt = new Date().toISOString();

  broadcastFlowState(type, {
    message: `Ejecución iniciada para ${getFlowLabel(type)}`,
  });

  return {
    ok: true,
    status: flow.status,
  };
}

function pauseFlow(type) {
  const flow = getFlowState(type);

  if (flow.status !== "running") {
    return {
      ok: false,
      reason: `No se puede pausar porque ${getFlowLabel(type)} no está corriendo.`,
      status: flow.status,
    };
  }

  flow.status = "paused";

  broadcastFlowState(type, {
    step: "paused",
    message: `Ejecución pausada para ${getFlowLabel(type)}`,
  });

  return {
    ok: true,
    status: flow.status,
  };
}

function resumeFlow(type) {
  const flow = getFlowState(type);

  if (flow.status !== "paused") {
    return {
      ok: false,
      reason: `No se puede reanudar porque ${getFlowLabel(type)} no está pausado.`,
      status: flow.status,
    };
  }

  flow.status = "running";

  broadcastFlowState(type, {
    step: "resumed",
    message: `Ejecución reanudada para ${getFlowLabel(type)}`,
  });

  return {
    ok: true,
    status: flow.status,
  };
}

function stopFlow(type) {
  const flow = getFlowState(type);

  if (flow.status !== "running" && flow.status !== "paused") {
    return {
      ok: false,
      reason: `No se puede detener porque ${getFlowLabel(type)} no está en ejecución.`,
      status: flow.status,
    };
  }

  flow.status = "stopping";

  broadcastFlowState(type, {
    step: "stopping",
    message: `Deteniendo ${getFlowLabel(type)}...`,
  });

  return {
    ok: true,
    status: flow.status,
  };
}

function finishFlow(type, extra = {}) {
  const flow = getFlowState(type);

  flow.status = "idle";
  flow.startedAt = null;
  flow.currentRunPromise = null;

  broadcastFlowState(type, {
    step: "idle",
    message: `Ejecución finalizada para ${getFlowLabel(type)}`,
    ...extra,
  });
}

function createFlowControl(type) {
  return {
    getType() {
      return type;
    },
    getStatus() {
      return getFlowState(type).status;
    },
    isRunning() {
      return getFlowState(type).status === "running";
    },
    isPaused() {
      return getFlowState(type).status === "paused";
    },
    isStopping() {
      return getFlowState(type).status === "stopping";
    },
    isIdle() {
      return getFlowState(type).status === "idle";
    },
    async waitIfPaused() {
      while (this.isPaused()) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async checkpoint(sendProgress) {
      if (this.isStopping()) {
        if (typeof sendProgress === "function") {
          sendProgress({
            type,
            step: "stopped",
            message: `Proceso detenido manualmente en ${getFlowLabel(type)}.`,
          });
        }

        const error = new Error("Proceso detenido manualmente");
        error.code = "MANUAL_STOP";
        throw error;
      }

      await this.waitIfPaused();

      if (this.isStopping()) {
        if (typeof sendProgress === "function") {
          sendProgress({
            type,
            step: "stopped",
            message: `Proceso detenido manualmente en ${getFlowLabel(type)}.`,
          });
        }

        const error = new Error("Proceso detenido manualmente");
        error.code = "MANUAL_STOP";
        throw error;
      }
    },
    async interruptibleSleep(ms, sendProgress) {
      const chunk = 500;
      let elapsed = 0;

      while (elapsed < ms) {
        await this.checkpoint(sendProgress);
        const waitMs = Math.min(chunk, ms - elapsed);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        elapsed += waitMs;
      }
    },
  };
}

function wrapProgress(type, progress) {
  return {
    ...progress,
    type,
    controlStatus: getFlowState(type).status,
  };
}

app.get("/api/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ step: "connected" })}\n\n`);

  res.write(
    `data: ${JSON.stringify({
      step: "control_snapshot",
      flows: getAllFlowStates(),
    })}\n\n`
  );

  clients.push(res);

  req.on("close", () => {
    clients = clients.filter((client) => client !== res);
  });
});

app.get("/api/history", (req, res) => {
  res.json(readHistory());
});

app.get("/api/control-state", (req, res) => {
  res.json(getAllFlowStates());
});

app.get("/api/progress-state", (req, res) => {
  res.json({
    flows: getAllFlowStates(),
    lastProgress: lastProgressByType,
  });
});

app.post("/api/control/:type/:action", (req, res) => {
  try {
    const type = String(req.params.type || "").trim();
    const action = String(req.params.action || "").trim();

    if (!FLOW_TYPES.includes(type)) {
      return res.status(400).json({ error: "Tipo de flujo inválido" });
    }

    let result;

    if (action === "pause") {
      result = pauseFlow(type);
    } else if (action === "resume") {
      result = resumeFlow(type);
    } else if (action === "stop") {
      result = stopFlow(type);
    } else {
      return res.status(400).json({ error: "Acción inválida" });
    }

    if (!result.ok) {
      return res.status(409).json({
        error: result.reason,
        state: getPublicFlowState(type),
      });
    }

    return res.json({
      ok: true,
      state: getPublicFlowState(type),
    });
  } catch (error) {
    console.error("[CONTROL] error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/run", async (req, res) => {
  const type = "initial";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return res.status(409).json({
      error: startResult.reason,
      state: getPublicFlowState(type),
    });
  }

  try {
    console.log("[INITIAL] endpoint llamado");

    const { runScript } = require("./runner");
    const secondMessage = String(req.body?.secondMessage || "").trim();
    const control = createFlowControl(type);

    sendProgress(wrapProgress(type, {
      step: "starting",
      secondMessage,
      message: "Iniciando ejecución..."
    }));

    const runPromise = runScript((progress) => {
      sendProgress(wrapProgress(type, progress));
    }, { secondMessage, control });

    getFlowState(type).currentRunPromise = runPromise;

    const result = await runPromise;

    const historyEntry = {
      ...result,
      type: "initial",
      message: result.secondMessage || secondMessage || "",
    };

    appendHistory(historyEntry);

    sendProgress(wrapProgress(type, {
      step: "finished",
      summary: {
        total: historyEntry.total || 0,
        contactados: historyEntry.contactados?.length || 0,
        invalidos: historyEntry.invalidos?.length || 0,
        errores: historyEntry.errores?.length || 0
      }
    }));

    finishFlow(type);

    res.json(historyEntry);
  } catch (error) {
    console.error("[INITIAL] error:", error);

    sendProgress(wrapProgress(type, {
      step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
      message: error.message
    }));

    finishFlow(type, {
      lastError: error.message,
    });

    res.status(error.code === "MANUAL_STOP" ? 409 : 500).json({ error: error.message });
  }
});

app.post("/api/run-followup", async (req, res) => {
  const type = "followup";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return res.status(409).json({
      error: startResult.reason,
      state: getPublicFlowState(type),
    });
  }

  try {
    console.log("[FOLLOWUP] endpoint llamado");

    const { runFollowupScript } = require("./runner");
    const message = String(
      req.body?.message || "Buenas como estas? Todo bien? Pudiste recibir mi mensaje?"
    ).trim();

    const rawDaysThreshold = Number(req.body?.daysThreshold);
    const daysThreshold =
      Number.isFinite(rawDaysThreshold) && rawDaysThreshold >= 1
        ? Math.floor(rawDaysThreshold)
        : 2;

    const control = createFlowControl(type);

    sendProgress(wrapProgress(type, {
      step: "starting",
      messageTemplate: message,
      daysThreshold,
      message: "Iniciando follow-up..."
    }));

    const runPromise = runFollowupScript((progress) => {
      sendProgress(wrapProgress(type, progress));
    }, { message, daysThreshold, control });

    getFlowState(type).currentRunPromise = runPromise;

    const result = await runPromise;

    const historyEntry = {
      ...result,
      type: "followup",
      message,
      daysThreshold,
      followups: result.followups || result.contactados || [],
    };

    appendHistory(historyEntry);

    sendProgress(wrapProgress(type, {
      step: "finished",
      daysThreshold,
      summary: {
        total: historyEntry.total || 0,
        contactados: historyEntry.followups?.length || historyEntry.contactados?.length || 0,
        invalidos: historyEntry.invalidos?.length || 0,
        errores: historyEntry.errores?.length || 0
      }
    }));

    finishFlow(type);

    res.json(historyEntry);
  } catch (error) {
    console.error("[FOLLOWUP] error:", error);

    sendProgress(wrapProgress(type, {
      step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
      message: error.message
    }));

    finishFlow(type, {
      lastError: error.message,
    });

    res.status(error.code === "MANUAL_STOP" ? 409 : 500).json({ error: error.message });
  }
});

app.post("/api/run-reminder", async (req, res) => {
  const type = "reminder";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return res.status(409).json({
      error: startResult.reason,
      state: getPublicFlowState(type),
    });
  }

  try {
    console.log("[REMINDER] endpoint llamado");

    const { runReminderScript } = require("./runner");

    const reminderMessage1 = String(
      req.body?.reminderMessage1 ||
      "Buenasss como estas? Te recuerdo la reunion de hoy, mas que nada para enviarles a los grupos de los chicos y que se registren antes de la reunion"
    ).trim();

    const reminderMessage2 = String(
      req.body?.reminderMessage2 ||
      "Buenass te tiro un ultimo recordatorio para que puedas enviarle a los chicos, que estamos a una 40 min del inicio de la reu"
    ).trim();

    const control = createFlowControl(type);

    sendProgress(wrapProgress(type, {
      step: "starting",
      reminderMessage1,
      reminderMessage2,
      message: "Iniciando recordatorio..."
    }));

    const runPromise = runReminderScript((progress) => {
      sendProgress(wrapProgress(type, progress));
    }, { reminderMessage1, reminderMessage2, control });

    getFlowState(type).currentRunPromise = runPromise;

    const result = await runPromise;

    const historyEntry = {
      ...result,
      type: "reminder",
      reminderMessage1,
      reminderMessage2,
      message: reminderMessage1,
      reminders: result.reminders || result.contactados || [],
    };

    appendHistory(historyEntry);

    sendProgress(wrapProgress(type, {
      step: "finished",
      summary: {
        total: historyEntry.total || 0,
        contactados: historyEntry.reminders?.length || historyEntry.contactados?.length || 0,
        invalidos: historyEntry.invalidos?.length || 0,
        errores: historyEntry.errores?.length || 0
      }
    }));

    finishFlow(type);

    res.json(historyEntry);
  } catch (error) {
    console.error("[REMINDER] error:", error);

    sendProgress(wrapProgress(type, {
      step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
      message: error.message
    }));

    finishFlow(type, {
      lastError: error.message,
    });

    res.status(error.code === "MANUAL_STOP" ? 409 : 500).json({ error: error.message });
  }
});

app.post("/api/run-coordinadores", async (req, res) => {
  const type = "coordinadores";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return res.status(409).json({
      error: startResult.reason,
      state: getPublicFlowState(type),
    });
  }

  try {
    console.log("[COORDINADORES] endpoint llamado");

    const responsable = String(req.body?.responsable || "").trim();
    const control = createFlowControl(type);

    sendProgress(wrapProgress(type, {
      step: "starting",
      responsable,
      message: "Iniciando coordinadores..."
    }));

    const runPromise = new Promise((resolve, reject) => {
      setImmediate(() => {
        const { runCoordinadoresScript } = require("./runner");

        runCoordinadoresScript((progress) => {
          sendProgress(wrapProgress(type, progress));
        }, { control, responsable }).then(resolve, reject);
      });
    });

    getFlowState(type).currentRunPromise = runPromise;

    runPromise
      .then((result) => {
        const historyEntry = {
          ...result,
          type: "coordinadores",
          responsable,
          message: result.secondMessage || result.message || "",
          coordinadores: result.contactados || [],
        };

        appendHistory(historyEntry);

        sendProgress(wrapProgress(type, {
          step: "finished",
          summary: {
            total: historyEntry.total || 0,
            contactados: historyEntry.contactados?.length || 0,
            invalidos: historyEntry.invalidos?.length || 0,
            duplicados: historyEntry.duplicados?.length || 0,
            errores: historyEntry.errores?.length || 0
          }
        }));

        finishFlow(type);
      })
      .catch((error) => {
        console.error("[COORDINADORES] error:", error);

        sendProgress(wrapProgress(type, {
          step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
          message: error.message
        }));

        finishFlow(type, {
          lastError: error.message,
        });
      });

    res.status(202).json({
      started: true,
      state: getPublicFlowState(type),
      message: "Corrida de coordinadores iniciada",
    });
  } catch (error) {
    console.error("[COORDINADORES] error:", error);

    sendProgress(wrapProgress(type, {
      step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
      message: error.message
    }));

    finishFlow(type, {
      lastError: error.message,
    });

    res.status(error.code === "MANUAL_STOP" ? 409 : 500).json({ error: error.message });
  }
});

function getCoordinadoresReminderSchedulerState() {
  return {
    enabled: coordinadoresReminderScheduler.enabled,
    responsable: coordinadoresReminderScheduler.responsable,
    lastRunAt: coordinadoresReminderScheduler.lastRunAt,
    nextRunAt: coordinadoresReminderScheduler.nextRunAt,
    lastResult: coordinadoresReminderScheduler.lastResult,
    lastSkipReason: coordinadoresReminderScheduler.lastSkipReason,
    intervalMinutes: Math.round(COORDINADORES_REMINDER_INTERVAL_MS / 60000),
    flow: getPublicFlowState("coordinadoresReminder"),
  };
}

function setNextCoordinadoresReminderRun() {
  coordinadoresReminderScheduler.nextRunAt = coordinadoresReminderScheduler.enabled
    ? new Date(Date.now() + COORDINADORES_REMINDER_INTERVAL_MS).toISOString()
    : null;
}

function startCoordinadoresReminderRun({ responsable = "", source = "manual" } = {}) {
  const type = "coordinadoresReminder";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return {
      started: false,
      error: startResult.reason,
      state: getPublicFlowState(type),
    };
  }

  const control = createFlowControl(type);

  sendProgress(wrapProgress(type, {
    step: "starting",
    responsable,
    source,
    message: source === "scheduler"
      ? "Iniciando recordatorios automaticos de coordinadores..."
      : "Iniciando recordatorios de coordinadores...",
  }));

  const runPromise = new Promise((resolve, reject) => {
    setImmediate(() => {
      const { runCoordinadoresRemindersScript } = require("./runner");

      runCoordinadoresRemindersScript((progress) => {
        sendProgress(wrapProgress(type, progress));
      }, { control, responsable }).then(resolve, reject);
    });
  });

  getFlowState(type).currentRunPromise = runPromise;

  runPromise
    .then((result) => {
      const historyEntry = {
        ...result,
        type,
        responsable,
        source,
        message: result.message || "",
        reminders: result.reminders || result.contactados || [],
      };

      appendHistory(historyEntry);

      coordinadoresReminderScheduler.lastResult = {
        date: historyEntry.date,
        source,
        total: historyEntry.total || 0,
        reminders: historyEntry.reminders?.length || 0,
        invalidos: historyEntry.invalidos?.length || 0,
        sinHora: historyEntry.sinHora?.length || 0,
        errores: historyEntry.errores?.length || 0,
      };

      sendProgress(wrapProgress(type, {
        step: "finished",
        responsable,
        source,
        summary: {
          total: historyEntry.total || 0,
          contactados: historyEntry.reminders?.length || historyEntry.contactados?.length || 0,
          invalidos: historyEntry.invalidos?.length || 0,
          sinHora: historyEntry.sinHora?.length || 0,
          errores: historyEntry.errores?.length || 0,
        },
      }));

      finishFlow(type);
    })
    .catch((error) => {
      console.error("[COORDINADORES][REMINDERS] error:", error);

      coordinadoresReminderScheduler.lastResult = {
        date: new Date().toISOString(),
        source,
        error: error.message,
      };

      sendProgress(wrapProgress(type, {
        step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
        responsable,
        source,
        message: error.message,
      }));

      finishFlow(type, {
        lastError: error.message,
      });
    });

  return {
    started: true,
    state: getPublicFlowState(type),
  };
}

function runScheduledCoordinadoresReminder() {
  if (!coordinadoresReminderScheduler.enabled) return;

  coordinadoresReminderScheduler.lastRunAt = new Date().toISOString();
  setNextCoordinadoresReminderRun();

  if (hasActiveFlow()) {
    const active = getActiveFlowLabels().join(", ");
    coordinadoresReminderScheduler.lastSkipReason = `Se salteo porque hay otro flujo activo: ${active}`;
    console.log("[COORDINADORES][REMINDERS][SCHEDULER]", coordinadoresReminderScheduler.lastSkipReason);
    return;
  }

  coordinadoresReminderScheduler.lastSkipReason = "";
  const result = startCoordinadoresReminderRun({
    responsable: coordinadoresReminderScheduler.responsable,
    source: "scheduler",
  });

  if (!result.started) {
    coordinadoresReminderScheduler.lastSkipReason = result.error;
  }
}

function startCoordinadoresReminderScheduler(responsable = "") {
  if (coordinadoresReminderScheduler.intervalId) {
    clearInterval(coordinadoresReminderScheduler.intervalId);
  }

  coordinadoresReminderScheduler.enabled = true;
  coordinadoresReminderScheduler.responsable = String(responsable || "").trim();
  coordinadoresReminderScheduler.lastSkipReason = "";
  setNextCoordinadoresReminderRun();
  coordinadoresReminderScheduler.intervalId = setInterval(
    runScheduledCoordinadoresReminder,
    COORDINADORES_REMINDER_INTERVAL_MS
  );
}

function stopCoordinadoresReminderScheduler() {
  if (coordinadoresReminderScheduler.intervalId) {
    clearInterval(coordinadoresReminderScheduler.intervalId);
  }

  coordinadoresReminderScheduler.enabled = false;
  coordinadoresReminderScheduler.intervalId = null;
  setNextCoordinadoresReminderRun();
}

app.get("/api/coordinadores-responsables", async (req, res) => {
  try {
    const { getCoordinadoresResponsables } = require("./coordinadores");
    const result = await Promise.race([
      getCoordinadoresResponsables().then((responsables) => ({ responsables })),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            responsables: [],
            warning: "No se pudieron cargar responsables a tiempo. Podes escribirlo manualmente.",
          });
        }, 8000);
      }),
    ]);

    res.json(result);
  } catch (error) {
    console.error("[COORDINADORES] responsables error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/run-coordinadores-reminders", async (req, res) => {
  const responsable = String(req.body?.responsable || "").trim();
  const result = startCoordinadoresReminderRun({ responsable, source: "manual" });

  if (!result.started) {
    return res.status(409).json({
      error: result.error,
      state: result.state,
    });
  }

  return res.status(202).json({
    started: true,
    state: result.state,
    message: "Corrida de recordatorios de coordinadores iniciada",
  });
});

app.get("/api/coordinadores-reminder-scheduler", (req, res) => {
  res.json(getCoordinadoresReminderSchedulerState());
});

app.post("/api/coordinadores-reminder-scheduler/start", (req, res) => {
  const responsable = String(req.body?.responsable || "").trim();
  const runNow = Boolean(req.body?.runNow);

  startCoordinadoresReminderScheduler(responsable);

  if (runNow) {
    runScheduledCoordinadoresReminder();
  }

  res.json({
    ok: true,
    scheduler: getCoordinadoresReminderSchedulerState(),
  });
});

app.post("/api/coordinadores-reminder-scheduler/stop", (req, res) => {
  stopCoordinadoresReminderScheduler();
  res.json({
    ok: true,
    scheduler: getCoordinadoresReminderSchedulerState(),
  });
});

app.get("/api/crm-critical-users", (req, res) => {
  const { getCrmBotUsers } = require("./crm-critical-bot");
  res.json({ users: getCrmBotUsers() });
});

app.post("/api/run-crm-critical", async (req, res) => {
  const type = "crmCritical";
  const startResult = startFlow(type);

  if (!startResult.ok) {
    return res.status(409).json({
      error: startResult.reason,
      state: getPublicFlowState(type),
    });
  }

  try {
    const operatorName = String(req.body?.operatorName || "").trim();
    const dryRun = Boolean(req.body?.dryRun);
    const rawLimit = Number(req.body?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
    const rawDelayMs = Number(req.body?.delayMs);
    const rawBetweenContactsMs = Number(req.body?.betweenContactsMs);
    const rawAfterSendSettleMs = Number(req.body?.afterSendSettleMs);
    const playerMessage = String(req.body?.playerMessage || "").trim();
    const tutorMessage = String(req.body?.tutorMessage || "").trim();
    const delayMs = Number.isFinite(rawDelayMs) && rawDelayMs >= 0 ? rawDelayMs : undefined;
    const betweenContactsMs =
      Number.isFinite(rawBetweenContactsMs) && rawBetweenContactsMs >= 0
        ? rawBetweenContactsMs
        : undefined;
    const afterSendSettleMs =
      Number.isFinite(rawAfterSendSettleMs) && rawAfterSendSettleMs >= 0
        ? rawAfterSendSettleMs
        : undefined;
    const control = createFlowControl(type);

    if (!operatorName) {
      throw new Error("Elegí quién está usando el bot antes de correrlo.");
    }

    sendProgress(wrapProgress(type, {
      step: "starting",
      operatorName,
      dryRun,
      message: dryRun ? "Simulando bot CRM críticos..." : "Iniciando bot CRM críticos...",
    }));

    const runPromise = new Promise((resolve, reject) => {
      setImmediate(() => {
        const { runCrmCriticalScript } = require("./runner");

        runCrmCriticalScript((progress) => {
          sendProgress(wrapProgress(type, progress));
        }, {
          control,
          operatorName,
          dryRun,
          ...(limit ? { limit } : {}),
          ...(delayMs != null ? { delayMs } : {}),
          ...(betweenContactsMs != null ? { betweenContactsMs } : {}),
          ...(afterSendSettleMs != null ? { afterSendSettleMs } : {}),
          ...(playerMessage ? { playerMessage } : {}),
          ...(tutorMessage ? { tutorMessage } : {}),
        }).then(resolve, reject);
      });
    });

    getFlowState(type).currentRunPromise = runPromise;

    runPromise
      .then((result) => {
        const historyEntry = {
          ...result,
          type,
          operatorName: result.operatorName || operatorName,
          crmCritical: result.contactados || [],
        };

        appendHistory(historyEntry);

        sendProgress(wrapProgress(type, {
          step: "finished",
          operatorName: historyEntry.operatorName,
          dryRun: historyEntry.dryRun,
          summary: {
            total: historyEntry.total || 0,
            contactados: historyEntry.contactados?.length || 0,
            skipped: historyEntry.skipped?.length || 0,
            errores: historyEntry.errores?.length || 0,
          },
        }));

        finishFlow(type);
      })
      .catch((error) => {
        console.error("[CRM CRITICAL] error:", error);

        sendProgress(wrapProgress(type, {
          step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
          operatorName,
          dryRun,
          message: error.message,
        }));

        finishFlow(type, {
          lastError: error.message,
        });
      });

    return res.status(202).json({
      started: true,
      state: getPublicFlowState(type),
      message: dryRun ? "Simulación CRM iniciada" : "Bot CRM iniciado",
    });
  } catch (error) {
    console.error("[CRM CRITICAL] error:", error);

    sendProgress(wrapProgress(type, {
      step: error.code === "MANUAL_STOP" ? "stopped" : "failed",
      message: error.message,
    }));

    finishFlow(type, {
      lastError: error.message,
    });

    return res.status(error.code === "MANUAL_STOP" ? 409 : 500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
