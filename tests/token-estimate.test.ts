import { expect, test } from "bun:test";
import { get_encoding } from "tiktoken";
import { estimateTokens, estimateTokensForTransportValidation } from "../src/lib/token-estimate";

function previousChunkedEstimate(text: string): number {
  const encoding = get_encoding("o200k_base");
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4_096, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    }
    count += encoding.encode_ordinary(text.slice(start, end)).length;
    start = end;
  }
  return count;
}

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});

test("cached token estimation matches the prior chunked count and conservative validation never lowers it", () => {
  const arabicUnicode = "العربية والألمانية 中文 😀 é\n".repeat(200);
  const sourceCode = Array.from({ length: 40 }, (_, index) =>
    'export const value_' + index + ' = { path: "src/module-' + index + '.ts", ok: true, hash: "0123456789abcdef" };\n',
  ).join("");
  const json = JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
    id: index,
    url: "https://example.invalid/log/" + index + "?sig=abcdef0123456789",
    output: '{"ok":true,"value":"' + "a!b@c#d$e%f^g&h*".repeat(12) + '"}',
  })));
  const repeated = "a".repeat(4_096) + " ".repeat(4_096) + "a".repeat(4_096);

  let repeatedOptimized = 0;
  for (const text of [arabicUnicode, sourceCode, json, repeated]) {
    const optimized = estimateTokens(text);
    if (text === repeated) repeatedOptimized = optimized;
    const conservative = estimateTokensForTransportValidation(text);
    expect(conservative).toBeGreaterThanOrEqual(optimized);
    expect(conservative - optimized).toBe(Math.max(128, Math.ceil(optimized * 0.02)));
  }
  expect(repeatedOptimized).toBe(previousChunkedEstimate(repeated));
  expect(estimateTokensForTransportValidation(repeated)).toBeGreaterThanOrEqual(
    get_encoding("o200k_base").encode_ordinary(repeated).length,
  );
});
