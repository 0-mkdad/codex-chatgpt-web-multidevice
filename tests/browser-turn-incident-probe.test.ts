import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptAssistantTurnSelector } from "../src/chatgpt-session";

const CHROME = process.env.CHATGPT_DOM_TEST_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const submitted = "One  two\nThree";

type Shape = "same" | "different" | "nbsp" | "missing_target" | "missing_response" | "missing_completion";
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function probe(shape: Shape) {
  const page = await browser.newPage();
  try {
    await page.setContent("<main id='turn'></main>");
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const baseline = await worker.captureSubmissionBaseline(page, submitted);
    const mount = async (key: string, user: string, target: boolean, response: boolean, complete = true) => {
      await page.evaluate(({ key, user, target, response, complete }) => {
        const group = document.createElement("div");
        group.setAttribute("data-turn-key", key);
        const bubble = document.createElement("div");
        bubble.setAttribute("data-user-message-bubble", "");
        if (target) {
          const content = document.createElement("div");
          content.setAttribute("data-search-result-target", "");
          content.style.whiteSpace = "pre-wrap";
          content.textContent = user;
          bubble.appendChild(content);
        }
        group.appendChild(bubble);
        if (response) {
          const unit = document.createElement("div");
          unit.setAttribute("data-content-search-unit-key", `${key}:assistant`);
          unit.innerHTML = '<div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>Answer fragment.</p></div>';
          group.appendChild(unit);
          if (complete) group.insertAdjacentHTML("beforeend", '<div class="turn-action-controls"><button>Copy</button></div>');
        }
        (document.getElementById("turn") as HTMLElement).replaceChildren(group);
      }, { key, user, target, response, complete });
    };
    await mount("optimistic", submitted, true, true);
    baseline.acceptedUserIdentity = "group:user:optimistic";
    const before = await worker.submissionDomState(page, baseline.domCache);
    const binding = {
      identity: "group:assistant:optimistic",
      locator: page.locator(chatGptAssistantTurnSelector("group:assistant:optimistic")),
      acceptedTurnIdentities: before.turnIdentities,
    };
    const user = shape === "different" ? "One  two\nOther"
      : shape === "nbsp" ? submitted.replace("  ", " \u00a0") : submitted;
    await mount("persisted", user, shape !== "missing_target", shape !== "missing_response", shape !== "missing_completion");
    let outcome: "rebound" | "lost" = "lost";
    try {
      const rebound = await worker.reconcileAssistantTurnBinding(page, baseline, binding, undefined, `probe_${shape}`);
      if (rebound.identity === "group:assistant:persisted") outcome = "rebound";
    } catch (error) {
      expect((error as { code?: string }).code).toBe("chatgpt_turn_binding_lost");
      expect((error as Error).message).toBe("ChatGPT could not verify which assistant response belongs to the accepted user turn");
    }
    return outcome;
  } finally {
    await page.close();
  }
}

test("incident-shape probe: exact cross-key remount is accepted", async () => {
  const lines: string[] = [];
  const capture = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    expect(await probe("same")).toBe("rebound");
    const line = lines.find(value => value.includes('"event":"assistant_turn_binding_reconciled"'));
    expect(line).toBeDefined();
    expect(line).not.toContain(submitted);
    const detail = JSON.parse(line!.slice(line!.indexOf("{")).trim()).detail;
    expect(detail.normalizationClass).toBe("exact");
    expect(detail.submittedFingerprint).toBe(detail.renderedFingerprint);
    expect(detail.bindingGeneration).toBe(1);
    expect(detail.candidateUserCount).toBe(1);
  } finally {
    capture.mockRestore();
  }
}, 30_000);

test("incident-shape probe: different text, missing target, and absent response/completion fail closed", async () => {
  expect(await probe("different")).toBe("lost");
  expect(await probe("missing_target")).toBe("lost");
  expect(await probe("missing_response")).toBe("lost");
  expect(await probe("missing_completion")).toBe("lost");
}, 45_000);

test("incident-shape probe: multi-space NBSP rendering currently fails closed", async () => {
  expect(await probe("nbsp")).toBe("lost");
}, 30_000);

test("incident-shape probe: rejection trace gives private proof metadata without prompt text", async () => {
  const lines: string[] = [];
  const capture = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    expect(await probe("different")).toBe("lost");
    const line = lines.find(value => value.includes('"event":"assistant_turn_binding_lost"'));
    expect(line).toBeDefined();
    expect(line).not.toContain(submitted);
    expect(line).not.toContain("Other");
    const detail = JSON.parse(line!.slice(line!.indexOf("{")).trim()).detail;
    expect(detail.rebindReason).toBe("submitted_text_mismatch");
    expect(detail.normalizationClass).toBe("different");
    expect(detail.submittedCodeUnits).toBe(submitted.length);
    expect(detail.renderedCodeUnits).toBe(submitted.length);
    expect(detail.firstDifferenceOffset).toBe(9);
    expect(detail.submittedFingerprint).not.toBe(detail.renderedFingerprint);
    expect(detail.bindingGeneration).toBe(0);
  } finally {
    capture.mockRestore();
  }
}, 30_000);
