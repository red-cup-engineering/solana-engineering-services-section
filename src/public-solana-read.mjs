import { PublicKey } from "@solana/web3.js";
import createJsonBigInt from "json-bigint";

const JSON_BIGINT = createJsonBigInt({ alwaysParseAsBig: true, useNativeBigInt: true });

const MAINNET_CAIP2_REFERENCE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_PROVIDERS = 8;
const MAX_ADDRESSES = 100;
const MAX_ATTEMPTS_PER_PROVIDER = 3;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_CONCURRENT_OPERATIONS = 4;

export const SOLANA_MAINNET_CAIP2 = `solana:${MAINNET_CAIP2_REFERENCE}`;
export const SOLANA_MAINNET_GENESIS_HASH = MAINNET_GENESIS_HASH;
export const SOLANA_PUBLIC_PROVIDERS = Object.freeze([
  Object.freeze({ id: "solana-mainnet-official", url: "https://api.mainnet-beta.solana.com/" }),
  Object.freeze({ id: "solana-mainnet-publicnode", url: "https://solana.publicnode.com/" }),
]);

export class PublicSolanaInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicSolanaInputError";
    this.code = "PUBLIC_SOLANA_INPUT_INVALID";
  }
}

export class PublicSolanaLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicSolanaLimitError";
    this.code = "PUBLIC_SOLANA_LIMIT";
  }
}

function boundedInteger(name, value, fallback, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new PublicSolanaLimitError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function normalizeProvider(value, index) {
  const item = typeof value === "string" ? { url: value } : value;
  let url;
  try { url = new URL(item?.url); }
  catch { throw new PublicSolanaInputError(`providers[${index}].url must be an absolute URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new PublicSolanaInputError(
      `providers[${index}].url must be credential-free HTTPS without query or fragment`,
    );
  }
  return Object.freeze({ id: String(item.id ?? `provider-${index + 1}`).slice(0, 128), url: url.href });
}

function normalizeProviders(values, maximum) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    throw new PublicSolanaLimitError(`providers must contain 1 through ${maximum} endpoints`);
  }
  const normalized = values.map(normalizeProvider);
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new PublicSolanaInputError("provider ids must be unique");
  }
  if (new Set(normalized.map(({ url }) => url)).size !== normalized.length) {
    throw new PublicSolanaInputError("provider URLs must be unique");
  }
  return Object.freeze(normalized);
}

function normalizeAddresses(values, maximum) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    throw new PublicSolanaLimitError(`addresses must contain 1 through ${maximum} public addresses`);
  }
  const normalized = values.map((value, index) => {
    if (typeof value !== "string" || value.length < 32 || value.length > 44
      || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) {
      throw new PublicSolanaInputError(
        `addresses[${index}] must be one base58-encoded 32-byte public address`,
      );
    }
    try {
      const normalized = new PublicKey(value).toBase58();
      if (normalized !== value) throw new Error("address was not canonical base58");
      return normalized;
    }
    catch {
      throw new PublicSolanaInputError(
        `addresses[${index}] must be one base58-encoded 32-byte public address`,
      );
    }
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new PublicSolanaInputError("addresses must not contain duplicates");
  }
  return Object.freeze(normalized);
}

function makeSemaphore(maximum) {
  let active = 0;
  const waiting = [];
  return async () => {
    if (active >= maximum) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      waiting.shift()?.();
    };
  };
}

function errorStatus(error) {
  for (const candidate of [error?.status, error?.statusCode, error?.cause?.status]) {
    if (Number.isInteger(candidate)) return candidate;
  }
  return null;
}

function isRetryable(error) {
  const status = errorStatus(error);
  return error?.transport === true || status === 408 || status === 429
    || (status != null && status >= 500 && status <= 599);
}

function retryAfterMilliseconds(headers, now, maximum) {
  const value = headers?.get?.("retry-after");
  if (value == null) return 0;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Math.max(0, Date.parse(value) - now());
  return Number.isFinite(requested) ? Math.min(Math.ceil(requested), maximum) : 0;
}

function failure(provider, attempt, error) {
  return Object.freeze({
    providerId: provider.id,
    endpoint: provider.url,
    attempt,
    stage: error?.stage ?? "transport",
    status: errorStatus(error),
    code: typeof error?.code === "string" ? error.code : null,
    retryable: isRetryable(error),
    retryAfterMs: Number.isInteger(error?.retryAfterMs) ? error.retryAfterMs : 0,
    message: String(error?.message ?? error).slice(0, 512),
  });
}

function providerError(stage, message, properties = {}) {
  return Object.assign(new Error(message), { name: "PublicSolanaProviderError", stage, ...properties });
}

function normalizeUnsignedDecimal(name, value) {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  throw providerError("validate-response", `${name} must be an unsigned decimal integer`);
}

function rpcSafeInteger(name, value) {
  const normalized = normalizeUnsignedDecimal(name, value);
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric)) {
    throw providerError("validate-response", `${name} exceeds the JSON-RPC safe-integer range`);
  }
  return numeric;
}

function byteLengthOfAccountData(value) {
  if (!Array.isArray(value) || typeof value[0] !== "string" || value[1] !== "base64") {
    throw providerError("validate-response", "account data must use base64 encoding");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value[0])) {
    throw providerError("validate-response", "account data is malformed base64");
  }
  return Buffer.from(value[0], "base64").byteLength;
}

function normalizeBatch(result, admittedAddresses) {
  const slot = normalizeUnsignedDecimal("context.slot", result?.context?.slot);
  const apiVersion = result?.context?.apiVersion == null ? null : String(result.context.apiVersion).slice(0, 64);
  if (!Array.isArray(result?.value) || result.value.length !== admittedAddresses.length) {
    throw providerError("validate-response", "getMultipleAccounts returned a different roster length");
  }
  const accounts = result.value.map((accountValue, index) => {
    if (accountValue == null) return Object.freeze({
      address: admittedAddresses[index], accountExists: false, empty: true, lamports: "0",
    });
    if (typeof accountValue !== "object") {
      throw providerError("validate-response", `account ${index} is malformed`);
    }
    const dataLength = byteLengthOfAccountData(accountValue.data);
    return Object.freeze({
      address: admittedAddresses[index],
      accountExists: true,
      empty: dataLength === 0,
      lamports: normalizeUnsignedDecimal(`account ${index} lamports`, accountValue.lamports),
    });
  });
  return Object.freeze({ slot, apiVersion, accounts: Object.freeze(accounts) });
}

function normalizeBlock(result, slot) {
  if (result == null || typeof result !== "object") {
    throw providerError("reconcile-slot", "getBlock did not return the finalized context slot");
  }
  if (typeof result.blockhash !== "string" || result.blockhash.length < 32 || result.blockhash.length > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(result.blockhash)) {
    throw providerError("reconcile-slot", "getBlock returned a malformed blockhash");
  }
  return Object.freeze({
    slot,
    blockhash: result.blockhash,
    blockHeight: result.blockHeight == null ? null : normalizeUnsignedDecimal("blockHeight", result.blockHeight),
    blockTime: result.blockTime == null ? null : normalizeUnsignedDecimal("blockTime", result.blockTime),
  });
}

async function readJsonRpc({ fetchImpl, provider, method, params, id, timeoutMs, now, maxRetryAfterMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
  } catch (cause) {
    throw providerError(method, cause?.name === "AbortError" ? `request timed out after ${timeoutMs}ms`
      : `transport failed: ${String(cause?.message ?? cause)}`, { cause, transport: true,
      code: cause?.name === "AbortError" ? "PUBLIC_SOLANA_TIMEOUT" : "PUBLIC_SOLANA_TRANSPORT" });
  } finally {
    clearTimeout(timer);
  }
  const retryAfterMs = retryAfterMilliseconds(response.headers, now, maxRetryAfterMs);
  if (!response.ok) {
    throw providerError(method, `HTTP ${response.status}`, { status: response.status, retryAfterMs });
  }
  let payload;
  try { payload = JSON_BIGINT.parse(await response.text()); }
  catch (cause) { throw providerError(method, "provider returned malformed JSON", { cause }); }
  if (payload == null || typeof payload !== "object" || payload.jsonrpc !== "2.0" || payload.id !== id) {
    throw providerError(method, "provider returned a malformed JSON-RPC envelope");
  }
  if (payload.error != null) {
    throw providerError(method, `JSON-RPC error ${String(payload.error.code ?? "unknown")}: ${String(
      payload.error.message ?? "provider refused request",
    ).slice(0, 256)}`, { code: `SOLANA_RPC_${String(payload.error.code ?? "UNKNOWN")}` });
  }
  if (!("result" in payload)) throw providerError(method, "provider response omitted result");
  return payload.result;
}

export function createPublicSolanaReadPool(options = {}) {
  const maxProviders = boundedInteger("maxProviders", options.maxProviders, MAX_PROVIDERS, 1, MAX_PROVIDERS);
  const providers = normalizeProviders(options.providers ?? SOLANA_PUBLIC_PROVIDERS, maxProviders);
  const maxAddresses = boundedInteger("maxAddresses", options.maxAddresses, MAX_ADDRESSES, 1, MAX_ADDRESSES);
  const maxAttemptsPerProvider = boundedInteger("maxAttemptsPerProvider", options.maxAttemptsPerProvider, 2,
    1, MAX_ATTEMPTS_PER_PROVIDER);
  const timeoutMs = boundedInteger("timeoutMs", options.timeoutMs, 8_000, 1, MAX_TIMEOUT_MS);
  const maxRetryAfterMs = boundedInteger("maxRetryAfterMs", options.maxRetryAfterMs, 2_000, 0,
    MAX_RETRY_AFTER_MS);
  const maxConcurrentOperations = boundedInteger("maxConcurrentOperations", options.maxConcurrentOperations,
    MAX_CONCURRENT_OPERATIONS, 1, MAX_CONCURRENT_OPERATIONS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new PublicSolanaInputError("fetch must be a function");
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const acquire = makeSemaphore(maxConcurrentOperations);

  async function observeNativeBalances(addresses) {
    const admittedAddresses = normalizeAddresses(addresses, maxAddresses);
    const release = await acquire();
    const attempts = [];
    const failures = [];
    let requestId = 0;
    try {
      for (const provider of providers) {
        for (let attempt = 1; attempt <= maxAttemptsPerProvider; attempt += 1) {
          let callsThisAttempt = 0;
          const call = (method, params = []) => readJsonRpc({ fetchImpl, provider, method, params,
            id: String(++requestId), timeoutMs, now, maxRetryAfterMs }).finally(() => { callsThisAttempt += 1; });
          try {
            const genesisHash = await call("getGenesisHash");
            if (genesisHash !== MAINNET_GENESIS_HASH) {
              throw providerError("verify-genesis",
                `provider genesis ${String(genesisHash).slice(0, 64)} is not Solana mainnet`);
            }
            const batch = normalizeBatch(await call("getMultipleAccounts", [admittedAddresses, {
              commitment: "finalized", encoding: "base64",
            }]), admittedAddresses);
            const boundary = normalizeBlock(await call("getBlock", [rpcSafeInteger("context.slot", batch.slot), {
              commitment: "finalized", transactionDetails: "none", rewards: false,
            }]), batch.slot);
            attempts.push(Object.freeze({ providerId: provider.id, endpoint: provider.url, attempt,
              outcome: "success", calls: 3 }));
            return Object.freeze({
              checked: true,
              caip2: SOLANA_MAINNET_CAIP2,
              commitment: "finalized",
              provider,
              attempt,
              context: Object.freeze({ slot: batch.slot, apiVersion: batch.apiVersion }),
              boundary,
              accounts: batch.accounts,
              coverage: Object.freeze({ nativeLamports: "observed", splTokens: "unobserved" }),
              attempts: Object.freeze(attempts),
              failures: Object.freeze(failures),
            });
          } catch (error) {
            const observedFailure = failure(provider, attempt, error);
            failures.push(observedFailure);
            attempts.push(Object.freeze({ providerId: provider.id, endpoint: provider.url, attempt,
              outcome: "failure", calls: callsThisAttempt }));
            if (!observedFailure.retryable || attempt >= maxAttemptsPerProvider) break;
            if (observedFailure.retryAfterMs > 0) await sleep(observedFailure.retryAfterMs);
          }
        }
      }
      return Object.freeze({
        checked: false,
        code: "PUBLIC_SOLANA_READ_EXHAUSTED",
        caip2: SOLANA_MAINNET_CAIP2,
        commitment: "finalized",
        accounts: null,
        context: null,
        boundary: null,
        coverage: Object.freeze({ nativeLamports: "unknown", splTokens: "unobserved" }),
        attempts: Object.freeze(attempts),
        failures: Object.freeze(failures),
      });
    } finally {
      release();
    }
  }

  return Object.freeze({ observeNativeBalances, providers });
}

export async function observePublicNativeBalances(addresses, options) {
  return createPublicSolanaReadPool(options).observeNativeBalances(addresses);
}
