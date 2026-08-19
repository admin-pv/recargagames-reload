/* =====================================================================
   Testes do REDEEMER — Brief 3. O fluxo do dinheiro.

   Rodam SEM rede, SEM banco e SEM Lapak: o fetch global é stubado por um
   banco em memória que respeita as MESMAS regras do Postgres nos pontos
   que importam — o claim só concede uma vez, e os UPDATEs condicionais
   (`status=eq.X`) só pegam se o estado atual bater.

   Isso não é preciosismo de teste: o claim atômico é a única barreira
   contra resgate duplicado (o create da Lapak não tem idempotência), e um
   stub que concedesse sempre esconderia exatamente o bug que arruinaria
   a operação.

   Rodar:  npm test
   ===================================================================== */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { skuMapRows } from "./sku-map-fixture.mjs";

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_STUB_NAO_REAL";
process.env.IP_HASH_SALT = "salt-de-teste-nao-real";
process.env.PROXY_RELOAD_KEY = "proxy-key-STUB-NAO-REAL";
process.env.LAPAK_ENV = "dev";
process.env.FX_USD_IDR = "16200";
process.env.FX_BRL_USD = "5.4";

const ORIGIN = "https://reload.recargagames.com";
const CODE = "RLBK-VALIDO0001";
const CONTENT_DTU = "11111111-1111-4111-8111-111111111111";
const CONTENT_PIN = "22222222-2222-4222-8222-222222222222";
const CONTENT_TROCADO = "33333333-3333-4333-8333-333333333333";
const CONTENT_HOYO = "44444444-4444-4444-8444-444444444444";

const VALID_EMAIL = "jogador@email.com";
const VALID_CPF_DIGITS = "11144477735";
const USER_ID = "13846816197";

const PIN_REAL = "4077123456789012";
const SERIAL_REAL = "791234567";
const VOUCHER_CODE_STRING = `PIN : ${PIN_REAL}\tSerial : ${SERIAL_REAL}`;

const okPlayer = (over = {}) => ({
  user_id: USER_ID,
  email: VALID_EMAIL,
  cpf: VALID_CPF_DIGITS,
  marketing_optin: true,
  ...over,
});

/* ------------------------- banco em memória ------------------------- */

const contents = () => [
  {
    id: CONTENT_DTU,
    display_label: "110 Diamantes Free Fire",
    delivery_type: "DTU",
    product_code: "FF100_10-S116-br",
  },
  {
    id: CONTENT_PIN,
    display_label: "Cartão Free Fire 100 Diamantes",
    delivery_type: "PIN",
    product_code: "FFBV100-S22-br",
  },
  // SKU de voucher cadastrado como DTU — o erro do Brief 2 §8.2.
  {
    id: CONTENT_TROCADO,
    display_label: "Cartão cadastrado errado",
    delivery_type: "DTU",
    product_code: "FFBV100-S22-br",
  },
  // Caso Hoyoverse (Brief 6): SKU cuja linha no catálogo tem
  // requires_ip = true. PIN de propósito — um DTU esbarraria antes, na
  // falta de categoria no forms-map.json.
  {
    id: CONTENT_HOYO,
    display_label: "Cartão Genshin 60 Genesis Crystals",
    delivery_type: "PIN",
    product_code: "HOYOPIN60-mx",
  },
];

/** A linha de catálogo que liga o envio do IP. Não está no seed. */
const HOYO_PIN_ROW = { sku_pattern: "HOYOPIN", delivery_type: "PIN", requires_ip: true };

const db = {
  rate: 0,
  vouchers: [],
  attempts: [],
  calls: [],
  logs: [],
  // Catálogo pv_sku_delivery_map (Brief 6), programável por teste.
  skuMap: skuMapRows(),
  // Respostas programáveis do proxy.
  createResponse: null,
  statusResponse: null,
  createCalls: [],
  statusCalls: [],
};

function resetDb() {
  db.rate = 0;
  db.calls = [];
  db.logs = [];
  db.createCalls = [];
  db.statusCalls = [];
  db.attempts = [];
  db.vouchers = [
    {
      id: "v1",
      code: CODE,
      status: "EMITIDO",
      redeemed_at: null,
      order_ref: null,
      redeemed_product_code: null,
      player_data: null,
      batch: {
        id: "b1",
        name: "Lote Teste Reload",
        status: "active",
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        contents: contents(),
      },
    },
  ];
  db.skuMap = skuMapRows();
  db.createResponse = {
    status: 200,
    ok: true,
    data: { code: "SUCCESS", data: { tid: "RA-TESTE-1", total_price: 14969 } },
  };
  db.statusResponse = {
    status: 200,
    ok: true,
    data: { code: "SUCCESS", data: { status: "PENDING", tid: "RA-TESTE-1", transactions: [] } },
  };
}

const voucherByCode = (code) => db.vouchers.find((v) => v.code === code);
const voucherById = (id) => db.vouchers.find((v) => v.id === id);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Lê `campo=eq.valor` da query, como o PostgREST faria. */
function eqParam(query, field) {
  const match = query.match(new RegExp(`${field}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  const query = target.split("?")[1] || "";
  db.calls.push(`${method} ${target}`);

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    db.rate += 1;
    return jsonResponse(db.rate);
  }

  // ---- pv_redeem_claim: a barreira. Concede UMA vez, como o UPDATE
  // ---- ... WHERE status='EMITIDO' do Postgres.
  if (target.includes("/rpc/pv_redeem_claim")) {
    const voucher = voucherByCode(body.p_code);
    if (!voucher || voucher.status !== "EMITIDO") return jsonResponse([]);
    if (voucher.batch.status !== "active") return jsonResponse([]);
    if (Date.parse(voucher.batch.expires_at) <= Date.now()) return jsonResponse([]);
    voucher.status = "PROCESSING";
    const n = db.attempts.filter((a) => a.voucher_id === voucher.id).length + 1;
    return jsonResponse([{ voucher_id: voucher.id, attempt_number: n }]);
  }

  if (target.includes("/rest/v1/pv_sku_delivery_map")) {
    return jsonResponse(db.skuMap);
  }

  if (target.includes("/rest/v1/pv_redeem_attempts")) {
    if (method === "POST") {
      const row = {
        id: `a${db.attempts.length + 1}`,
        created_at: new Date().toISOString(),
        // Espelha o DEFAULT false da coluna (a function não manda o campo).
        pin_delivered: false,
        ...body,
      };
      db.attempts.push(row);
      return jsonResponse([row]);
    }
    if (method === "PATCH") {
      const id = eqParam(query, "id");
      const pinDelivered = eqParam(query, "pin_delivered");
      const rows = db.attempts.filter(
        (a) => a.id === id && (pinDelivered === null || String(a.pin_delivered) === pinDelivered)
      );
      for (const row of rows) Object.assign(row, body);
      return jsonResponse(rows);
    }
    // GET por attempt_ref, com o voucher embutido (select=...voucher:...)
    const ref = eqParam(query, "attempt_ref");
    const attempt = db.attempts.find((a) => a.attempt_ref === ref);
    if (!attempt) return jsonResponse([]);
    const voucher = voucherById(attempt.voucher_id);
    return jsonResponse([
      {
        ...attempt,
        voucher: voucher
          ? {
              id: voucher.id,
              code: voucher.code,
              status: voucher.status,
              redeemed_at: voucher.redeemed_at,
            }
          : null,
      },
    ]);
  }

  if (target.includes("/rest/v1/pv_vouchers")) {
    if (method === "PATCH") {
      const id = eqParam(query, "id");
      const requiredStatus = eqParam(query, "status");
      // UPDATE condicional: se o status atual não bate, zero linhas.
      const rows = db.vouchers.filter(
        (v) => v.id === id && (requiredStatus === null || v.status === requiredStatus)
      );
      for (const row of rows) Object.assign(row, body);
      return jsonResponse(rows);
    }
    const status = eqParam(query, "status");
    if (status) {
      return jsonResponse(
        db.vouchers
          .filter((v) => v.status === status)
          .map((v) => ({
            id: v.id,
            code: v.code,
            status: v.status,
            attempts: db.attempts.filter((a) => a.voucher_id === v.id),
          }))
      );
    }
    const code = eqParam(query, "code");
    const voucher = voucherByCode(code);
    return jsonResponse(voucher ? [voucher] : []);
  }

  // ---- proxy da Lapak ----
  if (target.includes("/api/order_status")) {
    db.statusCalls.push(target);
    if (db.statusResponse instanceof Error) throw db.statusResponse;
    return jsonResponse(db.statusResponse, db.statusResponse.__http || 200);
  }
  if (target.includes("/api/order")) {
    db.createCalls.push(body);
    if (db.createResponse instanceof Error) throw db.createResponse;
    if (db.createResponse.__http) return jsonResponse({ error: "x" }, db.createResponse.__http);
    return jsonResponse(db.createResponse);
  }

  throw new Error(`fetch inesperado no teste: ${target}`);
};

for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    db.logs.push(args.map(String).join(" "));
    if (process.env.TEST_VERBOSE) original(...args);
  };
}

const { default: redeem } = await import("../netlify/functions/redeem.mjs");
const { default: status } = await import("../netlify/functions/status.mjs");
const { default: reconcile } = await import("../netlify/functions/reconcile.mjs");
const { reconcileDecision } = await import("../lib/redeem.mjs");
const { parseVoucherCode, convertCost } = await import("../lib/lapak.mjs");

const ctx = { ip: "203.0.113.7" };

function request(path, body) {
  return new Request(`https://reload.recargagames.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "x-nf-client-connection-ip": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });
}

async function callRedeem(body) {
  const res = await redeem(request("/api/redeem", body), ctx);
  return { res, body: await res.clone().json().catch(() => null) };
}

async function callStatus(body) {
  const res = await status(request("/api/status", body), ctx);
  return { res, body: await res.clone().json().catch(() => null) };
}

const redeemDtu = () =>
  callRedeem({ code: CODE, content_id: CONTENT_DTU, player_data: okPlayer() });

beforeEach(resetDb);

/* ======================= caminho feliz — create ===================== */

test("DTU: claim trava o voucher, attempt nasce antes da Lapak e o create leva o contrato do A0", async () => {
  const { res, body } = await redeemDtu();

  assert.equal(res.status, 200);
  assert.equal(body.status, "processing");
  assert.equal(body.attempt_ref, `${CODE}-a1`);

  // Voucher travado.
  assert.equal(voucherByCode(CODE).status, "PROCESSING");

  // Contrato do create, corrigido empiricamente no A0: count_order (não
  // quantity) e user_id (não customer).
  assert.equal(db.createCalls.length, 1);
  assert.deepEqual(db.createCalls[0], {
    count_order: 1,
    product_code: "FF100_10-S116-br",
    user_id: USER_ID,
  });

  // O attempt existe e foi criado ANTES do create — se a resposta se
  // perdesse, a trilha já estaria no banco.
  const attempt = db.attempts[0];
  assert.equal(attempt.attempt_ref, `${CODE}-a1`);
  assert.equal(attempt.product_code, "FF100_10-S116-br");
  assert.equal(attempt.lapak_tid, "RA-TESTE-1");
});

test("persistência completa: dado pessoal, ip_hash, custo e câmbio", async () => {
  await redeemDtu();
  const attempt = db.attempts[0];

  assert.equal(attempt.email, VALID_EMAIL);
  assert.equal(attempt.cpf, VALID_CPF_DIGITS);
  assert.equal(attempt.marketing_optin, true);

  // ip_hash é HMAC, não o IP. 64 hex chars e nada parecido com o IP.
  assert.match(attempt.ip_hash, /^[0-9a-f]{64}$/);
  assert.ok(!attempt.ip_hash.includes("203.0.113"));

  // Custo: 14969 IDR / 16200 = 0,9240 USD; × 5,4 = 4,9898 BRL.
  assert.equal(attempt.cost_idr, 14969);
  assert.equal(attempt.fx_usd_idr, 16200);
  assert.equal(attempt.fx_brl_usd, 5.4);
  assert.ok(Math.abs(attempt.cost_usd - 0.9240) < 0.001);
  assert.ok(Math.abs(attempt.cost_brl - 4.9898) < 0.001);

  // O dado de ENTREGA fica no voucher; o de contato, não.
  const voucher = voucherByCode(CODE);
  assert.deepEqual(voucher.player_data, { user_id: USER_ID });
  assert.equal(JSON.stringify(voucher.player_data).includes(VALID_EMAIL), false);
});

test("PIN: create NÃO manda user_id (voucher não é top-up por ID)", async () => {
  await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  assert.deepEqual(db.createCalls[0], { count_order: 1, product_code: "FFBV100-S22-br" });
  assert.equal("user_id" in db.createCalls[0], false);
});

test("sem FX configurado o resgate acontece e só os custos derivados ficam nulos", async () => {
  const usd = process.env.FX_USD_IDR;
  delete process.env.FX_USD_IDR;
  try {
    const { body } = await redeemDtu();
    assert.equal(body.status, "processing");
    assert.equal(db.attempts[0].cost_idr, 14969);
    assert.equal(db.attempts[0].cost_usd, null);
  } finally {
    process.env.FX_USD_IDR = usd;
  }
});

/* ==================== anti-duplicação (o item crítico) ============== */

test("duplo submit do mesmo código: exatamente UM create, o segundo recebe processing", async () => {
  const primeiro = await redeemDtu();
  const segundo = await redeemDtu();

  assert.equal(primeiro.body.status, "processing");
  assert.equal(primeiro.body.attempt_ref, `${CODE}-a1`);

  // O segundo perde o claim: sem attempt_ref, sem order, sem cobrança.
  assert.equal(segundo.body.status, "processing");
  assert.equal(segundo.body.attempt_ref, undefined);

  assert.equal(db.createCalls.length, 1, "saiu mais de uma order — resgate duplicado");
  assert.equal(db.attempts.length, 1);
});

test("voucher já em PROCESSING não gera create nem em request nova", async () => {
  voucherByCode(CODE).status = "PROCESSING";
  const { body } = await redeemDtu();
  assert.equal(body.status, "processing");
  assert.equal(db.createCalls.length, 0);
});

test("nunca há retry automático de create: uma request, uma chamada", async () => {
  db.createResponse = new Error("boom"); // erro de rede
  await redeemDtu();
  assert.equal(db.createCalls.length, 1);
});

/* ========================= caminhos de erro ========================= */

test("erro DEFINITIVO da Lapak devolve o voucher pra EMITIDO", async () => {
  db.createResponse = {
    status: 200,
    ok: true,
    data: { code: "PRODUCT_NOT_FOUND", data: {} },
  };

  const { body } = await redeemDtu();

  assert.equal(body.status, "failed");
  assert.match(body.message, /continua válido/i);
  assert.equal(voucherByCode(CODE).status, "EMITIDO", "voucher deveria voltar a valer");
  assert.equal(db.attempts[0].result, "error");
  assert.equal(db.attempts[0].error_code, "lapak_product_not_found");
});

test("depois de falhar, o portador consegue resgatar outro conteúdo", async () => {
  db.createResponse = { status: 200, ok: true, data: { code: "OUT_OF_STOCK", data: {} } };
  await redeemDtu();
  assert.equal(voucherByCode(CODE).status, "EMITIDO");

  // Segunda tentativa, agora no conteúdo PIN, com a Lapak respondendo bem.
  resetLapakOk();
  const { body } = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  assert.equal(body.status, "processing");
  assert.equal(body.attempt_ref, `${CODE}-a2`, "attempt_number precisa avançar");
  assert.equal(voucherByCode(CODE).status, "PROCESSING");
});

test("timeout no create é AMBÍGUO: voucher fica PROCESSING, nunca volta pra EMITIDO", async () => {
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  db.createResponse = timeout;

  const { body } = await redeemDtu();

  // Sem tid não dá pra saber se a order saiu. Devolver o voucher aqui
  // seria arriscar entregar e cobrar duas vezes.
  assert.equal(body.status, "processing");
  assert.equal(voucherByCode(CODE).status, "PROCESSING");
  assert.equal(db.attempts[0].result, "pending", "attempt não pode virar 'error'");
  assert.equal(db.attempts[0].error_code, "proxy_timeout");
  assert.ok(db.logs.some((l) => l.includes("AMBIGUOUS")));
});

test("proxy 401 (chave errada) é definitivo: nada saiu, voucher volta", async () => {
  db.createResponse = { __http: 401 };
  const { body } = await redeemDtu();
  assert.equal(body.status, "failed");
  assert.equal(voucherByCode(CODE).status, "EMITIDO");
});

test("proxy 500 é ambíguo: a order pode ter saído, voucher fica travado", async () => {
  db.createResponse = { __http: 500 };
  const { body } = await redeemDtu();
  assert.equal(body.status, "processing");
  assert.equal(voucherByCode(CODE).status, "PROCESSING");
});

test("SKU trocado (voucher cadastrado como DTU) é recusado ANTES do claim", async () => {
  const { body } = await callRedeem({
    code: CODE,
    content_id: CONTENT_TROCADO,
    player_data: okPlayer(),
  });
  assert.equal(body.status, "invalid_or_unavailable");
  assert.equal(voucherByCode(CODE).status, "EMITIDO", "voucher não pode ser consumido");
  assert.equal(db.createCalls.length, 0);
  assert.ok(db.logs.some((l) => l.includes("sku_delivery_mismatch") && l.includes("esperado=PIN")));
});

/* ============================ /api/status ========================== */

function resetLapakOk() {
  db.createResponse = {
    status: 200,
    ok: true,
    data: { code: "SUCCESS", data: { tid: "RA-TESTE-1", total_price: 14969 } },
  };
}

function lapakStatus(statusValue, voucherCode) {
  db.statusResponse = {
    status: 200,
    ok: true,
    data: {
      code: "SUCCESS",
      data: {
        status: statusValue,
        tid: "RA-TESTE-1",
        transactions: [{ id: "1", voucher_code: voucherCode ?? "" }],
      },
    },
  };
}

test("PIN: SUCCESS entrega o código na tela, fecha o voucher em USADO e nunca loga o PIN", async () => {
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  assert.equal(body.status, "success");
  assert.equal(body.delivery_type, "PIN");
  assert.equal(body.pin, PIN_REAL);
  assert.equal(body.serial, SERIAL_REAL);

  const voucher = voucherByCode(CODE);
  assert.equal(voucher.status, "USADO");
  assert.equal(voucher.order_ref, "RA-TESTE-1");
  assert.equal(voucher.redeemed_product_code, "FFBV100-S22-br");
  assert.ok(voucher.redeemed_at);

  const attempt = db.attempts[0];
  assert.equal(attempt.result, "success");
  assert.equal(attempt.pin_delivered, true);

  // O PIN não pode aparecer em log NENHUM, nem parcialmente.
  const joined = db.logs.join("\n");
  assert.ok(!joined.includes(PIN_REAL), "PIN vazou pro log");
  assert.ok(!joined.includes(SERIAL_REAL), "serial vazou pro log");
});

test("DTU: SUCCESS fecha sem PIN nenhum na resposta", async () => {
  const started = await redeemDtu();
  lapakStatus("SUCCESS", ""); // DTU vem com voucher_code vazio (A0)

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "success");
  assert.equal(body.delivery_type, "DTU");
  assert.equal(body.pin, undefined);
  assert.equal(voucherByCode(CODE).status, "USADO");
});

test("PENDING mantém tudo como está — nada fecha e nada é devolvido", async () => {
  const started = await redeemDtu();
  lapakStatus("PENDING", "");

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "processing");
  assert.equal(voucherByCode(CODE).status, "PROCESSING");
  assert.equal(db.attempts[0].result, "pending");
});

test("REFUNDED devolve o voucher pro portador", async () => {
  const started = await redeemDtu();
  lapakStatus("REFUNDED", "");

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "failed");
  assert.equal(voucherByCode(CODE).status, "EMITIDO");
  assert.equal(db.attempts[0].result, "error");
  assert.equal(db.attempts[0].error_code, "lapak_refunded");
});

test("status DESCONHECIDO da Lapak não libera o voucher", async () => {
  const started = await redeemDtu();
  lapakStatus("SOMETHING_NEW", "");

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  // A order pode estar viva: liberar aqui permitiria um segundo resgate.
  assert.equal(body.status, "processing");
  assert.equal(voucherByCode(CODE).status, "PROCESSING");
  assert.ok(db.logs.some((l) => l.includes("status desconhecido")));
});

test("throttle de 3s: consultas seguidas não viram chamadas à Lapak", async () => {
  const started = await redeemDtu();
  lapakStatus("PENDING", "");

  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(db.statusCalls.length, 1);

  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(db.statusCalls.length, 1, "throttle de 3s não segurou");

  // Passados os 3s, volta a consultar.
  db.attempts[0].last_polled_at = new Date(Date.now() - 4000).toISOString();
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(db.statusCalls.length, 2);
});

test("PIN é reexibível dentro da janela de 24h, rebuscando na Lapak", async () => {
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  // Segunda consulta, com o resgate já concluído.
  db.attempts[0].last_polled_at = new Date(Date.now() - 5000).toISOString();
  const again = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(again.body.status, "success");
  assert.equal(again.body.pin, PIN_REAL);
});

test("reexibição barrada pelo throttle responde processing, não sucesso vazio", async () => {
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  // Consulta imediata: o throttle de 3s ainda vale. Dizer "concluído" sem o
  // PIN aqui mostraria a tela de sucesso vazia por razão temporária.
  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "processing");
});

test("SUCCESS sem PIN parseável avisa o portador em vez de mostrar tela vazia", async () => {
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  // A Lapak confirma a entrega mas manda voucher_code vazio num SKU de PIN.
  lapakStatus("SUCCESS", "");

  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "success");
  assert.equal(body.pin, undefined);
  assert.equal(body.pin_unavailable, true);
  assert.match(body.message, /suporte/i);
  // O resgate está pago e feito: o voucher fecha mesmo assim.
  assert.equal(voucherByCode(CODE).status, "USADO");
  assert.ok(db.logs.some((l) => l.includes("SUCCESS sem PIN parseável")));
});

test("passadas 24h o PIN não é mais exibido", async () => {
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL },
  });
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  db.attempts[0].resolved_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const { body } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
  assert.equal(body.status, "success");
  assert.equal(body.pin, undefined);
  assert.equal(body.pin_expired, true);
});

test("attempt_ref de outro voucher devolve a genérica", async () => {
  const started = await redeemDtu();
  const outro = await callStatus({ code: "RLBK-OUTROCODE1", attempt_ref: started.body.attempt_ref });
  assert.deepEqual(outro.body, { status: "invalid_or_unavailable" });

  const inventado = await callStatus({ code: CODE, attempt_ref: `${CODE}-a99` });
  assert.deepEqual(inventado.body, { status: "invalid_or_unavailable" });
});

test("attempt_ref malformado não vira consulta ao banco", async () => {
  const antes = db.calls.length;
  const { body } = await callStatus({ code: CODE, attempt_ref: `${CODE}-XX` });
  assert.deepEqual(body, { status: "invalid_or_unavailable" });
  assert.ok(!db.calls.slice(antes).some((c) => c.includes("pv_redeem_attempts")));
});

test("o polling não estoura o balde de 10 do validate/redeem", async () => {
  const started = await redeemDtu();
  lapakStatus("PENDING", "");

  // 40 consultas seguidas — o dobro do que uma tela de 1 minuto gera.
  for (let i = 0; i < 40; i++) {
    const { res } = await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });
    assert.equal(res.status, 200, `consulta ${i + 1} foi barrada`);
  }
});

test("nem PII nem attempt_ref (que contém o código) aparecem nos logs", async () => {
  const started = await redeemDtu();
  lapakStatus("SUCCESS", "");
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  const joined = db.logs.join("\n");
  assert.ok(joined.length > 0);
  assert.ok(!joined.includes(VALID_EMAIL), "email no log");
  assert.ok(!joined.includes(VALID_CPF_DIGITS), "CPF no log");
  assert.ok(!joined.includes(USER_ID), "user_id no log");
  assert.ok(!joined.includes("203.0.113.7"), "IP cru no log");
  assert.ok(!joined.includes(CODE), "código completo no log");
  assert.ok(!joined.includes(`${CODE}-a1`), "attempt_ref no log");
  assert.ok(joined.includes("RLBK…#"), "faltou o rótulo mascarado");
});

/* ========================== reconciliação ========================== */

test("decisão: tentativa recente espera, tentativa velha com tid vai pro polling", () => {
  const nowMs = Date.now();
  const recente = {
    attempts: [{ attempt_number: 1, created_at: new Date(nowMs - 30000).toISOString(), lapak_tid: "x" }],
  };
  assert.equal(reconcileDecision(recente, nowMs).action, "wait");

  const velha = {
    attempts: [{ attempt_number: 1, created_at: new Date(nowMs - 600000).toISOString(), lapak_tid: "x" }],
  };
  assert.equal(reconcileDecision(velha, nowMs).action, "poll");
});

test("decisão: PROCESSING sem attempt nenhum é liberado (nada foi pedido)", () => {
  assert.equal(reconcileDecision({ attempts: [] }, Date.now()).action, "release");
});

test("decisão: pendente sem tid vira caso MANUAL, nunca release automático", () => {
  const nowMs = Date.now();
  const ambiguo = {
    attempts: [
      {
        attempt_number: 1,
        created_at: new Date(nowMs - 600000).toISOString(),
        lapak_tid: null,
        result: "pending",
      },
    ],
  };
  const decision = reconcileDecision(ambiguo, nowMs);
  assert.equal(decision.action, "manual");
  assert.notEqual(decision.action, "release");
});

test("decisão: erro definitivo já registrado sem tid pode ser liberado", () => {
  const nowMs = Date.now();
  const errado = {
    attempts: [
      {
        attempt_number: 1,
        created_at: new Date(nowMs - 600000).toISOString(),
        lapak_tid: null,
        result: "error",
      },
    ],
  };
  assert.equal(reconcileDecision(errado, nowMs).action, "release");
});

test("job resolve o abandono de tela: SUCCESS vira USADO sem ninguém olhando", async () => {
  const started = await redeemDtu();
  // A tentativa envelhece além do teto de 5 min.
  db.attempts[0].created_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  lapakStatus("SUCCESS", "");

  await reconcile();

  assert.equal(voucherByCode(CODE).status, "USADO");
  assert.equal(db.attempts[0].result, "success");
  // O PIN não foi exibido a ninguém: o portador ainda pode buscá-lo.
  assert.equal(db.attempts[0].pin_delivered, false);
  assert.ok(started.body.attempt_ref);
});

test("job devolve o voucher quando a Lapak reembolsou", async () => {
  await redeemDtu();
  db.attempts[0].created_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  lapakStatus("REFUNDED", "");

  await reconcile();

  assert.equal(voucherByCode(CODE).status, "EMITIDO");
  assert.equal(db.attempts[0].result, "error");
});

test("job NUNCA cria order — nem pra tentar de novo", async () => {
  await redeemDtu();
  db.attempts[0].created_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  db.createCalls = [];
  lapakStatus("PENDING", "");

  await reconcile();

  assert.equal(db.createCalls.length, 0);
});

test("job deixa o caso ambíguo em PROCESSING e grita no log", async () => {
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  db.createResponse = timeout;
  await redeemDtu();
  db.attempts[0].created_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  db.logs = [];

  await reconcile();

  assert.equal(voucherByCode(CODE).status, "PROCESSING");
  assert.ok(db.logs.some((l) => l.includes("conferência manual")));
});

/* ===================== parsing e conversão (puros) ================== */

test("parseVoucherCode entende o formato do A0 e os desvios plausíveis", () => {
  assert.deepEqual(parseVoucherCode(VOUCHER_CODE_STRING), {
    pin: PIN_REAL,
    serial: SERIAL_REAL,
  });

  // Espaçamento diferente e ordem trocada continuam funcionando.
  assert.deepEqual(parseVoucherCode(`Serial :  ${SERIAL_REAL}\tPIN:${PIN_REAL}`), {
    pin: PIN_REAL,
    serial: SERIAL_REAL,
  });

  // Só o PIN, sem serial.
  assert.deepEqual(parseVoucherCode(`PIN : ${PIN_REAL}`), { pin: PIN_REAL, serial: null });

  // String nua vira o PIN inteiro.
  assert.deepEqual(parseVoucherCode(PIN_REAL), { pin: PIN_REAL, serial: null });

  // DTU e lixo não viram PIN falso.
  assert.equal(parseVoucherCode(""), null);
  assert.equal(parseVoucherCode(null), null);
});

test("convertCost sem cotação devolve nulos em vez de número inventado", () => {
  const semFx = convertCost(14969, { fxUsdIdr: null, fxBrlUsd: null });
  assert.equal(semFx.cost_usd, null);
  assert.equal(semFx.cost_brl, null);

  const comFx = convertCost(16200, { fxUsdIdr: 16200, fxBrlUsd: 5 });
  assert.equal(comFx.cost_usd, 1);
  assert.equal(comFx.cost_brl, 5);
});

/* ============ requires_ip: o IP do portador no create (Brief 6) ===== */

test("requires_ip=true põe end_user_ip_address no create; sem a flag, o campo nem existe", async () => {
  // Free Fire (requires_ip false no seed): nada de IP no corpo.
  await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  assert.deepEqual(db.createCalls[0], { count_order: 1, product_code: "FFBV100-S22-br" });
  assert.equal("end_user_ip_address" in db.createCalls[0], false);

  // Mesmo código, mesmo caminho, só a linha do catálogo muda.
  resetDb();
  db.skuMap = skuMapRows([HOYO_PIN_ROW]);
  await callRedeem({
    code: CODE,
    content_id: CONTENT_HOYO,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  assert.deepEqual(db.createCalls[0], {
    count_order: 1,
    product_code: "HOYOPIN60-mx",
    end_user_ip_address: "203.0.113.7",
  });
});

test("o IP mandado pro fornecedor não aparece em log nem em coluna nossa", async () => {
  db.skuMap = skuMapRows([HOYO_PIN_ROW]);
  const started = await callRedeem({
    code: CODE,
    content_id: CONTENT_HOYO,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);
  await callStatus({ code: CODE, attempt_ref: started.body.attempt_ref });

  // "usar e descartar": o IP existe no corpo da request ao fornecedor e em
  // lugar nenhum mais.
  const joined = db.logs.join("\n");
  assert.ok(!joined.includes("203.0.113.7"), "IP cru no log");
  // O log DIZ que o IP foi enviado — booleano, nunca o valor.
  assert.ok(joined.includes('"requires_ip":true'), "faltou a marca de auditoria no log");

  const persisted = JSON.stringify(db.attempts);
  assert.ok(!persisted.includes("203.0.113.7"), "IP cru gravado no attempt");
  assert.ok(db.attempts[0].ip_hash, "o ip_hash continua sendo gravado");
  assert.notEqual(db.attempts[0].ip_hash, "203.0.113.7");
});

test("requires_ip não vaza entre SKUs do mesmo lote", async () => {
  // Um lote com um SKU marcado não pode fazer os outros mandarem IP.
  db.skuMap = skuMapRows([HOYO_PIN_ROW]);
  await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  assert.equal("end_user_ip_address" in db.createCalls[0], false);
});

/* ====== regressão: os dois fluxos Free Fire com o catálogo em tabela ==== */

test("regressão FF: DTU segue mandando user_id e PIN segue entregando o código", async () => {
  // O critério de pronto do brief: nada do Brief 3 mudou de comportamento
  // com a troca do forms-map.json pela tabela.
  const dtu = await redeemDtu();
  assert.equal(dtu.body.status, "processing");
  assert.deepEqual(db.createCalls[0], {
    count_order: 1,
    product_code: "FF100_10-S116-br",
    user_id: USER_ID,
  });

  resetDb();
  const pin = await callRedeem({
    code: CODE,
    content_id: CONTENT_PIN,
    player_data: { email: VALID_EMAIL, marketing_optin: false },
  });
  assert.equal(pin.body.status, "processing");
  lapakStatus("SUCCESS", VOUCHER_CODE_STRING);
  const done = await callStatus({ code: CODE, attempt_ref: pin.body.attempt_ref });
  assert.equal(done.body.status, "success");
  assert.equal(done.body.delivery_type, "PIN");
  assert.equal(done.body.pin, PIN_REAL);
});

test("SKU trocado continua recusado pela tabela (§8.2 do Brief 2, agora via banco)", async () => {
  const { body } = await callRedeem({
    code: CODE,
    content_id: CONTENT_TROCADO,
    player_data: okPlayer(),
  });
  assert.equal(body.status, "invalid_or_unavailable");
  assert.equal(db.createCalls.length, 0);
  assert.equal(voucherByCode(CODE).status, "EMITIDO", "o voucher foi consumido à toa");
  assert.ok(db.logs.join("\n").includes("sku_delivery_mismatch"));
});
