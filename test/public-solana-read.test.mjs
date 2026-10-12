import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicSolanaInputError,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_PUBLIC_PROVIDERS,
  createPublicSolanaReadPool,
} from "../src/public-solana-read.mjs";

const SYSTEM = "11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get(name) { return normalized[name.toLowerCase()] ?? null; } };
}

function response(result, { status = 200, responseHeaders = {}, id } = {}) {
  const payload = status >= 200 && status < 300 ? { jsonrpc: "2.0", id, result } : {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(responseHeaders),
    async text() { return JSON.stringify(payload); },
  };
}

function account(lamports, data = "") {
  return { lamports, data: [data, "base64"], owner: SYSTEM, executable: false, rentEpoch: 0 };
}

function successfulResult(method) {
  if (method === "getGenesisHash") return SOLANA_MAINNET_GENESIS_HASH;
  if (method === "getMultipleAccounts") {
    return { context: { slot: 123, apiVersion: "2.3.4" }, value: [account(0), null] };
  }
  if (method === "getBlock") {
    return { blockhash: BLOCKHASH, blockHeight: 119, blockTime: 1_725_000_000 };
  }
  throw new Error(`unexpected method ${method}`);
}

function provider(id) { return { id, url: `https://${id}.example/` }; }

function scriptedFetch(handler) {
  const calls = [];
  const fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, ...request });
    return handler({ url, ...request, callIndex: calls.length - 1 });
  };
  return { fetch, calls };
}

function successfulFetch() {
  return scriptedFetch(({ method, id }) => response(successfulResult(method), { id }));
}

test("rejects credentials, secrets, mnemonics, and invalid addresses before network I/O", async () => {
  let calls = 0;
  const readPool = createPublicSolanaReadPool({ providers: [provider("only")], fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const rejected = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "1".repeat(88),
    "0".repeat(32),
    "short",
    new Uint8Array(32),
  ];
  for (const candidate of rejected) {
    await assert.rejects(() => readPool.observeNativeBalances([candidate]), PublicSolanaInputError);
  }
  await assert.rejects(() => readPool.observeNativeBalances([SYSTEM, SYSTEM]), /duplicates/u);
  await assert.rejects(() => createPublicSolanaReadPool({ providers: [provider("only")], maxAddresses: 1,
    fetch: async () => { calls += 1; } }).observeNativeBalances([SYSTEM, RENT]), /1 through 1/u);
  assert.equal(calls, 0);
  assert.throws(() => createPublicSolanaReadPool({ providers: ["http://rpc.example/"] }), /credential-free HTTPS/u);
  assert.throws(() => createPublicSolanaReadPool({ providers: ["https://user:secret@rpc.example/"] }),
    /credential-free HTTPS/u);
  assert.throws(() => createPublicSolanaReadPool({ providers: ["https://rpc.example/?key=secret"] }),
    /credential-free HTTPS/u);
  assert.throws(() => createPublicSolanaReadPool({ providers: ["https://rpc.example/#secret"] }),
    /credential-free HTTPS/u);
});

test("bounds concurrent observations at the pool boundary", async () => {
  let active = 0;
  let maximumActive = 0;
  const observed = scriptedFetch(async ({ method, id }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return response(successfulResult(method), { id });
  });
  const readPool = createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch,
    maxConcurrentOperations: 1 });
  const reports = await Promise.all([
    readPool.observeNativeBalances([SYSTEM, RENT]),
    readPool.observeNativeBalances([SYSTEM, RENT]),
    readPool.observeNativeBalances([SYSTEM, RENT]),
  ]);
  assert.ok(reports.every(({ checked }) => checked));
  assert.equal(maximumActive, 1);
});

test("uses one finalized batch and preserves exact zero, absence, context, boundary, and coverage", async () => {
  const observed = successfulFetch();
  const report = await createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch })
    .observeNativeBalances([SYSTEM, RENT]);
  assert.equal(report.checked, true);
  assert.equal(report.caip2, SOLANA_MAINNET_CAIP2);
  assert.deepEqual(observed.calls.map(({ method }) => method), ["getGenesisHash", "getMultipleAccounts", "getBlock"]);
  assert.deepEqual(observed.calls[1].params, [[SYSTEM, RENT], { commitment: "finalized", encoding: "base64" }]);
  assert.deepEqual(observed.calls[2].params, [123,
    { commitment: "finalized", transactionDetails: "none", rewards: false }]);
  assert.deepEqual(report.context, { slot: "123", apiVersion: "2.3.4" });
  assert.deepEqual(report.boundary,
    { slot: "123", blockhash: BLOCKHASH, blockHeight: "119", blockTime: "1725000000" });
  assert.deepEqual(report.accounts, [
    { address: SYSTEM, accountExists: true, empty: true, lamports: "0" },
    { address: RENT, accountExists: false, empty: true, lamports: "0" },
  ]);
  assert.deepEqual(report.coverage, { nativeLamports: "observed", splTokens: "unobserved" });
});

test("preserves a full unsigned-64-bit lamport value without JSON rounding", async () => {
  const observed = scriptedFetch(({ method, id }) => {
    if (method !== "getMultipleAccounts") return response(successfulResult(method), { id });
    const body = `{"jsonrpc":"2.0","id":"${id}","result":{"context":{"slot":123,"apiVersion":"2.3.4"},"value":[{"lamports":18446744073709551615,"data":["","base64"]},null]}}`;
    return { ok: true, status: 200, headers: headers(), async text() { return body; } };
  });
  const report = await createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch })
    .observeNativeBalances([SYSTEM, RENT]);
  assert.equal(report.checked, true);
  assert.equal(report.accounts[0].lamports, "18446744073709551615");
});

test("honors bounded Retry-After and replays the whole operation after 429", async () => {
  const slept = [];
  let batches = 0;
  const observed = scriptedFetch(({ method, id }) => {
    if (method === "getMultipleAccounts" && batches++ === 0) {
      return response(null, { id, status: 429, responseHeaders: { "retry-after": "99" } });
    }
    return response(successfulResult(method), { id });
  });
  const report = await createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch,
    maxRetryAfterMs: 25, sleep: async (milliseconds) => slept.push(milliseconds) })
    .observeNativeBalances([SYSTEM, RENT]);
  assert.equal(report.checked, true);
  assert.deepEqual(observed.calls.map(({ method }) => method),
    ["getGenesisHash", "getMultipleAccounts", "getGenesisHash", "getMultipleAccounts", "getBlock"]);
  assert.deepEqual(slept, [25]);
  assert.deepEqual(report.attempts.map(({ outcome }) => outcome), ["failure", "success"]);
  assert.equal(report.failures[0].status, 429);
  assert.equal(report.failures[0].retryAfterMs, 25);
});

test("records timeout, 403, and 5xx evidence with only transient same-provider retries", async () => {
  const seen = new Map();
  let busyFailures = 0;
  const observed = scriptedFetch(({ url, method, id }) => {
    const key = `${url}:${method}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (url.includes("timeout")) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (url.includes("forbidden")) return response(null, { id, status: 403 });
    if (url.includes("busy") && busyFailures++ === 0) return response(null, { id, status: 503 });
    return response(successfulResult(method), { id });
  });
  const report = await createPublicSolanaReadPool({
    providers: [provider("timeout"), provider("forbidden"), provider("busy")],
    fetch: observed.fetch,
    timeoutMs: 5,
    sleep: async () => {},
  }).observeNativeBalances([SYSTEM, RENT]);
  assert.equal(report.checked, true);
  assert.equal(report.provider.id, "busy");
  assert.deepEqual(report.failures.map(({ status }) => status), [null, null, 403, 503]);
  assert.equal(report.failures[0].code, "PUBLIC_SOLANA_TIMEOUT");
  assert.deepEqual(report.attempts.map(({ providerId }) => providerId),
    ["timeout", "timeout", "forbidden", "busy", "busy"]);
});

test("rejects wrong genesis and fails over without mixing provider evidence", async () => {
  const observed = scriptedFetch(({ url, method, id }) => {
    if (url.includes("wrong") && method === "getGenesisHash") return response("devnet-genesis", { id });
    return response(successfulResult(method), { id });
  });
  const report = await createPublicSolanaReadPool({ providers: [provider("wrong"), provider("right")],
    fetch: observed.fetch }).observeNativeBalances([SYSTEM, RENT]);
  assert.equal(report.checked, true);
  assert.equal(report.provider.id, "right");
  assert.deepEqual(observed.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method),
    ["getGenesisHash"]);
  assert.ok(observed.calls.slice(1).every(({ url }) => url.includes("right")));
  assert.equal(report.failures[0].stage, "verify-genesis");
});

test("refuses malformed batch and reconciliation responses instead of inventing zero", async () => {
  for (const malformedMethod of ["getMultipleAccounts", "getBlock"]) {
    const observed = scriptedFetch(({ method, id }) => response(method === malformedMethod ? null
      : successfulResult(method), { id }));
    const report = await createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch })
      .observeNativeBalances([SYSTEM, RENT]);
    assert.equal(report.checked, false);
    assert.equal(report.code, "PUBLIC_SOLANA_READ_EXHAUSTED");
    assert.equal(report.accounts, null);
    assert.equal(report.context, null);
    assert.equal(report.boundary, null);
    assert.equal(report.coverage.nativeLamports, "unknown");
    assert.equal(report.attempts.length, 1);
  }
});

test("serializable reports contain no secret, keypair, signature, or transaction material", async () => {
  const observed = successfulFetch();
  const report = await createPublicSolanaReadPool({ providers: [provider("only")], fetch: observed.fetch })
    .observeNativeBalances([SYSTEM, RENT]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /mnemonic|secret|private.?key|keypair|signature|transaction/iu);
  assert.doesNotThrow(() => structuredClone(report));
  assert.deepEqual(SOLANA_PUBLIC_PROVIDERS.map(({ url }) => url), [
    "https://api.mainnet-beta.solana.com/",
    "https://solana.publicnode.com/",
  ]);
});
