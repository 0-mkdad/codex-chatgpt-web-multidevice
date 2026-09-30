import { expect, spyOn, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";
import { parseRequest } from "../src/responses/parser";

/**
 * Package C closure proofs (C-CLOSURE-1 / C-CLOSURE-2): the REAL runBrowserTurn observation
 * loop — including the terminal reconcile failure branch and the last-chance salvage — runs
 * against a live Chromium fixture that simulates the renderer lifecycle: optimistic group,
 * mid-stream re-key remount (the 2ee611b31fab shape), completion controls. No account, no
 * network, no model submission; the physical send is counted at the production seam.
 */

const CHROME = process.env.CHATGPT_DOM_TEST_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROMPT = "Audit one module.\nThen summarize the finding.";

const fixturePage = `
<button id="send">Send</button>
<main id="turn"></main>
<script>
window.__clicks = 0;
window.__scenario = "S1";
window.__prompt = "";
window.__listenerAttached = false;
window.__stubRan = false;
window.__listenerAttached = true;
document.getElementById("send").addEventListener("click", () => {
  window.__clicks += 1;
  const prompt = window.__prompt;
  const main = document.getElementById("turn");
  const makeGroup = (key, bubbleText, answerHtml, withControls) => {
    const g = document.createElement("div");
    g.setAttribute("data-turn-key", key);
    if (bubbleText !== null) {
      const bub = document.createElement("div");
      bub.setAttribute("data-user-message-bubble", "");
      const target = document.createElement("div");
      target.setAttribute("data-search-result-target", "");
      target.style.whiteSpace = "pre-wrap";
      target.textContent = bubbleText;
      bub.appendChild(target);
      g.appendChild(bub);
    }
    const unit = document.createElement("div");
    unit.setAttribute("data-content-search-unit-key", key + ":assistant");
    unit.innerHTML = '<div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">' + answerHtml + '</div>';
    g.appendChild(unit);
    if (withControls) g.insertAdjacentHTML("beforeend", '<div class="turn-action-controls"><button>Copy</button></div>');
    return g;
  };
  main.innerHTML = "";
  main.appendChild(makeGroup("optimistic", prompt, "<p>Result prefix line.</p>", false));
  const scenario = window.__scenario;
  if (scenario === "S1") {
    setTimeout(() => { main.innerHTML = ""; main.appendChild(makeGroup("persisted", prompt, "<p>Result prefix line continued here.</p>", false)); }, 800);
    setTimeout(() => { main.innerHTML = ""; main.appendChild(makeGroup("persisted", prompt, "<p>Result prefix line continued here.</p><p>Final section. ACCEPTANCE_DONE_927</p>", true)); }, 1900);
  } else if (scenario === "S2") {
      setTimeout(() => { main.innerHTML = ""; main.appendChild(makeGroup("persisted", prompt, "<p>Result prefix line continued.</p><p>Final section. SALVAGE_DONE_927</p>", true)); }, 1800);
  } else if (scenario === "S3") {
      setTimeout(() => { main.innerHTML = ""; main.appendChild(makeGroup("persisted", prompt, "<p>Result prefix line continued.</p><p>SHOULD_NOT_SALVAGE_927</p>", true)); main.appendChild(makeUserOnly("foreign", "A newer user turn.")); }, 1200);
  } else if (scenario === "S4") {
      setTimeout(() => { main.innerHTML = ""; main.appendChild(makeGroup("persisted", prompt, "<p>Still streaming, no controls yet.</p>", false)); }, 1200);
  }
});
  function makeUserOnly(key, bubbleText) {
    const group = document.createElement("div");
    group.setAttribute("data-turn-key", key);
    const bubble = document.createElement("div");
    bubble.setAttribute("data-user-message-bubble", "");
    const target = document.createElement("div");
    target.setAttribute("data-search-result-target", "");
    target.style.whiteSpace = "pre-wrap";
    target.textContent = bubbleText;
    bubble.appendChild(target);
    group.appendChild(bubble);
    return group;
  }
</script>
`;

async function openFixture(browser: Browser): Promise<{ page: import("playwright-core").Page; close: () => Promise<void> }> {
  const page = await browser.newPage();
  await page.setContent(fixturePage);
  await page.evaluate(() => { (window as unknown as { __pageToken: number }).__pageToken = Math.random(); });
  return { page, close: () => page.close() };
}

function buildWorker(page: import("playwright-core").Page, state: {
  submissions: number; deliveries: number; toolExecutions: number; promptText: string;
}, diagnosticPath = join(tmpdir(), `pkg-c-closure-${Date.now()}`)): { worker: any; progress: ChatGptExternalTurnProgress; fence: { begin: () => Promise<number>; commit: (revision: number) => Promise<boolean> }; fenceBegins: () => number; fenceCommits: () => number } {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.config = {
    browserHost: "managed-chrome",
    appName: "ChatGPT",
    browserDiagnosticsPath: diagnosticPath,
    useSavedChats: false,
    autoApproveToolCalls: false,
  };
  worker.pageForNewTurn = async () => page;
  worker.prepareChatSurface = async () => undefined;
  worker.selectModelAndEffort = async () => ({ localTools: false, thinkEnabled: false, effort: "high", mode: "standard" });
  worker.attachPromptWithCompactionRetry = async (...args: unknown[]) => {
    state.promptText = String(args[1] ?? "");
    return undefined;
  };
  worker.sendAttachedPrompt = async () => {
    state.submissions += 1;
    const stubToken = await page.evaluate(() => (window as unknown as { __pageToken: number }).__pageToken);
    await page.evaluate(prompt => { (window as unknown as { __prompt: string }).__prompt = prompt; (window as unknown as { __stubRan: boolean }).__stubRan = true; }, state.promptText);
    await page.evaluate(() => { (document.getElementById("send") as HTMLButtonElement).click(); });
    return "user_turn";
  };
  worker.attachFiles = async () => undefined;
  worker.assertSelectedEffort = async () => undefined;
  worker.waitForMultipartAcknowledgement = async () => undefined;
  const progress = new ChatGptExternalTurnProgress();
  const originalAcknowledge = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async (revision: number) => {
    state.deliveries += 1;
    await originalAcknowledge(revision);
  };
  let begins = 0;
  let commits = 0;
  const fence = {
    begin: async () => ++begins,
    commit: async () => { commits += 1; return true; },
  };
  return { worker, progress, fence, fenceBegins: () => begins, fenceCommits: () => commits };
}

function buildTurn(page: import("playwright-core").Page, progress: ChatGptExternalTurnProgress, fence: { begin: () => Promise<number>; commit: (revision: number) => Promise<boolean> }, deltas: string[], abortSignal?: AbortSignal) {
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Task" }] },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_closure", turn_id: "turn_closure" }) },
  } as never);
  parsed.modelId = "gpt-5.6-sol";
  parsed.options.reasoning = "high";
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true }, undefined, {});
  return {
    traceId: `closure_${Math.random().toString(36).slice(2, 8)}`,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ ...compiled, release() {} }),
    abortSignal,
    externalProgress: progress,
    completionFence: fence,
    onSubmitted: () => {},
    onTextDelta: (delta: string) => { deltas.push(delta); },
    onHeartbeat: () => {},
  };
}

function traceCounts(): { reconciled: number; salvaged: number; lost: number; restore: () => void } {
  const counts: { reconciled: number; salvaged: number; lost: number; restore: () => void } = {
    reconciled: 0,
    salvaged: 0,
    lost: 0,
    restore: () => {},
  };
  const observe = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX)) {
      if (line.includes('"event":"assistant_turn_binding_reconciled"')) counts.reconciled += 1;
      if (line.includes('"event":"assistant_turn_binding_salvaged"')) counts.salvaged += 1;
      if (line.includes('"event":"assistant_turn_binding_lost"')) counts.lost += 1;
    }
  };
  const info = spyOn(console, "info").mockImplementation(observe);
  const warning = spyOn(console, "warn").mockImplementation(observe);
  const error = spyOn(console, "error").mockImplementation(observe);
  counts.restore = () => {
    info.mockRestore();
    warning.mockRestore();
    error.mockRestore();
  };
  return counts;
}

test("C-CLOSURE-2: mid-stream re-key remount recovers with exactly-once tool delivery", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const root = mkdtempSync(join(tmpdir(), "pkg-c-closure-s1-"));
  const state = { submissions: 0, deliveries: 0, toolExecutions: 0, promptText: "" };
  const deltas: string[] = [];
  const { page, close } = await openFixture(browser);
  const { worker, progress, fence, fenceBegins, fenceCommits } = buildWorker(page, state, root);
  const turn = buildTurn(page, progress, fence, deltas);
  const traces = traceCounts();
  const sessions = new ChatGptTurnSessions();
  const textFeed = new ChatGptTextFeed();
  turn.onTextDelta = delta => {
    deltas.push(delta);
    textFeed.push(delta);
  };
  let browserStarts = 0;
  const executionKey = "thread_closure:turn_closure";
  const startRuntime = () => {
    browserStarts += 1;
    const browser = (worker as { runBrowserTurn: (turn: unknown) => Promise<string> }).runBrowserTurn(turn);
    return {
      mode: "tools" as const,
      token: Promise.resolve("turn_closure_token"),
      externalProgress: progress,
      browser,
      physicalSettlement: browser.then(() => undefined, () => undefined),
      trace: new ChatGptTraceFeed(),
      text: textFeed,
      cancel: () => {},
    };
  };
  try {
    await page.evaluate(() => { (window as unknown as { __scenario: string }).__scenario = "S1"; });
    const session = sessions.getOrCreate(executionKey, startRuntime, turn.traceId, "owner_closure", "turn_closure", "thread_closure");
    // The fake tool is requested exactly once while the response streams, before the remount.
    setTimeout(() => { state.toolExecutions += 1; progress.recordToolBatch(1); }, 700);
    setTimeout(() => { progress.recordToolResult(); }, 1300);
    const outcome = await session.browserOutcome;
    expect(outcome.type).toBe("final");
    const finalText = outcome.type === "final" ? outcome.answer : "";
    expect(state.submissions).toBe(1);
    expect(state.toolExecutions).toBe(1);
    expect(state.deliveries).toBe(1);
    expect(fenceBegins()).toBe(1);
    expect(fenceCommits()).toBe(1);
    expect(traces.reconciled + traces.salvaged).toBeGreaterThanOrEqual(1);
    const streamedText = deltas.join("");
    expect((finalText.match(/Result prefix line/g) ?? []).length).toBe(1);
    expect((finalText.match(/ACCEPTANCE\\_DONE\\_927/g) ?? []).length).toBe(1);
    expect((streamedText.match(/Result prefix line/g) ?? []).length).toBe(1);
    expect((streamedText.match(/ACCEPTANCE\\_DONE\\_927/g) ?? []).length).toBe(1);

    // A native reconnect reuses the settled execution and re-observes its final and text feed.
    // It must not invoke the browser worker, submit again, redeliver the tool, or recommit.
    const beforeReconnect = {
      browserStarts,
      submissions: state.submissions,
      toolExecutions: state.toolExecutions,
      deliveries: state.deliveries,
      fenceBegins: fenceBegins(),
      fenceCommits: fenceCommits(),
      streamedText: textFeed.value(),
    };
    const reconnected = sessions.getOrCreate(executionKey, startRuntime, turn.traceId, "owner_closure", "turn_closure", "thread_closure");
    expect(reconnected).toBe(session);
    expect(reconnected.settledOutcome()).toEqual({ type: "final", answer: finalText });
    expect(reconnected.runtime.text.value()).toBe(streamedText);
    expect({
      browserStarts,
      submissions: state.submissions,
      toolExecutions: state.toolExecutions,
      deliveries: state.deliveries,
      fenceBegins: fenceBegins(),
      fenceCommits: fenceCommits(),
      streamedText: textFeed.value(),
    }).toEqual(beforeReconnect);
  } finally {
    traces.restore();
    sessions.clear();
    await close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("C-CLOSURE-1: terminal reconcile failure with a complete proven candidate salvages the real result", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const root = mkdtempSync(join(tmpdir(), "pkg-c-closure-s2-"));
  const state = { submissions: 0, deliveries: 0, toolExecutions: 0, promptText: "" };
  const deltas: string[] = [];
  const { page, close } = await openFixture(browser);
  const { worker, progress, fence, fenceBegins, fenceCommits } = buildWorker(page, state, root);
  const turn = buildTurn(page, progress, fence, deltas);
  const traces = traceCounts();
  try {
    await page.evaluate(() => { (window as unknown as { __scenario: string }).__scenario = "S2"; });
    const originalSnapshot = worker.responseDomSnapshot.bind(worker);
    let hideOneCandidateCompletionProof = true;
    worker.responseDomSnapshot = async (...args: unknown[]) => {
      const snapshot = await originalSnapshot(...args);
      if (hideOneCandidateCompletionProof && snapshot.visibleText.includes("SALVAGE_DONE_927")) {
        hideOneCandidateCompletionProof = false;
        return { ...snapshot, completionActionVisible: false };
      }
      return snapshot;
    };
    const finalText = await (worker as { runBrowserTurn: (turn: unknown) => Promise<string> }).runBrowserTurn(turn);
    expect(state.submissions).toBe(1);
    expect(traces.salvaged).toBeGreaterThanOrEqual(1);
    expect(traces.lost).toBeGreaterThanOrEqual(1);
    expect(fenceBegins()).toBe(1);
    expect(fenceCommits()).toBe(1);
    const streamedText = deltas.join("");
    expect((finalText.match(/Result prefix line/g) ?? []).length).toBe(1);
    expect((finalText.match(/SALVAGE\\_DONE\\_927/g) ?? []).length).toBe(1);
    expect((streamedText.match(/Result prefix line/g) ?? []).length).toBe(1);
    expect((streamedText.match(/SALVAGE\\_DONE\\_927/g) ?? []).length).toBe(1);
    expect((finalText.match(/Earlier drift/g) ?? []).length).toBe(0);
  } finally {
    traces.restore();
    await close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("C-CLOSURE-1b: an ambiguous candidate still fails typed and an incomplete response is never promoted", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const root = mkdtempSync(join(tmpdir(), "pkg-c-closure-s34-"));
  try {
    {
      const state = { submissions: 0, deliveries: 0, toolExecutions: 0, promptText: "" };
      const deltas: string[] = [];
      const { page, close } = await openFixture(browser);
      const { worker, progress, fence, fenceCommits } = buildWorker(page, state, root);
      const turn = buildTurn(page, progress, fence, deltas);
      try {
        await page.evaluate(() => { (window as unknown as { __scenario: string }).__scenario = "S3"; });
        let finalText: string | undefined;
        let failure: { code?: string } | undefined;
        await (worker as { runBrowserTurn: (turn: unknown) => Promise<string> }).runBrowserTurn(turn)
          .then((value: string) => { finalText = value; })
          .catch((error: { code?: string }) => { failure = error; });
        expect(finalText).toBeUndefined();
        expect(failure?.code).toBe("chatgpt_turn_binding_lost");
        expect(state.submissions).toBe(1);
        expect(fenceCommits()).toBe(0);
      } finally {
        await close();
      }
    }
    {
      const state = { submissions: 0, deliveries: 0, toolExecutions: 0, promptText: "" };
      const deltas: string[] = [];
      const { page, close } = await openFixture(browser);
      const { worker, progress, fence, fenceCommits } = buildWorker(page, state, root);
      const controller = new AbortController();
      const turn = buildTurn(page, progress, fence, deltas, controller.signal);
      try {
        await page.evaluate(() => { (window as unknown as { __scenario: string }).__scenario = "S4"; });
        let finalText: string | undefined;
        const pending = (worker as { runBrowserTurn: (turn: unknown) => Promise<string> }).runBrowserTurn(turn)
          .then(value => { finalText = value; return "resolved"; })
          .catch(() => "rejected");
        await new Promise(resolve => setTimeout(resolve, 2500));
        controller.abort();
        expect(await pending).toBe("rejected");
        expect(finalText).toBeUndefined();
        expect(state.submissions).toBe(1);
        expect(fenceCommits()).toBe(0);
      } finally {
        await close();
      }
    }
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
