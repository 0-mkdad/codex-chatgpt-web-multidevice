import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn, cache);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>' : answer}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "same-user" || scenario === "different-user") {
        // A single re-keyed group whose user bubble carries the exact submitted text is the
        // SAME logical accepted turn (C8) — the renderer may re-key it (trace 2ee611b31fab).
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-user" ? "submitted" : "unrelated"}`);
      } else {
        // A surviving old group, a competing extra turn, or an unfinished response fails closed.
        await expect(result).rejects.toMatchObject({ code: "chatgpt_turn_binding_lost" });
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("production re-key with pinned accepted identity rebinds; foreign turns fail closed with chatgpt_turn_binding_lost", async () => {
  // Trace 2ee611b31fab shape: the send-time evidence pinned acceptedUserIdentity to the
  // original key; the renderer then re-keyed the same logical turn. The exact submitted text
  // on the single re-keyed user group is the same-turn proof; anything else fails typed.
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Audit one module.\nThen summarize the finding.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["rekey-matching", "rekey-foreign", "rekey-two-turns", "rekey-prefix"] as const) {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node: HTMLElement, html: string) => { node.innerHTML = html; }, group("optimistic", prompt));
      baseline.acceptedUserIdentity = "group:user:optimistic";
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "rekey-foreign" ? "Different task entirely."
        : scenario === "rekey-prefix" ? prompt.slice(0, 10) : prompt;
      let html = group("persisted", text, true);
      if (scenario === "rekey-two-turns") html += group("second", prompt, true);
      await page.locator("main").evaluate((node: HTMLElement, next: string) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "rekey-matching") {
        const rebound = await result;
        expect(rebound.identity).toBe("group:assistant:persisted");
      } else {
        const error = await result.catch((value: unknown) => value) as { code?: string; message?: string };
        if (error?.code !== "chatgpt_turn_binding_lost") {
          console.info(`[binding-test] scenario=${scenario} error=${error instanceof Error ? `${error.message}` : JSON.stringify(error)}`);
        }
        expect(error?.code).toBe("chatgpt_turn_binding_lost");
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("stalled-attribution adoption adopts the re-keyed live group and fails closed on foreign turns", async () => {
  // The 35-minute blindness: the bound group still resolves (frozen) while the live response
  // streams into a re-keyed group. Adoption must take the proven same-turn group mid-stream,
  // reject a foreign group with the typed code, and stay idle without a candidate.
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Stalled attribution probe.";
    const group = (key: string, text?: string, answer = "Answer.") => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>${answer}</p></div></div></div>`;
    for (const scenario of ["adopt-matching", "adopt-foreign", "adopt-no-candidate"] as const) {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node: HTMLElement, html: string) => { node.innerHTML = html; }, group("optimistic", prompt));
      baseline.acceptedUserIdentity = "group:user:optimistic";
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      // The stall shape: the frozen old group REMAINS while the re-keyed group streams.
      const html = scenario === "adopt-no-candidate"
        ? group("optimistic", prompt)
        : group("optimistic", prompt) + group("persisted", scenario === "adopt-matching" ? prompt : "Different task entirely.", "Live answer so far.");
      await page.locator("main").evaluate((node: HTMLElement, next: string) => { node.innerHTML = next; }, html);
      const adoption = worker.adoptRekeyedAssistantResponse(page, baseline, binding);
      if (scenario === "adopt-matching") {
        const adopted = await adoption;
        expect(adopted?.identity).toBe("group:assistant:persisted");
      } else if (scenario === "adopt-foreign") {
        const outcome = await adoption.then((value: unknown) => ({ resolved: value }), (error: { code?: string; message?: string }) => ({ rejected: error }));
        console.info(`[stall-test] foreign outcome=${JSON.stringify(outcome, (_k, v) => v instanceof Error ? { message: v.message, code: (v as { code?: string }).code } : v)}`);
        expect((outcome as { rejected?: { code?: string } }).rejected?.code).toBe("chatgpt_turn_binding_lost");
      } else {
        expect(await adoption).toBeUndefined();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("completed exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await browser.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("deterministic turn-shape matrix keeps ambiguous rekeys fail-closed and preserves streamed prefixes", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const dimensions = {
      userCandidates: [0, 1, 2],
      assistantCandidates: [0, 1, 2],
      identity: ["stable", "rekeyed"] as const,
      sameSemanticUserText: [true, false],
      assistantPrefix: ["compatible", "incompatible"] as const,
      state: ["running", "completed"] as const,
      tools: ["idle", "in-flight"] as const,
    };
    let caseIndex = 0;
    const totalCases = 3 * 3 * 2 * 2 * 2 * 2 * 2;

    for (const userCandidates of dimensions.userCandidates) {
      for (const assistantCandidates of dimensions.assistantCandidates) {
        for (const identity of dimensions.identity) {
          for (const sameSemanticUserText of dimensions.sameSemanticUserText) {
            for (const assistantPrefix of dimensions.assistantPrefix) {
              for (const state of dimensions.state) {
                for (const tools of dimensions.tools) {
                  const label = JSON.stringify({ userCandidates, assistantCandidates, identity, sameSemanticUserText, assistantPrefix, state, tools });
                  const prompt = `submitted-prompt-${caseIndex}`;
                  const prefix = `delivered-prefix-${caseIndex}`;
                  const answer = assistantPrefix === "compatible" ? `${prefix} continuation` : `rewritten-answer-${caseIndex}`;
                  const running = state === "running";
                  const withCompletion = !running;
                  await page.locator("main").evaluate((node: HTMLElement) => { node.innerHTML = ""; });
                  const baseline = await worker.captureSubmissionBaseline(page, prompt);
                  baseline.acceptedUserIdentity = "group:user:accepted";
                  const blocks: string[] = [];
                  const group = (key: string, userText?: string, assistantText?: string) => `<div data-turn-key="${key}">
                    ${userText === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${userText}</div></div>`}
                    ${assistantText === undefined ? "" : `<div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
                      <div data-markdown-text-style="assistant-message"><p>${assistantText}</p></div></div>`}
                    ${assistantText === undefined || !withCompletion ? "" : '<div class="turn-action-controls"><button>Copy</button></div>'}
                  </div>`;

                  if (identity === "stable") blocks.push(group("accepted", prompt, prefix));
                  for (let candidate = 0; candidate < Math.max(userCandidates, assistantCandidates); candidate += 1) {
                    const userText = candidate < userCandidates
                      ? (sameSemanticUserText ? prompt : `foreign-prompt-${caseIndex}-${candidate}`)
                      : undefined;
                    const assistantText = candidate < assistantCandidates
                      ? (candidate === 0 ? answer : `second-assistant-${caseIndex}-${candidate}`)
                      : undefined;
                    blocks.push(group(`candidate-${candidate}`, userText, assistantText));
                  }
                  if (running) blocks.push('<form data-chatgpt-composer><button data-testid="stop-button" style="width:4px;height:4px">Stop</button></form>');
                  await page.locator("main").evaluate((node: HTMLElement, html: string) => { node.innerHTML = html; }, blocks.join(""));

                  const binding = {
                    identity: "group:assistant:accepted",
                    locator: page.locator('[data-turn-key="accepted"]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])'),
                    acceptedTurnIdentities: ["group:user:accepted", "group:assistant:accepted"],
                  };
                  const outcome = await worker.reconcileAssistantTurnBinding(
                    page,
                    baseline,
                    binding,
                    undefined,
                    undefined,
                    { requireCompletionVisible: !running },
                  ).then((value: unknown) => ({ kind: "bound" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));

                  if (identity === "stable") {
                    if (outcome.kind !== "bound") throw new Error(`${label}: stable accepted binding was rejected`);
                    if ((outcome as { value: { identity: string } }).value.identity !== binding.identity) {
                      throw new Error(`${label}: stable identity changed`);
                    }
                  } else {
                    const uniquelyProven = userCandidates === 1
                      && assistantCandidates === 1
                      && sameSemanticUserText;
                    if (uniquelyProven) {
                      if (outcome.kind !== "bound") throw new Error(`${label}: unique exact-prompt turn did not recover`);
                      if ((outcome as { value: { identity: string } }).value.identity !== "group:assistant:candidate-0") {
                        throw new Error(`${label}: unique exact-prompt turn bound to the wrong identity`);
                      }
                    } else if (userCandidates === 0 && assistantCandidates === 0) {
                      // No replacement exists: retaining the stale locator is non-authoritative.
                      if (outcome.kind !== "bound") throw new Error(`${label}: empty DOM unexpectedly errored`);
                      const stale = (outcome as { value: { identity: string; locator: Locator } }).value;
                      if (stale.identity !== binding.identity || await stale.locator.count() !== 0) {
                        throw new Error(`${label}: empty DOM acquired an authoritative candidate`);
                      }
                    } else {
                      if (outcome.kind !== "error") throw new Error(`${label}: ambiguous re-key acquired an authoritative binding`);
                      const error = (outcome as { error: { code?: string } }).error;
                      if (error.code !== "chatgpt_turn_binding_lost") throw new Error(`${label}: ambiguous re-key did not fail with chatgpt_turn_binding_lost`);
                    }
                  }

                  const markdownBuffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
                  const segment = (key: string, text: string): ChatGptMarkdownSegment => ({
                    key,
                    tag: "p",
                    html: `<p>${text}</p>`,
                    text,
                    sourceStart: 0,
                    sourceEnd: text.length,
                    streamable: true,
                  });
                  const firstDelta = markdownBuffer.observe([segment(`old-${caseIndex}`, prefix)], 0);
                  expect(firstDelta).toBe(prefix);
                  const nextDelta = markdownBuffer.observe([segment(`rekeyed-${caseIndex}`, answer)], 1);
                  if (assistantPrefix === "compatible") {
                    expect(nextDelta).toBe(" continuation");
                    expect(markdownBuffer.currentSnapshotIsConsistent()).toBeTrue();
                    const final = markdownBuffer.finish();
                    expect(final.markdown).toBe(answer);
                    expect((firstDelta + nextDelta).split(prefix).length - 1).toBe(1);
                  } else {
                    expect(nextDelta).toBe("");
                    expect(markdownBuffer.currentSnapshotIsConsistent()).toBeFalse();
                    expect(() => markdownBuffer.finish()).toThrow();
                    expect(firstDelta.split(prefix).length - 1).toBe(1);
                  }

                  const completion = new ChatGptCompletionTracker(0, 0);
                  const completionState = {
                    responsePresent: true,
                    running,
                    currentText: answer,
                    currentHtml: `<p>${answer}</p>`,
                    completionActionVisible: withCompletion,
                  };
                  if (tools === "in-flight") {
                    expect(completion.update({ ...completionState, externalToolCallsInFlight: true }, 1)).toBeFalse();
                  } else if (running) {
                    expect(completion.update({ ...completionState, externalToolCallsInFlight: false }, 1)).toBeFalse();
                  } else {
                    expect(completion.update({ ...completionState, externalToolCallsInFlight: false }, 1)).toBeFalse();
                    expect(completion.update({ ...completionState, externalToolCallsInFlight: false }, 2)).toBeTrue();
                  }
                  caseIndex += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(caseIndex).toBe(totalCases);
  } finally { await browser.close(); }
}, 120_000);
