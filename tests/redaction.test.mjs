/* =====================================================================
   Redação das mensagens de erro do Supabase.

   Por que este arquivo existe: a mensagem de um UpstreamError vai pra
   console.error, e ela era montada com o PATH cru (que filtra por valor:
   `code=eq.<CÓDIGO COMPLETO>`) e com o CORPO de erro do PostgREST cru
   (que em violação de constraint traz `Failing row contains (...)` — a
   linha inteira, com email, CPF e ip_hash).

   Nenhum desses caminhos aparece num resgate que dá certo, e é por isso
   que inspecionar log de produção não os pegou. Só auditoria de código
   pegou — e este teste é o que impede a volta.

   Rodar:  npm test
   ===================================================================== */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_STUB_NAO_REAL";
process.env.IP_HASH_SALT = "salt-de-teste-nao-real";
process.env.PROXY_RELOAD_KEY = "proxy-key-STUB-NAO-REAL";
process.env.LAPAK_ENV = "dev";

const ORIGIN = "https://reload.recargagames.com";
const CODE = "RLBK-VALIDO0001";
const CONTENT_DTU = "11111111-1111-4111-8111-111111111111";

const EMAIL = "jogador@email.com";
const CPF = "11144477735";
const USER_ID = "13846816197";

// Corpo de erro REAL do PostgREST quando uma constraint estoura num
// INSERT: o Postgres devolve a linha que falhou, por inteiro. É o pior
// caso, e é o que este teste força.
const POSTGREST_FAILING_ROW = JSON.stringify({
  code: "23514",
  details: `Failing row contains (a1, v1, 1, FF100_10-S116-br, ${CODE}-a1, null, pending, ` +
    `null, ${EMAIL}, ${CPF}, true, 9f2b..., null, null, null, null, null, false, null).`,
  hint: null,
  message: 'new row for relation "pv_redeem_attempts" violates check constraint',
});

const db = { logs: [], failOn: null, rate: 0 };

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const future = new Date(Date.now() + 30 * 86400000).toISOString();

const voucher = () => ({
  id: "v1",
  status: "EMITIDO",
  batch: {
    id: "b1",
    name: "Lote Teste",
    status: "active",
    expires_at: future,
    contents: [
      {
        id: CONTENT_DTU,
        display_label: "110 Diamantes Free Fire",
        delivery_type: "DTU",
        product_code: "FF100_10-S116-br",
      },
    ],
  },
});

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method || "GET";

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    db.rate += 1;
    return jsonResponse(db.rate);
  }

  // Ponto de falha programável: devolve o erro do PostgREST com a linha
  // inteira, do jeito que o banco real devolveria.
  if (db.failOn && target.includes(db.failOn)) {
    return new Response(POSTGREST_FAILING_ROW, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (target.includes("/rpc/pv_redeem_claim")) {
    return jsonResponse([{ voucher_id: "v1", attempt_number: 1 }]);
  }
  if (target.includes("/rest/v1/pv_redeem_attempts")) {
    return jsonResponse([{ id: "a1", pin_delivered: false }]);
  }
  if (target.includes("/rest/v1/pv_vouchers") && method !== "GET") {
    return jsonResponse([{ id: "v1" }]);
  }
  if (target.includes("/rest/v1/pv_vouchers")) {
    return jsonResponse([voucher()]);
  }
  if (target.includes("/api/order")) {
    return jsonResponse({
      status: 200,
      ok: true,
      data: { code: "SUCCESS", data: { tid: "RA-STUB-1", total_price: 14969 } },
    });
  }
  throw new Error(`fetch inesperado: ${target}`);
};

for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    db.logs.push(args.map(String).join(" "));
    if (process.env.TEST_VERBOSE) original(...args);
  };
}

const { safePath, safeDetail, sbSelect, UpstreamError } = await import("../lib/supabase.mjs");
const { default: validate } = await import("../netlify/functions/validate.mjs");
const { default: redeem } = await import("../netlify/functions/redeem.mjs");

const ctx = { ip: "203.0.113.7" };
const request = (path, body) =>
  new Request(`https://reload.recargagames.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "x-nf-client-connection-ip": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  db.logs = [];
  db.failOn = null;
  db.rate = 0;
});

/* ------------------------- unidades puras -------------------------- */

test("safePath apaga o VALOR dos filtros e preserva o diagnóstico", () => {
  const redacted = safePath(
    `pv_vouchers?code=eq.${CODE}&select=id,status,batch:pv_batches(id,name)&limit=1`
  );
  assert.ok(!redacted.includes(CODE), "código sobreviveu no path");
  // O que importa pra depurar continua legível: tabela e nome do filtro.
  assert.ok(redacted.includes("pv_vouchers"));
  assert.ok(redacted.includes("code=eq."));
});

test("safePath cobre o attempt_ref, que carrega o código dentro dele", () => {
  const redacted = safePath(`pv_redeem_attempts?attempt_ref=eq.${CODE}-a1&select=id,result`);
  assert.ok(!redacted.includes(CODE));
  assert.ok(redacted.includes("attempt_ref=eq."));
});

test("safeDetail devolve só o SQLSTATE, nunca a linha que falhou", () => {
  const out = safeDetail(POSTGREST_FAILING_ROW);
  assert.equal(out, " sqlstate=23514");
  assert.ok(!out.includes(EMAIL));
  assert.ok(!out.includes(CPF));
  assert.ok(!out.includes(CODE));
});

test("safeDetail não quebra com corpo que não é JSON", () => {
  assert.equal(safeDetail("<html>502 Bad Gateway</html>"), "");
  assert.equal(safeDetail(""), "");
});

test("a mensagem do UpstreamError já nasce redigida", async () => {
  db.failOn = "pv_vouchers";
  const cfg = { url: "https://stub.supabase.co", key: "k", salt: "s" };
  await assert.rejects(
    () => sbSelect(cfg, `pv_vouchers?code=eq.${CODE}&select=id`),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.ok(!err.message.includes(CODE), "código na mensagem do erro");
      assert.ok(!err.message.includes(EMAIL), "email na mensagem do erro");
      assert.ok(!err.message.includes(CPF), "CPF na mensagem do erro");
      assert.ok(err.message.includes("400"), "perdeu o status HTTP");
      assert.ok(err.message.includes("23514"), "perdeu o SQLSTATE");
      return true;
    }
  );
});

/* --------- integração: o log das functions em caminho de erro ------- */

function assertLogsLimpos(rotulo) {
  const joined = db.logs.join("\n");
  assert.ok(joined.length > 0, `${rotulo}: deveria ter logado algo`);
  assert.ok(!joined.includes(CODE), `${rotulo}: código completo no log`);
  assert.ok(!joined.includes(`${CODE}-a1`), `${rotulo}: attempt_ref no log`);
  assert.ok(!joined.includes(EMAIL), `${rotulo}: email no log`);
  assert.ok(!joined.includes(CPF), `${rotulo}: CPF no log`);
  assert.ok(!joined.includes(USER_ID), `${rotulo}: user_id no log`);
  assert.ok(!joined.includes("Failing row"), `${rotulo}: linha do Postgres no log`);
  // O rótulo mascarado tem que continuar aparecendo — senão perdemos o
  // diagnóstico junto com o vazamento.
  assert.ok(joined.includes("RLBK…#"), `${rotulo}: faltou o código mascarado`);
}

test("validate: erro na leitura do voucher não leva o código pro log", async () => {
  db.failOn = "pv_vouchers";
  const res = await validate(request("/api/validate", { code: CODE }), ctx);
  assert.equal(res.status, 503);
  assertLogsLimpos("validate");
});

test("redeem: INSERT do attempt falhando não leva email/CPF pro log", async () => {
  // É o pior caso: a linha que o Postgres ecoa TEM os dados do portador.
  db.failOn = "pv_redeem_attempts";
  const res = await redeem(
    request("/api/redeem", {
      code: CODE,
      content_id: CONTENT_DTU,
      player_data: { user_id: USER_ID, email: EMAIL, cpf: CPF, marketing_optin: true },
    }),
    ctx
  );
  assert.equal(res.status, 503);
  assertLogsLimpos("redeem");
});

test("o cliente nunca recebe a mensagem do erro, redigida ou não", async () => {
  db.failOn = "pv_vouchers";
  const res = await validate(request("/api/validate", { code: CODE }), ctx);
  const raw = await res.text();
  assert.equal(raw, JSON.stringify({ error: "temporarily_unavailable" }));
  assert.ok(!raw.includes("sqlstate"));
  assert.ok(!raw.includes("pv_vouchers"));
});
