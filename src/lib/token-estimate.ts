import { get_encoding, type Tiktoken } from "tiktoken";

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON/base64 can contain far more tokens than prose
 * of the same length. Count with the tokenizer used by the GPT-5 generation instead.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;
const TRANSPORT_VALIDATION_TOKEN_MARGIN_PERCENT = 2;
const TRANSPORT_VALIDATION_TOKEN_MARGIN_MIN = 128;
let tokenizer: Tiktoken | undefined;

function chatGptTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 */
export function estimateTokens(text: string, modelId?: string): number {
  void modelId;
  if (!text) return 0;

  const encoding = chatGptTokenizer();
  // Long generated payloads often contain many byte-identical chunks, especially whitespace,
  // repeated source fixtures, base64 padding, and serialized context records. Encoding the same
  // chunk again is pure CPU cost. Keep this cache local to one estimate so prompt contents are not
  // retained across requests and token accounting remains byte-for-byte identical to the previous
  // chunked algorithm.
  const chunkTokenCounts = new Map<string, number>();
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        end -= 1;
      }
    }
    const chunk = text.slice(start, end);
    let chunkTokens = chunkTokenCounts.get(chunk);
    if (chunkTokens === undefined) {
      chunkTokens = encoding.encode_ordinary(chunk).length;
      chunkTokenCounts.set(chunk, chunkTokens);
    }
    count += chunkTokens;
    start = end;
  }
  return count;
}

/**
 * Browser submission validation needs headroom for product-side tokenization and request framing
 * that are not represented by the visible composer text. Keep the fast tokenizer count as the
 * source estimate, then add a small bounded margin only at transport boundaries.
 */
export function estimateTokensForTransportValidation(text: string, modelId?: string): number {
  const estimated = estimateTokens(text, modelId);
  if (estimated === 0) return 0;
  return estimated + Math.max(
    TRANSPORT_VALIDATION_TOKEN_MARGIN_MIN,
    Math.ceil(estimated * TRANSPORT_VALIDATION_TOKEN_MARGIN_PERCENT / 100),
  );
}
