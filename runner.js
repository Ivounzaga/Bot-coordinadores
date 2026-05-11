const { runAutomation } = require("./automation");
const { runFollowup } = require("./followup");
const { runReminder } = require("./reminder");
const { runCoordinadores, runCoordinadoresReminders } = require("./coordinadores");

async function runScript(sendProgress, options = {}) {
  return await runAutomation(sendProgress, {
    ...options,
  });
}

async function runFollowupScript(sendProgress, options = {}) {
  return await runFollowup(sendProgress, {
    ...options,
  });
}

async function runReminderScript(sendProgress, options = {}) {
  return await runReminder(sendProgress, {
    ...options,
  });
}

async function runCoordinadoresScript(sendProgress, options = {}) {
  return await runCoordinadores(sendProgress, {
    ...options,
  });
}

async function runCoordinadoresRemindersScript(sendProgress, options = {}) {
  return await runCoordinadoresReminders(sendProgress, {
    ...options,
  });
}

module.exports = {
  runScript,
  runFollowupScript,
  runReminderScript,
  runCoordinadoresScript,
  runCoordinadoresRemindersScript,
};
