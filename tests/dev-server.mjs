/* =====================================================================
   Harness LOCAL de desenvolvimento — NÃO vai pro ar, não é function.
   Sobe em http://localhost:8000:
     - serve public/ (o front real)
     - roteia /api/validate, /api/redeem e /api/status pras FUNCTIONS REAIS
     - com o fetch global stubado: Supabase falso e Lapak FALSA. Nenhuma
       order é criada, nenhum centavo é gasto, nada toca produção.

   É o que permite validar/screenshotar as telas (inclusive a de entrega
   em andamento e a do PIN) sem lote real, sem secret de verdade e sem
   deploy.

   Rodar:  node tests/dev-server.mjs
   Códigos de teste: ver TEST_CODES abaixo. GET /dev/reset zera tudo.
   ===================================================================== */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL = "https://stub.local";
process.env.SUPABASE_SECRET_KEY = "sb_secret_STUB_LOCAL";
process.env.IP_HASH_SALT = "salt-local-de-dev";
process.env.CONTEXT = "dev";
process.env.NETLIFY_DEV = "true";
// Config do redeemer: valores FALSOS. O proxy nunca é chamado de verdade
// daqui — o fetch global intercepta antes.
process.env.PROXY_RELOAD_KEY = "proxy-key-STUB-LOCAL";
process.env.LAPAK_ENV = "dev";
process.env.FX_USD_IDR = "16200";
process.env.FX_BRL_USD = "5.4";

const PORT = 8000;
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));

// Quantas consultas o "fornecedor" fica em PENDING antes de resolver.
// Dá pra ver a tela de entrega em andamento por ~6 segundos.
const PENDING_POLLS = 2;

const FAKE_PIN = "4077000011112222";
const FAKE_SERIAL = "791000111";

const future = new Date(Date.now() + 30 * 86400000).toISOString();
const past = new Date(Date.now() - 2 * 86400000).toISOString();

const contents = () => [
  {
    id: "11111111-1111-4111-8111-111111111111",
    display_label: "110 Diamantes Free Fire (100 + 10 bônus)",
    delivery_type: "DTU",
    product_code: "FF100_10-S116-br",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    display_label: "Cartão Free Fire 100 Diamantes",
    delivery_type: "PIN",
    product_code: "FFBV100-S22-br",
  },
];

// SKU DTU de jogo que ainda não está no forms-map.json — deve ser RECUSADO
// (não aparece na lista), nunca cair em formulário genérico.
const unmappedContent = () => ({
  id: "44444444-4444-4444-8444-444444444444",
  display_label: "50 Diamantes Mobile Legends",
  delivery_type: "DTU",
  product_code: "MLBB50-S9-br",
});

// SKU de VOUCHER cadastrado como DTU — o erro do Brief 2 §8.2. A trava
// SKU × delivery_type tem que recusar isto antes de qualquer order.
const mismatchContent = () => ({
  id: "55555555-5555-4555-8555-555555555555",
  display_label: "Cartão cadastrado como DTU (erro proposital)",
  delivery_type: "DTU",
  product_code: "FFBV100-S22-br",
});

// SKUs que fazem a Lapak falsa se comportar mal, pra exercitar os
// caminhos de erro do front sem precisar de fornecedor nenhum.
const errorContent = () => ({
  id: "66666666-6666-4666-8666-666666666666",
  display_label: "Falha proposital do fornecedor",
  delivery_type: "DTU",
  product_code: "FFERRO-S1-br",
});
const timeoutContent = () => ({
  id: "77777777-7777-4777-8777-777777777777",
  display_label: "Timeout proposital do fornecedor",
  delivery_type: "DTU",
  product_code: "FFTIMEOUT-S1-br",
});

const batch = (over = {}) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Lote Piloto Reload Bak",
  status: "active",
  expires_at: future,
  contents: contents(),
  ...over,
});

const CODE_SPECS = {
  "RLBK-VALIDO0001": { status: "EMITIDO", batch: batch() },
  "RLBK-USADO00001": { status: "USADO", batch: batch() },
  "RLBK-CANCEL0001": { status: "CANCELADO", batch: batch() },
  "RLBK-PROCESS001": { status: "PROCESSING", batch: batch() },
  "RLBK-VENCIDO001": { status: "EMITIDO", batch: batch({ expires_at: past }) },
  "RLBK-SODTU00001": { status: "EMITIDO", batch: batch({ contents: [contents()[0]] }) },
  "RLBK-SOPIN00001": { status: "EMITIDO", batch: batch({ contents: [contents()[1]] }) },
  "RLBK-SKUNOVO001": {
    status: "EMITIDO",
    batch: batch({ contents: [contents()[0], unmappedContent()] }),
  },
  "RLBK-SOSKUNOVO1": { status: "EMITIDO", batch: batch({ contents: [unmappedContent()] }) },
  "RLBK-SKUTROCAD1": { status: "EMITIDO", batch: batch({ contents: [mismatchContent()] }) },
  "RLBK-ERROLAPAK1": {
    status: "EMITIDO",
    batch: batch({ contents: [errorContent(), contents()[1]] }),
  },
  "RLBK-TIMEOUT001": { status: "EMITIDO", batch: batch({ contents: [timeoutContent()] }) },
};

export const TEST_CODES = CODE_SPECS;

/* --------------------- mini-banco em memória ----------------------- */

const store = { vouchers: [], attempts: [], rate: new Map(), polls: new Map() };

function resetStore() {
  store.vouchers = Object.entries(CODE_SPECS).map(([code, spec], i) => ({
    id: `v${i + 1}`,
    code,
    status: spec.status,
    redeemed_at: null,
    order_ref: null,
    redeemed_product_code: null,
    player_data: null,
    batch: spec.batch,
  }));
  store.attempts = [];
  store.rate.clear();
  store.polls.clear();
}
resetStore();

const jsonRes = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const eqParam = (query, field) => {
  const match = query.match(new RegExp(`${field}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
};

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  const query = target.split("?")[1] || "";

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    const key = `${body.p_ip_hash}|${body.p_window_start}`;
    const next = (store.rate.get(key) || 0) + 1;
    store.rate.set(key, next);
    console.log(`  [stub] rate hit → ${next}`);
    return jsonRes(next);
  }

  if (target.includes("/rpc/pv_redeem_claim")) {
    const voucher = store.vouchers.find((v) => v.code === body.p_code);
    const ok =
      voucher &&
      voucher.status === "EMITIDO" &&
      voucher.batch.status === "active" &&
      Date.parse(voucher.batch.expires_at) > Date.now();
    console.log(`  [stub] claim ${body.p_code} → ${ok ? "CONCEDIDO" : "negado"}`);
    if (!ok) return jsonRes([]);
    voucher.status = "PROCESSING";
    const n = store.attempts.filter((a) => a.voucher_id === voucher.id).length + 1;
    return jsonRes([{ voucher_id: voucher.id, attempt_number: n }]);
  }

  if (target.includes("/rest/v1/pv_redeem_attempts")) {
    if (method === "POST") {
      const row = {
        id: `a${store.attempts.length + 1}`,
        created_at: new Date().toISOString(),
        pin_delivered: false,
        ...body,
      };
      store.attempts.push(row);
      return jsonRes([row]);
    }
    if (method === "PATCH") {
      const id = eqParam(query, "id");
      const rows = store.attempts.filter((a) => a.id === id);
      for (const row of rows) Object.assign(row, body);
      return jsonRes(rows);
    }
    const ref = eqParam(query, "attempt_ref");
    const attempt = store.attempts.find((a) => a.attempt_ref === ref);
    if (!attempt) return jsonRes([]);
    const voucher = store.vouchers.find((v) => v.id === attempt.voucher_id);
    return jsonRes([{ ...attempt, voucher }]);
  }

  if (target.includes("/rest/v1/pv_vouchers")) {
    if (method === "PATCH") {
      const id = eqParam(query, "id");
      const required = eqParam(query, "status");
      const rows = store.vouchers.filter(
        (v) => v.id === id && (required === null || v.status === required)
      );
      for (const row of rows) Object.assign(row, body);
      if (rows.length) console.log(`  [stub] voucher ${rows[0].code} → ${rows[0].status}`);
      return jsonRes(rows);
    }
    const status = eqParam(query, "status");
    if (status) {
      return jsonRes(
        store.vouchers
          .filter((v) => v.status === status)
          .map((v) => ({
            id: v.id,
            code: v.code,
            status: v.status,
            attempts: store.attempts.filter((a) => a.voucher_id === v.id),
          }))
      );
    }
    const code = eqParam(query, "code");
    const voucher = store.vouchers.find((v) => v.code === code);
    console.log(`  [stub] lookup ${code} → ${voucher ? voucher.status : "não existe"}`);
    return jsonRes(voucher ? [voucher] : []);
  }

  /* ---------------------- Lapak FALSA ---------------------- */

  if (target.includes("/api/order_status")) {
    const tid = new URLSearchParams(query).get("tid");
    const seen = (store.polls.get(tid) || 0) + 1;
    store.polls.set(tid, seen);
    const isPin = String(tid).includes("PIN");
    const done = seen > PENDING_POLLS;
    console.log(`  [stub] order_status ${tid} #${seen} → ${done ? "SUCCESS" : "PENDING"}`);
    return jsonRes({
      status: 200,
      ok: true,
      data: {
        code: "SUCCESS",
        data: {
          status: done ? "SUCCESS" : "PENDING",
          tid,
          transactions: [
            {
              id: "1",
              voucher_code: done && isPin ? `PIN : ${FAKE_PIN}\tSerial : ${FAKE_SERIAL}` : "",
            },
          ],
        },
      },
    });
  }

  if (target.includes("/api/order")) {
    const sku = body.product_code || "";
    console.log(`  [stub] create order sku=${sku}`);
    if (sku.startsWith("FFERRO")) {
      return jsonRes({ status: 200, ok: true, data: { code: "PRODUCT_NOT_FOUND", data: {} } });
    }
    if (sku.startsWith("FFTIMEOUT")) {
      const err = new Error("simulated timeout");
      err.name = "TimeoutError";
      throw err;
    }
    // tid carrega "PIN" quando o SKU é de voucher: é assim que a Lapak
    // falsa sabe se deve devolver PIN no order_status.
    const tid = `RA-DEV-${sku.startsWith("FFBV") ? "PIN" : "DTU"}-${Date.now()}`;
    return jsonRes({
      status: 200,
      ok: true,
      data: { code: "SUCCESS", data: { tid, product_name: "stub", total_price: 14969 } },
    });
  }

  throw new Error(`fetch inesperado: ${target}`);
};

const { default: validate } = await import("../netlify/functions/validate.mjs");
const { default: redeem } = await import("../netlify/functions/redeem.mjs");
const { default: status } = await import("../netlify/functions/status.mjs");
const { default: reconcile } = await import("../netlify/functions/reconcile.mjs");

const HANDLERS = {
  "/api/validate": validate,
  "/api/redeem": redeem,
  "/api/status": status,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/dev/reset") {
    resetStore();
    res.writeHead(200, { "Content-Type": "text/plain" }).end("estado zerado");
    return;
  }

  // Dispara a reconciliação à mão, sem esperar 15 min.
  if (url.pathname === "/dev/reconcile") {
    const out = await reconcile();
    res.writeHead(200, { "Content-Type": "application/json" }).end(await out.text());
    return;
  }

  const handler = HANDLERS[url.pathname];
  if (handler) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost:${PORT}${url.pathname}`, {
      method: req.method,
      headers: { ...req.headers, "x-nf-client-connection-ip": "127.0.0.1" },
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    });
    const out = await handler(request, { ip: "127.0.0.1" });
    const body = await out.text();
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(body);
    console.log(`${req.method} ${url.pathname} → ${out.status} ${body.slice(0, 120)}`);
    return;
  }

  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^([/\\.]+)/, "");
  try {
    const file = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      "Content-Type": MIME[extname(rel)] || "application/octet-stream",
      "Cache-Control": "no-store",
    }).end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404");
  }
}).listen(PORT, () => {
  console.log(`Harness local em http://localhost:${PORT}`);
  console.log(`Códigos de teste: ${Object.keys(CODE_SPECS).join(", ")}`);
  console.log(`Rotas de dev: /dev/reset (zera) · /dev/reconcile (roda o job)`);
});
