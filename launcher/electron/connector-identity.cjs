const CURRENT_CONNECTOR_NAME = "Codex Native2";
const DEV_CONNECTOR_NAME = `${CURRENT_CONNECTOR_NAME} DEV`;
const LEGACY_CONNECTOR_NAMES = Object.freeze(["Codex Native"]);
const ZERO_RISK_CONNECTOR_NAME = "Codex Zero Risk";

function validateConnectorName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("Connector name is invalid");
  }
  return value.trim();
}

function isLegacyConnectorName(value) {
  return LEGACY_CONNECTOR_NAMES.includes(value);
}

function connectorNameForSetup(value) {
  const configured = validateConnectorName(value);
  return isLegacyConnectorName(configured) ? CURRENT_CONNECTOR_NAME : configured;
}

function connectorNameForDevSetup(value) {
  if (value === undefined || value === null) return DEV_CONNECTOR_NAME;
  const configured = validateConnectorName(value);
  if (configured === CURRENT_CONNECTOR_NAME || isLegacyConnectorName(configured)) {
    return DEV_CONNECTOR_NAME;
  }
  return configured;
}

function rawAutomaticConnectorName(config) {
  return config?.automaticAppName
    ?? ((config?.browserInteractionMode ?? "automatic") === "automatic" ? config?.appName : undefined);
}

function automaticConnectorName(config) {
  const candidate = rawAutomaticConnectorName(config) ?? CURRENT_CONNECTOR_NAME;
  let configured;
  try {
    configured = validateConnectorName(candidate);
  } catch (error) {
    throw new Error(
      `Automatic connector name is invalid${error instanceof Error ? `: ${error.message}` : ""}`,
      { cause: error },
    );
  }
  if (configured === ZERO_RISK_CONNECTOR_NAME) {
    throw new Error("Automatic connector name must differ from the Zero Risk connector name");
  }
  return configured;
}

function automaticConnectorNameForSetup(config) {
  const candidate = rawAutomaticConnectorName(config);
  if (candidate === undefined) return CURRENT_CONNECTOR_NAME;
  let configured;
  try {
    configured = validateConnectorName(candidate);
  } catch {
    return CURRENT_CONNECTOR_NAME;
  }
  if (configured === ZERO_RISK_CONNECTOR_NAME || isLegacyConnectorName(configured)) {
    return CURRENT_CONNECTOR_NAME;
  }
  return configured;
}

function automaticConnectorNameRequiresRepair(config) {
  const missingAutomaticName = config?.automaticAppName === undefined || config?.automaticAppName === null;
  if (missingAutomaticName && config?.browserInteractionMode === "manual") return true;
  const candidate = config?.automaticAppName
    ?? ((config?.browserInteractionMode ?? "automatic") === "automatic" ? config?.appName : undefined);
  if (candidate === undefined) return true;
  let configured;
  try {
    configured = validateConnectorName(candidate);
  } catch {
    return true;
  }
  return configured !== candidate
    || configured === ZERO_RISK_CONNECTOR_NAME
    || isLegacyConnectorName(configured);
}

function automaticConnectorNameForEditor(config) {
  const candidate = rawAutomaticConnectorName(config);
  if (candidate === undefined) return CURRENT_CONNECTOR_NAME;
  try {
    const configured = validateConnectorName(candidate);
    return configured === ZERO_RISK_CONNECTOR_NAME ? candidate : connectorNameForSetup(configured);
  } catch {
    return typeof candidate === "string" ? candidate : "";
  }
}

function activeConnectorName(config) {
  if (config?.browserInteractionMode === "manual") {
    const manual = validateConnectorName(config.manualAppName ?? ZERO_RISK_CONNECTOR_NAME);
    if (manual !== ZERO_RISK_CONNECTOR_NAME) {
      throw new Error("Manual connector name must be the Zero Risk connector");
    }
    return manual;
  }
  return connectorNameForSetup(automaticConnectorName(config));
}

function activeConnectorNameForSetup(config) {
  if (config?.browserInteractionMode === "manual") return activeConnectorName(config);
  return automaticConnectorNameForSetup(config);
}

function isAutomaticConnectorIdentityError(error) {
  return error instanceof Error && error.message.startsWith("Automatic connector name");
}

function requireCurrentRuntimeConnectorName(value) {
  const configured = validateConnectorName(value);
  if (isLegacyConnectorName(configured)) {
    throw new Error(
      `The local runtime still targets legacy ChatGPT connector ${JSON.stringify(configured)}. Reconnect the harness`
      + ` so it targets ${JSON.stringify(CURRENT_CONNECTOR_NAME)}, then create that connector as a new ChatGPT plugin;`
      + ` do not rename or refresh the legacy connector.`,
    );
  }
  return configured;
}

module.exports = {
  connectorNameForSetup,
  connectorNameForDevSetup,
  rawAutomaticConnectorName,
  automaticConnectorName,
  automaticConnectorNameForSetup,
  automaticConnectorNameRequiresRepair,
  automaticConnectorNameForEditor,
  activeConnectorName,
  activeConnectorNameForSetup,
  isAutomaticConnectorIdentityError,
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  isLegacyConnectorName,
  LEGACY_CONNECTOR_NAMES,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
};
