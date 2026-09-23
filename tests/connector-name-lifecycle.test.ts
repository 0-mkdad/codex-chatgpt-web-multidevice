import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_CONNECTOR_NAME,
  defaultConfig,
  getConfigPath,
  loadConfig,
  loadConfigForSetup,
  resolveInteractionConnectorIdentities,
  saveConfig,
} from "../src/config";
import {
  connectorNameDraftReducer,
  createConnectorNameDraft,
} from "../launcher/src/connector-name-draft";

async function withConfigHome<T>(home: string, run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
  }
}

function configWithAutomaticName(name: string) {
  const config = defaultConfig("browser-only");
  Object.assign(config, resolveInteractionConnectorIdentities("automatic", "production", name));
  return config;
}

test("automatic connector setup persists the submitted name and config reload derives the active name", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-connector-persist-"));
  try {
    await withConfigHome(home, () => {
      const config = configWithAutomaticName("Codex Native2 Dell");
      saveConfig(config);

      const stored = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(stored.automaticAppName).toBe("Codex Native2 Dell");
      expect(loadConfig().automaticAppName).toBe("Codex Native2 Dell");
      expect(loadConfig().appName).toBe("Codex Native2 Dell");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("release migration preserves a valid custom identity and repairs only the derived active field", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-connector-migration-"));
  try {
    await withConfigHome(home, () => {
      const oldConfig = {
        ...defaultConfig("browser-only"),
        releaseVersion: "5.9.0",
        appName: CHATGPT_CONNECTOR_NAME,
        automaticAppName: "Codex Native2 Dell",
      };
      writeFileSync(getConfigPath(), JSON.stringify(oldConfig, null, 2) + "\n");

      expect(loadConfig().automaticAppName).toBe("Codex Native2 Dell");
      expect(loadConfig().appName).toBe("Codex Native2 Dell");
      const migrated = loadConfigForSetup();
      expect(migrated.automaticAppName).toBe("Codex Native2 Dell");
      expect(migrated.appName).toBe("Codex Native2 Dell");
      saveConfig(migrated);
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).automaticAppName).toBe("Codex Native2 Dell");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two device homes remain independent and fresh or repaired configs use the default", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "codex-device-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "codex-device-b-"));
  try {
    await withConfigHome(homeA, () => saveConfig(configWithAutomaticName("Codex Native2 Dell")));
    await withConfigHome(homeB, () => saveConfig(configWithAutomaticName("Codex Native2 Laptop")));
    await withConfigHome(homeA, () => {
      expect(loadConfigForSetup().automaticAppName).toBe("Codex Native2 Dell");
    });
    await withConfigHome(homeB, () => {
      expect(loadConfigForSetup().automaticAppName).toBe("Codex Native2 Laptop");
    });

    await withConfigHome(homeA, () => {
      const legacy = {
        ...defaultConfig("browser-only"),
        appName: "Codex Native",
        automaticAppName: "Codex Native",
      };
      writeFileSync(getConfigPath(), JSON.stringify(legacy));
      expect(loadConfigForSetup().automaticAppName).toBe(CHATGPT_CONNECTOR_NAME);

      const invalid = { ...legacy, appName: CHATGPT_CONNECTOR_NAME, automaticAppName: "  " };
      writeFileSync(getConfigPath(), JSON.stringify(invalid));
      expect(loadConfigForSetup().automaticAppName).toBe(CHATGPT_CONNECTOR_NAME);
    });
    await withConfigHome(join(homeA, "fresh"), () => {
      expect(defaultConfig("browser-only").automaticAppName).toBe(CHATGPT_CONNECTOR_NAME);
    });
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});

test("MCP connector draft follows persisted snapshots without overwriting unsaved edits", () => {
  let draft = createConnectorNameDraft(CHATGPT_CONNECTOR_NAME);
  draft = connectorNameDraftReducer(draft, { type: "edit", value: "Codex Native2 Dell" });
  draft = connectorNameDraftReducer(draft, {
    type: "snapshot",
    persistedName: CHATGPT_CONNECTOR_NAME,
  });
  expect(draft).toEqual({
    persistedName: CHATGPT_CONNECTOR_NAME,
    draftName: "Codex Native2 Dell",
    dirty: true,
  });

  draft = connectorNameDraftReducer(draft, {
    type: "saved",
    persistedName: "Codex Native2 Dell",
  });
  expect(draft).toEqual({
    persistedName: "Codex Native2 Dell",
    draftName: "Codex Native2 Dell",
    dirty: false,
  });
  const reopened = createConnectorNameDraft(draft.persistedName);
  expect(reopened.draftName).toBe("Codex Native2 Dell");

  draft = connectorNameDraftReducer(draft, { type: "edit", value: "Unsaved laptop name" });
  draft = connectorNameDraftReducer(draft, {
    type: "snapshot",
    persistedName: "Codex Native2 Dell (updated)",
  });
  expect(draft.persistedName).toBe("Codex Native2 Dell (updated)");
  expect(draft.draftName).toBe("Unsaved laptop name");
  expect(draft.dirty).toBe(true);
});
