const express = require("express");
const fs = require("fs");
const path = require("path");
const { PORT } = require("./config");

const app = express();

const historyPath = path.join(__dirname, "data/history.json");

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

function sendProgress(payload) {
  const timestamp = new Date().toLocaleString("es-AR");

  console.log(`[PROGRESS ${timestamp}]`, JSON.stringify(payload, null, 2));

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((client) => client.write(data));
}

const executionState = {
  initial: createFlowState("initial"),
  followup: createFlowState("followup"),
  reminder: createFlowState("reminder"),
  coordinadores: createFlowState("coordinadores"),
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
  return "primer mensaje";
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
    type,
    controlStatus: getFlowState(type).status,
    ...progress,
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
      flows: {
        initial: getPublicFlowState("initial"),
        followup: getPublicFlowState("followup"),
        reminder: getPublicFlowState("reminder"),
        coordinadores: getPublicFlowState("coordinadores"),
      },
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
  res.json({
    initial: getPublicFlowState("initial"),
    followup: getPublicFlowState("followup"),
    reminder: getPublicFlowState("reminder"),
    coordinadores: getPublicFlowState("coordinadores"),
  });
});

app.post("/api/control/:type/:action", (req, res) => {
  try {
    const type = String(req.params.type || "").trim();
    const action = String(req.params.action || "").trim();

    if (!["initial", "followup", "reminder", "coordinadores"].includes(type)) {
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

    const { runCoordinadoresScript } = require("./runner");
    const control = createFlowControl(type);

    sendProgress(wrapProgress(type, {
      step: "starting",
      message: "Iniciando coordinadores..."
    }));

    const runPromise = runCoordinadoresScript((progress) => {
      sendProgress(wrapProgress(type, progress));
    }, { control });

    getFlowState(type).currentRunPromise = runPromise;

    const result = await runPromise;

    const historyEntry = {
      ...result,
      type: "coordinadores",
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

    res.json(historyEntry);
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
