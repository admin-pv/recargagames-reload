/* =====================================================================
   Testes das Netlify Functions — rodam SEM rede e SEM banco.
   O fetch global é stubado, então nada aqui toca o Supabase de produção
   nem a Lapak. Cobre a matriz de "critério de pronto" do Brief 2 no nível
   de lógica; o teste de ponta a ponta com lote real é manual, no preview.

   Rodar:  npm test        (ou: node --test tests/)
   ===================================================================== */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_STUB_NAO_REAL";
process.env.IP_HASH_SALT = "salt-de-teste-nao-real";
process.env.URL = "https://reload.recargagames.com";

const ORIGIN = "https://reload.recargagames.com";

const CONTENT_DTU = "11111111-1111-4111-8111-111111111111";
const CONTENT_PIN = "22222222-2222-4222-8222-222222222222";
const CONTENT_OTHER_BATCH = "33333333-3333-4333-8333-333333333333";

const future = new Date(Date.now() + 30 * 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

function batch(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Lote Teste Reload",
    status: "active",
    expires_at: future,
    contents: [
      {
        id: CONTENT_DTU,
        display_label: "110 Diamantes Free Fire",
        delivery_type: "DTU",
        product_code: "FF100_10-S116-br",
      },
      {
        id: CONTENT_PIN,
        display_label: "Cartão Free Fire 100 Diamantes (PIN)",
        delivery_type: "PIN",
        product_code: "FFBV100-S22-br",
      },
    ],
    ...overrides,
  };
}

const VOUCHERS = {
  "RLBK-VALIDO0001": { id: "v1", status: "EMITIDO", batch: batch() },
  "RLBK-USADO00001": { id: "v2", status: "USADO", batch: batch() },
  "RLBK-CANCEL0001": { id: "v3", status: "CANCELADO", batch: batch() },
  "RLBK-PROCESS001": { id: "v4", status: "PROCESSING", batch: batch() },
  "RLBK-VENCIDO001": { id: "v5", status: "EMITIDO", batch: batch({ expires_at: past }) },
  "RLBK-LOTECANC01": { id: "v6", status: "EMITIDO", batch: batch({ status: "cancelled" }) },
  "RLBK-SEMCONTEUD": { id: "v7", status: "EMITIDO", batch: batch({ contents: [] }) },
};

const db = { attempts: 0, rateFails: false, calls: [], logs: [] };

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = async (url) => {
  const target = String(url);
  db.calls.push(target);

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    if (db.rateFails) return new Response("db down", { status: 500 });
    db.attempts += 1;
    return jsonResponse(db.attempts);
  }
  if (target.includes("/rest/v1/pv_vouchers")) {
    const match = target.match(/code=eq\.([^&]+)/);
    const code = decodeURIComponent(match ? match[1] : "");
    const voucher = VOUCHERS[code];
    return jsonResponse(voucher ? [voucher] : []);
  }
  throw new Error(`fetch inesperado no teste: ${target}`);
};

// Captura de log pra provar que código completo nunca é logado.
for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    db.logs.push(args.map(String).join(" "));
    if (process.env.TEST_VERBOSE) original(...args);
  };
}

const { default: validate } = await import("../netlify/functions/validate.mjs");
const { default: redeem } = await import("../netlify/functions/redeem.mjs");

function post(body, { origin = ORIGIN, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", "x-nf-client-connection-ip": "203.0.113.7" };
  if (origin) headers.Origin = origin;
  return new Request("https://reload.recargagames.com/api/validate", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const ctx = { ip: "203.0.113.7" };

async function callValidate(body, opts) {
  const res = await validate(post(body, opts), ctx);
  return { res, body: await res.clone().json().catch(() => null) };
}

async function callRedeem(body, opts) {
  const res = await redeem(post(body, opts), ctx);
  return { res, body: await res.clone().json().catch(() => null) };
}

beforeEach(() => {
  db.attempts = 0;
  db.rateFails = false;
  db.calls = [];
  db.logs = [];
});

/* ------------------------- /api/validate -------------------------- */

test("código válido devolve o lote com os dois conteúdos e os campos do form", async () => {
  const { res, body } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(res.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.batch_name, "Lote Teste Reload");
  assert.equal(body.contents.length, 2);

  const dtu = body.contents.find((c) => c.delivery_type === "DTU");
  const pin = body.contents.find((c) => c.delivery_type === "PIN");
  assert.equal(dtu.display_label, "110 Diamantes Free Fire");
  assert.equal(dtu.fields.length, 1);
  assert.equal(dtu.fields[0].field, "user_id");
  assert.equal(dtu.fields[0].type, "number");
  assert.equal(dtu.fields[0].required, true);
  // PIN não pede nada.
  assert.deepEqual(pin.fields, []);
});

test("product_code NUNCA vai pro front", async () => {
  const { res } = await callValidate({ code: "RLBK-VALIDO0001" });
  const raw = await res.text();
  assert.ok(!raw.includes("FF100_10"), "SKU DTU vazou na resposta");
  assert.ok(!raw.includes("FFBV100"), "SKU PIN vazou na resposta");
  assert.ok(!raw.includes("product_code"), "chave product_code vazou na resposta");
});

test("nem a secret key nem o salt aparecem na resposta", async () => {
  const { res } = await callValidate({ code: "RLBK-VALIDO0001" });
  const raw = await res.text();
  assert.ok(!raw.includes("sb_secret"));
  assert.ok(!raw.includes("salt-de-teste"));
});

test("normaliza o código: minúsculas e espaços colados", async () => {
  const { body } = await callValidate({ code: "  rlbk-valido0001 " });
  assert.equal(body.valid, true);
});

test("mensagem genérica idêntica para inexistente, usado, cancelado, vencido e lote cancelado", async () => {
  const codes = [
    "RLBK-NAOEXISTE1",
    "RLBK-USADO00001",
    "RLBK-CANCEL0001",
    "RLBK-VENCIDO001",
    "RLBK-LOTECANC01",
  ];
  const bodies = [];
  for (const code of codes) {
    db.attempts = 0; // isola do rate limit
    const { res, body } = await callValidate({ code });
    assert.equal(res.status, 200);
    bodies.push(JSON.stringify(body));
  }
  const expected = JSON.stringify({ valid: false, reason: "invalid_or_unavailable" });
  for (const body of bodies) assert.equal(body, expected);
});

test("PROCESSING é a única exceção — devolve reason processing", async () => {
  const { body } = await callValidate({ code: "RLBK-PROCESS001" });
  assert.deepEqual(body, { valid: false, reason: "processing" });
});

test("lote sem conteúdo cai na genérica e loga erro de cadastro", async () => {
  const { body } = await callValidate({ code: "RLBK-SEMCONTEUD" });
  assert.deepEqual(body, { valid: false, reason: "invalid_or_unavailable" });
  assert.ok(db.logs.some((l) => l.includes("batch_without_contents")));
});

test("código malformado não chega ao banco e responde a genérica", async () => {
  const { body } = await callValidate({ code: "!!" });
  assert.deepEqual(body, { valid: false, reason: "invalid_or_unavailable" });
  assert.ok(!db.calls.some((c) => c.includes("pv_vouchers")), "não deveria consultar o banco");
  // ...mas consome tentativa do rate limit, pra sondagem não ser de graça.
  assert.equal(db.attempts, 1);
});

test("11ª tentativa na mesma janela devolve 429 com Retry-After", async () => {
  for (let i = 0; i < 10; i++) {
    const { res } = await callValidate({ code: "RLBK-NAOEXISTE1" });
    assert.equal(res.status, 200, `tentativa ${i + 1} deveria passar`);
  }
  const { res, body } = await callValidate({ code: "RLBK-NAOEXISTE1" });
  assert.equal(res.status, 429);
  assert.equal(body.error, "rate_limited");
  assert.equal(body.max_attempts, 10);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  assert.ok(body.retry_after_seconds > 0 && body.retry_after_seconds <= 600);
});

test("limitador fora do ar é fail-closed (503), não fail-open", async () => {
  db.rateFails = true;
  const { res, body } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(res.status, 503);
  assert.equal(body.error, "temporarily_unavailable");
  assert.ok(!db.calls.some((c) => c.includes("pv_vouchers")), "não deveria consultar o banco");
});

test("Origin fora da allowlist é 403 e não gasta banco", async () => {
  const { res, body } = await callValidate(
    { code: "RLBK-VALIDO0001" },
    { origin: "https://site-do-atacante.com" }
  );
  assert.equal(res.status, 403);
  assert.equal(body.error, "forbidden_origin");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(db.calls.length, 0);
});

test("preflight de origin permitida ecoa só aquele origin", async () => {
  const res = await validate(post(null, { method: "OPTIONS" }), ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(res.headers.get("Vary"), "Origin");
});

test("GET é 405", async () => {
  const res = await validate(post(null, { method: "GET" }), ctx);
  assert.equal(res.status, 405);
});

test("resposta é no-store (estado de voucher não pode ser cacheado)", async () => {
  const { res } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("log nunca contém o código completo, só 4 chars + hash", async () => {
  await callValidate({ code: "RLBK-VALIDO0001" });
  const joined = db.logs.join("\n");
  assert.ok(joined.length > 0, "deveria ter logado algo");
  assert.ok(!joined.includes("RLBK-VALIDO0001"), "código completo apareceu no log");
  assert.ok(joined.includes("RLBK…#"), "faltou o rótulo mascarado no log");
});

/* -------------------------- /api/redeem --------------------------- */

test("stub do redeem: DTU com user_id válido devolve not_implemented", async () => {
  const { res, body } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: { user_id: "13846816197" },
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, "not_implemented");
  assert.match(body.message, /manutenção/i);
});

test("stub do redeem: PIN não exige nenhum campo", async () => {
  const { body } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_PIN,
    player_data: {},
  });
  assert.equal(body.status, "not_implemented");
});

test("redeem revalida o formulário: user_id vazio e não-numérico são 400", async () => {
  const vazio = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: {},
  });
  assert.equal(vazio.res.status, 400);
  assert.equal(vazio.body.status, "invalid_payload");
  assert.ok(vazio.body.errors.user_id);

  db.attempts = 0;
  const texto = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: { user_id: "abc123" },
  });
  assert.equal(texto.res.status, 400);
  assert.match(texto.body.errors.user_id, /números/i);
});

test("redeem recusa conteúdo que não é do lote do voucher", async () => {
  const { body } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_OTHER_BATCH,
    player_data: { user_id: "13846816197" },
  });
  assert.equal(body.status, "invalid_or_unavailable");
  assert.ok(db.logs.some((l) => l.includes("content_not_in_batch")));
});

test("redeem em voucher usado/vencido devolve a genérica", async () => {
  for (const code of ["RLBK-USADO00001", "RLBK-VENCIDO001", "RLBK-NAOEXISTE1"]) {
    db.attempts = 0;
    const { body } = await callRedeem({
      code,
      content_id: CONTENT_DTU,
      player_data: { user_id: "13846816197" },
    });
    assert.equal(body.status, "invalid_or_unavailable");
  }
});

test("redeem também é rate limited (mesmo balde do validate)", async () => {
  for (let i = 0; i < 10; i++) {
    await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: { user_id: "13846816197" },
    });
  }
  const { res } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: { user_id: "13846816197" },
  });
  assert.equal(res.status, 429);
});

test("redeem descarta campos extras que o cliente inventar", async () => {
  await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: { user_id: "13846816197", product_code: "FF-HACK", admin: true },
  });
  const line = db.logs.find((l) => l.includes("not_implemented"));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line).fields, ["user_id"]);
});

test("redeem não fala com a Lapak nem escreve em pv_vouchers", async () => {
  await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: { user_id: "13846816197" },
  });
  for (const call of db.calls) {
    assert.ok(!/lapak|recargagames\.com\/api|proxy/i.test(call), `chamada suspeita: ${call}`);
  }
  // Só duas chamadas: rate limit (RPC) e leitura do voucher.
  assert.equal(db.calls.filter((c) => c.includes("pv_vouchers")).length, 1);
  assert.equal(db.calls.length, 2);
});
