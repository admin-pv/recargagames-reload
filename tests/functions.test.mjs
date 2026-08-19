/* =====================================================================
   Testes das Netlify Functions — rodam SEM rede e SEM banco.
   O fetch global é stubado, então nada aqui toca o Supabase de produção
   nem a Lapak. Cobre a matriz de "critério de pronto" do Brief 2 no nível
   de lógica; o teste de ponta a ponta com lote real é manual, no preview.

   Foco deste arquivo: /api/validate e o CONTRATO DE ENTRADA do
   /api/redeem (payload, uniformidade das mensagens, PII fora do log).
   O fluxo do dinheiro — claim atômico, create, desfecho, reconciliação —
   está em redeem.test.mjs.

   Rodar:  npm test        (ou: node --test tests/)
   ===================================================================== */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { skuMapRows, PLUSMO_ROW } from "./sku-map-fixture.mjs";

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_STUB_NAO_REAL";
process.env.IP_HASH_SALT = "salt-de-teste-nao-real";
process.env.URL = "https://reload.recargagames.com";
process.env.PROXY_RELOAD_KEY = "proxy-key-STUB-NAO-REAL";
process.env.LAPAK_ENV = "dev";

const ORIGIN = "https://reload.recargagames.com";

const CONTENT_DTU = "11111111-1111-4111-8111-111111111111";
const CONTENT_PIN = "22222222-2222-4222-8222-222222222222";
const CONTENT_OTHER_BATCH = "33333333-3333-4333-8333-333333333333";
const CONTENT_UNMAPPED = "44444444-4444-4444-8444-444444444444";

// Dados válidos de referência. O CPF 111.444.777-35 é o CPF de teste
// canônico (dígitos verificadores corretos, não é de ninguém).
const VALID_EMAIL = "jogador@email.com";
const VALID_CPF = "111.444.777-35";
const VALID_CPF_DIGITS = "11144477735";
const okPlayer = (over = {}) => ({
  user_id: "13846816197",
  email: VALID_EMAIL,
  cpf: VALID_CPF,
  marketing_optin: false,
  ...over,
});

const future = new Date(Date.now() + 30 * 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

const dtuContent = () => ({
  id: CONTENT_DTU,
  display_label: "110 Diamantes Free Fire",
  delivery_type: "DTU",
  product_code: "FF100_10-S116-br",
});
const pinContent = () => ({
  id: CONTENT_PIN,
  display_label: "Cartão Free Fire 100 Diamantes (PIN)",
  delivery_type: "PIN",
  product_code: "FFBV100-S22-br",
});
// SKU DTU de jogo que ainda não está no forms-map.json.
const unmappedContent = () => ({
  id: CONTENT_UNMAPPED,
  display_label: "50 Diamantes Mobile Legends",
  delivery_type: "DTU",
  product_code: "MLBB50-S9-br",
});

function batch(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Lote Teste Reload",
    status: "active",
    expires_at: future,
    contents: [dtuContent(), pinContent()],
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
  // Lote com 1 SKU mapeado + 1 SKU fora do forms-map.
  "RLBK-SKUNOVO001": {
    id: "v8",
    status: "EMITIDO",
    batch: batch({ contents: [dtuContent(), unmappedContent()] }),
  },
  // Lote cujo único conteúdo está fora do forms-map.
  "RLBK-SOSKUNOVO1": {
    id: "v9",
    status: "EMITIDO",
    batch: batch({ contents: [unmappedContent()] }),
  },
};

const db = {
  attempts: 0,
  rateFails: false,
  calls: [],
  logs: [],
  attemptWrites: [],
  // Catálogo pv_sku_delivery_map (Brief 6). Programável: `null` simula a
  // leitura falhando, que tem que virar 503 e não "segue sem o mapa".
  skuMap: skuMapRows(),
  skuMapFails: false,
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method || "GET";
  db.calls.push(`${method} ${target}`);

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    if (db.rateFails) return new Response("db down", { status: 500 });
    db.attempts += 1;
    return jsonResponse(db.attempts);
  }
  // Claim sempre concede: este arquivo testa o contrato de ENTRADA, não a
  // corrida. A matriz do claim está em redeem.test.mjs.
  if (target.includes("/rpc/pv_redeem_claim")) {
    return jsonResponse([{ voucher_id: "voucher-stub", attempt_number: 1 }]);
  }
  if (target.includes("/rest/v1/pv_sku_delivery_map")) {
    if (db.skuMapFails) return new Response("db down", { status: 500 });
    return jsonResponse(db.skuMap);
  }
  if (target.includes("/rest/v1/pv_redeem_attempts")) {
    db.attemptWrites.push({ method, body: init.body ? JSON.parse(init.body) : null });
    return jsonResponse([{ id: "attempt-stub" }]);
  }
  if (target.includes("/rest/v1/pv_vouchers") && method !== "GET") {
    return jsonResponse([{ id: "voucher-stub" }]);
  }
  if (target.includes("/rest/v1/pv_vouchers")) {
    const match = target.match(/code=eq\.([^&]+)/);
    const code = decodeURIComponent(match ? match[1] : "");
    const voucher = VOUCHERS[code];
    return jsonResponse(voucher ? [voucher] : []);
  }
  // Proxy da Lapak: create sempre bem-sucedido.
  if (target.includes("/api/order")) {
    return jsonResponse({
      status: 200,
      ok: true,
      data: { code: "SUCCESS", data: { tid: "RA-STUB-1", total_price: 12659 } },
    });
  }
  throw new Error(`fetch inesperado no teste: ${target}`);
};

// Captura de log pra provar que código completo e dado pessoal nunca são
// logados.
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
  db.attemptWrites = [];
  db.skuMap = skuMapRows();
  db.skuMapFails = false;
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

  // DTU: campo de entrega (user_id) + os campos comuns.
  assert.deepEqual(
    dtu.fields.map((f) => f.field),
    ["user_id", "email", "cpf", "marketing_optin"]
  );
  assert.equal(dtu.display_label, "110 Diamantes Free Fire");
  assert.equal(dtu.fields[0].type, "number");
  assert.equal(dtu.fields[0].required, true);

  // PIN: não pede dado de entrega, mas pede os comuns.
  assert.deepEqual(
    pin.fields.map((f) => f.field),
    ["email", "cpf", "marketing_optin"]
  );
});

test("contrato dos campos comuns: email obrigatório, CPF opcional, optin desmarcado", async () => {
  const { body } = await callValidate({ code: "RLBK-VALIDO0001" });
  const byField = Object.fromEntries(
    body.contents[0].fields.map((f) => [f.field, f])
  );

  assert.equal(byField.email.type, "email");
  assert.equal(byField.email.required, true);

  assert.equal(byField.cpf.type, "cpf");
  assert.equal(byField.cpf.required, false);

  assert.equal(byField.marketing_optin.type, "checkbox");
  assert.equal(byField.marketing_optin.required, false);
});

test("resposta traz a linha de finalidade do tratamento dos dados", async () => {
  const { body } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.match(body.purpose_note, /validação do resgate e prevenção a fraude/i);
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

/* --------------- fail-closed de SKU fora do forms-map -------------- */

test("SKU DTU fora do forms-map é recusado, não vira formulário genérico", async () => {
  const { body } = await callValidate({ code: "RLBK-SKUNOVO001" });
  assert.equal(body.valid, true);
  // O conteúdo mapeado continua ofertado; o não mapeado desaparece.
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].id, CONTENT_DTU);
  // E o SKU problemático é logado pra ser mapeado.
  assert.ok(db.logs.some((l) => l.includes("unmapped_delivery_sku") && l.includes("MLBB50-S9-br")));
});

test("lote cujo único conteúdo é SKU não mapeado devolve a genérica", async () => {
  const { res, body } = await callValidate({ code: "RLBK-SOSKUNOVO1" });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { valid: false, reason: "invalid_or_unavailable" });
  assert.ok(db.logs.some((l) => l.includes("all_contents_refused")));
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

/* --------------------------- CORS same-origin ---------------------
   Regressão: a allowlist dependia de URL/DEPLOY_PRIME_URL, que são env
   de BUILD e não existem no runtime da function. Resultado: todo deploy
   preview nascia com o próprio front bloqueado por CORS. Estes testes
   simulam um host que NÃO está na allowlist fixa.                     */

function postToHost(host, { origin, proto = "https" } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-nf-client-connection-ip": "203.0.113.7",
    "x-forwarded-host": host,
    "x-forwarded-proto": proto,
  };
  if (origin) headers.Origin = origin;
  return new Request(`https://${host}/api/validate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code: "RLBK-NAOEXISTE1" }),
  });
}

test("deploy preview: front do próprio host passa mesmo fora da allowlist fixa", async () => {
  const host = "deploy-preview-1--recargagames-reload.netlify.app";
  const res = await validate(postToHost(host, { origin: `https://${host}` }), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), `https://${host}`);
  const body = await res.json();
  assert.deepEqual(body, { valid: false, reason: "invalid_or_unavailable" });
});

test("same-origin não vira porta dos fundos: outro Origin no mesmo host é 403", async () => {
  const host = "deploy-preview-1--recargagames-reload.netlify.app";
  const res = await validate(
    postToHost(host, { origin: "https://site-do-atacante.com" }),
    ctx
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("branch deploy e domínio canônico também passam", async () => {
  for (const host of [
    "feat-reload-mvp--recargagames-reload.netlify.app",
    "reload.recargagames.com",
  ]) {
    db.attempts = 0;
    const res = await validate(postToHost(host, { origin: `https://${host}` }), ctx);
    assert.equal(res.status, 200, `${host} deveria passar`);
  }
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

test("redeem aceita DTU com payload completo e devolve processing + attempt_ref", async () => {
  const { res, body } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer(),
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, "processing");
  // attempt_ref é <code>-a<n>: o front precisa dele pra acompanhar.
  assert.equal(body.attempt_ref, "RLBK-VALIDO0001-a1");
});

test("redeem: PIN não exige user_id, mas exige email", async () => {
  const ok = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL, marketing_optin: true },
  });
  assert.equal(ok.body.status, "processing");

  db.attempts = 0;
  const semEmail = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_PIN,
    player_data: {},
  });
  assert.equal(semEmail.res.status, 400);
  assert.ok(semEmail.body.errors.email);
  // PIN não pede user_id, então não pode reclamar dele.
  assert.equal(semEmail.body.errors.user_id, undefined);
});

test("redeem revalida user_id: vazio e não-numérico são 400", async () => {
  const vazio = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ user_id: "" }),
  });
  assert.equal(vazio.res.status, 400);
  assert.equal(vazio.body.status, "invalid_payload");
  assert.ok(vazio.body.errors.user_id);

  db.attempts = 0;
  const texto = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ user_id: "abc123" }),
  });
  assert.equal(texto.res.status, 400);
  assert.match(texto.body.errors.user_id, /números/i);
});

test("email: obrigatório e com validação de formato", async () => {
  const casos = ["", "jogador", "jogador@", "jogador@email", "a@b.c d", "@email.com"];
  for (const email of casos) {
    db.attempts = 0;
    const { res, body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer({ email }),
    });
    assert.equal(res.status, 400, `deveria recusar email ${JSON.stringify(email)}`);
    assert.ok(body.errors.email, `faltou erro de email pra ${JSON.stringify(email)}`);
  }

  db.attempts = 0;
  const ok = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ email: "Jogador.Teste+tag@Sub.Dominio.com.br" }),
  });
  assert.equal(ok.body.status, "processing");
});

test("CPF: opcional quando vazio, validado por dígito verificador quando preenchido", async () => {
  // Ausente e string vazia passam — é opcional.
  for (const player of [okPlayer({ cpf: undefined }), okPlayer({ cpf: "" })]) {
    db.attempts = 0;
    const { res, body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: player,
    });
    assert.equal(res.status, 200);
    assert.equal(body.status, "processing");
  }

  // Dígito verificador errado, tamanho errado e repetido são recusados.
  for (const cpf of ["111.444.777-36", "11144477734", "123456789", "111.111.111-11"]) {
    db.attempts = 0;
    const { res, body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer({ cpf }),
    });
    assert.equal(res.status, 400, `deveria recusar CPF ${cpf}`);
    assert.ok(body.errors.cpf, `faltou erro de CPF pra ${cpf}`);
  }

  // Com e sem máscara, o CPF válido passa.
  for (const cpf of [VALID_CPF, VALID_CPF_DIGITS]) {
    db.attempts = 0;
    const { body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer({ cpf }),
    });
    assert.equal(body.status, "processing");
  }
});

test("marketing_optin sempre entra no payload limpo, marcado ou não", async () => {
  for (const enviado of [true, false, undefined]) {
    db.attempts = 0;
    db.logs = [];
    const { body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer({ marketing_optin: enviado }),
    });
    assert.equal(body.status, "processing");
    const line = db.logs.find((l) => l.includes("order_create"));
    // A chave aparece nos três casos, inclusive quando o cliente não manda
    // nada: consentimento é escolha explícita, não ausência de resposta.
    // (O VALOR não vai pro log — ver o teste de validatePlayerData abaixo.)
    assert.ok(JSON.parse(line).fields.includes("marketing_optin"));
  }
});

test("email e CPF NUNCA aparecem em log de function", async () => {
  await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer(),
  });
  const joined = db.logs.join("\n");
  assert.ok(joined.length > 0, "deveria ter logado algo");
  assert.ok(!joined.includes(VALID_EMAIL), "email apareceu no log");
  assert.ok(!joined.includes("jogador"), "parte do email apareceu no log");
  assert.ok(!joined.includes(VALID_CPF), "CPF com máscara apareceu no log");
  assert.ok(!joined.includes(VALID_CPF_DIGITS), "CPF em dígitos apareceu no log");
  assert.ok(!joined.includes("13846816197"), "user_id apareceu no log");
  // Só os NOMES dos campos.
  const line = db.logs.find((l) => l.includes("order_create"));
  assert.deepEqual(JSON.parse(line).fields, ["user_id", "email", "cpf", "marketing_optin"]);
});

test("email e CPF não voltam ecoados na resposta de erro", async () => {
  const { res } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ user_id: "" }),
  });
  const raw = await res.text();
  assert.ok(!raw.includes(VALID_EMAIL));
  assert.ok(!raw.includes(VALID_CPF));
  assert.ok(!raw.includes(VALID_CPF_DIGITS));
});

test("redeem recusa conteúdo que não é do lote do voucher", async () => {
  const { body } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_OTHER_BATCH,
    player_data: okPlayer(),
  });
  assert.equal(body.status, "invalid_or_unavailable");
  assert.ok(db.logs.some((l) => l.includes("content_not_in_batch")));
});

test("redeem recusa SKU fora do forms-map mesmo com content_id certo", async () => {
  const { res, body } = await callRedeem({
    code: "RLBK-SKUNOVO001",
    content_id: CONTENT_UNMAPPED,
    player_data: okPlayer(),
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, "invalid_or_unavailable");
  assert.ok(db.logs.some((l) => l.includes("unmapped_delivery_sku")));
  // A recusa acontece ANTES do claim: o voucher não pode ser consumido
  // por um conteúdo que nunca viraria order.
  assert.ok(!db.calls.some((c) => c.includes("pv_redeem_claim")));
});

test("redeem em voucher usado/vencido devolve a genérica", async () => {
  for (const code of ["RLBK-USADO00001", "RLBK-VENCIDO001", "RLBK-NAOEXISTE1"]) {
    db.attempts = 0;
    const { body } = await callRedeem({
      code,
      content_id: CONTENT_DTU,
      player_data: okPlayer(),
    });
    assert.equal(body.status, "invalid_or_unavailable");
  }
});

test("redeem também é rate limited (mesmo balde do validate)", async () => {
  for (let i = 0; i < 10; i++) {
    await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer(),
    });
  }
  const { res } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer(),
  });
  assert.equal(res.status, 429);
});

test("redeem descarta campos extras que o cliente inventar", async () => {
  await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ product_code: "FF-HACK", admin: true, is_paid: true }),
  });
  const line = db.logs.find((l) => l.includes("order_create"));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line).fields, ["user_id", "email", "cpf", "marketing_optin"]);
});

test("voucher indisponível não chega nem perto da Lapak", async () => {
  for (const code of ["RLBK-USADO00001", "RLBK-VENCIDO001", "RLBK-PROCESS001", "RLBK-NAOEXISTE1"]) {
    db.attempts = 0;
    db.calls = [];
    await callRedeem({ code, content_id: CONTENT_DTU, player_data: okPlayer() });
    for (const call of db.calls) {
      assert.ok(!/\/api\/order/.test(call), `chamada à Lapak com voucher ${code}: ${call}`);
      assert.ok(!/pv_redeem_claim/.test(call), `claim com voucher ${code}`);
    }
  }
});

test("payload inválido não consome o voucher: 400 acontece antes do claim", async () => {
  const { res } = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer({ email: "" }),
  });
  assert.equal(res.status, 400);
  assert.ok(!db.calls.some((c) => c.includes("pv_redeem_claim")));
  assert.ok(!db.calls.some((c) => c.includes("/api/order")));
});

test("REDEEM_ENABLED=false devolve manutenção sem tocar em nada", async () => {
  process.env.REDEEM_ENABLED = "false";
  try {
    const { res, body } = await callRedeem({
      code: "RLBK-VALIDO0001",
      content_id: CONTENT_DTU,
      player_data: okPlayer(),
    });
    assert.equal(res.status, 200);
    assert.equal(body.status, "maintenance");
    assert.match(body.message, /manutenção/i);
    // Interruptor de pânico de verdade: nem o banco é consultado.
    assert.equal(db.calls.length, 0);
  } finally {
    delete process.env.REDEEM_ENABLED;
  }
});

/* ============ catálogo pv_sku_delivery_map (Brief 6) ============== */

test("catálogo em tabela: SKU do seed continua resolvendo nas duas portas", async () => {
  // Regressão do Brief 3 atravessando a mudança de fonte: o mapa saiu do
  // forms-map.json e virou SELECT, e FFBV/FF têm que responder igual.
  const { body } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(body.valid, true);
  assert.deepEqual(
    body.contents.map((c) => c.delivery_type).sort(),
    ["DTU", "PIN"]
  );
  assert.ok(db.calls.some((c) => c.includes("pv_sku_delivery_map")), "o catálogo foi lido");

  const redeemed = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_PIN,
    player_data: okPlayer(),
  });
  assert.equal(redeemed.body.status, "processing");
});

test("SKU inventado, ausente da tabela → unmapped_delivery_sku, voucher intacto", async () => {
  // O critério de pronto do brief. MLBB não está no catálogo: recusa antes
  // do claim, sem order e sem consumir o voucher.
  const { res, body } = await callRedeem({
    code: "RLBK-SOSKUNOVO1",
    content_id: CONTENT_UNMAPPED,
    player_data: okPlayer(),
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, "invalid_or_unavailable");
  assert.ok(!db.calls.some((c) => c.includes("pv_redeem_claim")), "não travou o voucher");
  assert.ok(!db.calls.some((c) => c.includes("/api/order")), "não chamou a Lapak");
  assert.ok(db.logs.some((l) => l.includes("unmapped_delivery_sku")), "o motivo foi logado");
});

test("cadastrar o SKU na tabela destrava o resgate — sem deploy", async () => {
  // O ponto inteiro do brief: a mesma request que falhou acima passa
  // depois de UMA linha nova no catálogo. Nada de código mudou entre as
  // duas — é o cenário da campanha Plusmo.
  const plusmoContent = "55555555-5555-4555-8555-555555555555";
  VOUCHERS["RLBK-PLUSMO0001"] = {
    id: "v10",
    status: "EMITIDO",
    batch: batch({
      contents: [
        {
          id: plusmoContent,
          display_label: "Minecraft 500 Minecoins",
          delivery_type: "PIN",
          product_code: "MCPIN500-mx",
        },
      ],
    }),
  };

  const antes = await callValidate({ code: "RLBK-PLUSMO0001" });
  assert.equal(antes.body.valid, false, "sem a linha no catálogo, recusado");

  db.skuMap = skuMapRows([PLUSMO_ROW]);

  const depois = await callValidate({ code: "RLBK-PLUSMO0001" });
  assert.equal(depois.body.valid, true);
  assert.equal(depois.body.contents[0].delivery_type, "PIN");
  // PIN não pede dado de entrega: só os campos comuns.
  assert.deepEqual(
    depois.body.contents[0].fields.map((f) => f.field),
    ["email", "cpf", "marketing_optin"]
  );
});

test("catálogo ilegível é 503 nas duas portas — nunca 'segue sem o mapa'", async () => {
  db.skuMapFails = true;

  const validated = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(validated.res.status, 503);
  assert.equal(validated.body.error, "temporarily_unavailable");

  db.calls = [];
  const redeemed = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_DTU,
    player_data: okPlayer(),
  });
  assert.equal(redeemed.res.status, 503);
  // O que mais importa: falhou ANTES do claim, então o voucher não foi
  // consumido por um problema de infraestrutura nosso.
  assert.ok(!db.calls.some((c) => c.includes("pv_redeem_claim")));
  assert.ok(!db.calls.some((c) => c.includes("/api/order")));
});

test("catálogo vazio recusa tudo em vez de adivinhar", async () => {
  // O cenário "código subiu antes da migration". Fail-closed: o app fica
  // inútil, mas não entrega nada no tipo errado.
  db.skuMap = [];

  const { body } = await callValidate({ code: "RLBK-VALIDO0001" });
  assert.equal(body.valid, false);
  assert.equal(body.reason, "invalid_or_unavailable");

  const redeemed = await callRedeem({
    code: "RLBK-VALIDO0001",
    content_id: CONTENT_PIN,
    player_data: okPlayer(),
  });
  assert.equal(redeemed.body.status, "invalid_or_unavailable");
  assert.ok(!db.calls.some((c) => c.includes("/api/order")));
});

test("o catálogo não é lido para código inválido — sondar não custa banco extra", async () => {
  await callValidate({ code: "RLBK-NAOEXISTE1" });
  assert.ok(!db.calls.some((c) => c.includes("pv_sku_delivery_map")));
});
