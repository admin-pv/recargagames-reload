/* =====================================================================
   Harness LOCAL de desenvolvimento — NÃO vai pro ar, não é function.
   Sobe em http://localhost:8000:
     - serve public/ (o front real)
     - roteia /api/validate e /api/redeem pras FUNCTIONS REAIS
     - com o fetch global stubado: Supabase é falso, nada toca produção

   É o que permite validar/screenshotar as 4 telas sem lote real, sem
   secret de verdade e sem deploy.

   Rodar:  node tests/dev-server.mjs
   Códigos de teste: ver TEST_CODES abaixo. GET /dev/reset zera o rate limit.
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

const PORT = 8000;
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));

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

const batch = (over = {}) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Lote Piloto Reload Bak",
  status: "active",
  expires_at: future,
  contents: contents(),
  ...over,
});

export const TEST_CODES = {
  "RLBK-VALIDO0001": { id: "v1", status: "EMITIDO", batch: batch() },
  "RLBK-USADO00001": { id: "v2", status: "USADO", batch: batch() },
  "RLBK-CANCEL0001": { id: "v3", status: "CANCELADO", batch: batch() },
  "RLBK-PROCESS001": { id: "v4", status: "PROCESSING", batch: batch() },
  "RLBK-VENCIDO001": { id: "v5", status: "EMITIDO", batch: batch({ expires_at: past }) },
  "RLBK-SODTU00001": {
    id: "v6",
    status: "EMITIDO",
    batch: batch({ contents: [contents()[0]] }),
  },
  "RLBK-SOPIN00001": {
    id: "v7",
    status: "EMITIDO",
    batch: batch({ contents: [contents()[1]] }),
  },
};

const rate = new Map();

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const jsonRes = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  if (target.includes("/rpc/pv_validate_rate_hit")) {
    const { p_ip_hash, p_window_start } = JSON.parse(init.body);
    const key = `${p_ip_hash}|${p_window_start}`;
    const next = (rate.get(key) || 0) + 1;
    rate.set(key, next);
    console.log(`  [stub] rate hit → ${next}`);
    return jsonRes(next);
  }
  if (target.includes("/rest/v1/pv_vouchers")) {
    const match = target.match(/code=eq\.([^&]+)/);
    const code = decodeURIComponent(match ? match[1] : "");
    const voucher = TEST_CODES[code];
    console.log(`  [stub] lookup ${code} → ${voucher ? voucher.status : "não existe"}`);
    return jsonRes(voucher ? [voucher] : []);
  }
  throw new Error(`fetch inesperado: ${target}`);
};

const { default: validate } = await import("../netlify/functions/validate.mjs");
const { default: redeem } = await import("../netlify/functions/redeem.mjs");

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
    rate.clear();
    res.writeHead(200, { "Content-Type": "text/plain" }).end("rate limit zerado");
    return;
  }

  if (url.pathname === "/api/validate" || url.pathname === "/api/redeem") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const handler = url.pathname === "/api/validate" ? validate : redeem;
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
  console.log(`Códigos de teste: ${Object.keys(TEST_CODES).join(", ")}`);
});
