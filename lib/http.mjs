// Helpers de HTTP compartilhados pelas Netlify Functions.
//
// Vive FORA de netlify/functions/ de propósito: qualquer arquivo lá dentro
// corre o risco de ser interpretado como uma function pelo bundler. Aqui é
// só um módulo importado — o esbuild inlina no bundle de quem importa.

import { createHmac } from "node:crypto";

// Domínio canônico do app. Previews e branch deploys passam por
// same-origin (ver selfOrigin), então não é preciso hardcodar
// *.netlify.app nem liberar wildcard em lugar nenhum.
const CANONICAL_ORIGIN = "https://reload.recargagames.com";

const DEV_ORIGINS = [
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function isDev() {
  return process.env.NETLIFY_DEV === "true" || process.env.CONTEXT === "dev";
}

function allowedOrigins() {
  const set = new Set([CANONICAL_ORIGIN]);
  // Cinto e suspensório: se um dia essas env vars existirem no runtime,
  // entram na lista. Hoje não chegam — quem resolve preview é o same-origin.
  for (const key of ["URL", "DEPLOY_PRIME_URL", "DEPLOY_URL"]) {
    const value = process.env[key];
    if (value) set.add(value.trim().replace(/\/+$/, ""));
  }
  if (isDev()) for (const o of DEV_ORIGINS) set.add(o);
  return set;
}

/**
 * Origin do próprio deploy que está atendendo esta request, derivado dos
 * headers. É a checagem que importa: o front é servido do MESMO host que
 * as functions, sempre — em produção, em branch deploy e em deploy preview.
 *
 * Não dá pra derivar isso de env var: URL / DEPLOY_PRIME_URL / DEPLOY_URL
 * são variáveis de BUILD do Netlify e não chegam ao runtime da function.
 * Depender delas fazia todo deploy preview nascer com o próprio front
 * bloqueado por CORS (pego pela matriz no preview do PR #1).
 */
function selfOrigin(req) {
  const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host.trim()}`;
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

/**
 * Decide o destino de CORS da request.
 *
 * Passa em dois casos: Origin igual ao host que atendeu a request
 * (same-origin — o caso real do app) ou Origin na allowlist fixa. Qualquer
 * outro → 403.
 *
 * Isso NÃO é frouxo: Origin é preenchido pelo browser e não pode ser
 * forjado por JS de página. Uma página em evil.com chamando este endpoint
 * manda Origin: https://evil.com contra Host: reload.recargagames.com —
 * não bate, 403.
 *
 * Origin ausente (curl, teste) → passa, mas sem header de ACAO: não há
 * cookie nem credencial pra proteger aqui, e o rate limit é a defesa real
 * contra automação.
 */
export function resolveCors(req) {
  const origin = req.headers.get("origin");
  if (!origin) return { allowed: true, origin: null };

  const normalized = origin.trim().replace(/\/+$/, "");
  if (normalized === selfOrigin(req)) return { allowed: true, origin: normalized };

  return { allowed: allowedOrigins().has(normalized), origin: normalized };
}

function corsHeaders(cors) {
  const headers = { Vary: "Origin" };
  if (cors.origin) headers["Access-Control-Allow-Origin"] = cors.origin;
  return headers;
}

export function json(status, body, cors, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(cors),
      ...extraHeaders,
    },
  });
}

export function preflight(cors) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(cors),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** IP do cliente. Netlify entrega no header e no context da function v2. */
export function clientIp(req, context) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    context?.ip ||
    // x-forwarded-for pode vir com cadeia; o primeiro é o cliente.
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    null
  );
}

/** HMAC com o salt de env — usado no ip_hash e no hash de log do código. */
export function hmacHex(salt, value) {
  return createHmac("sha256", salt).update(String(value)).digest("hex");
}

/**
 * Rótulo de log de um código de voucher: 4 primeiros chars + hash curto.
 * O hash é HMAC com o salt (não SHA puro) justamente pra que quem tiver
 * acesso só aos logs não consiga reverter por força bruta o resto do
 * código — o espaço de busca de 10 chars é pequeno demais pra SHA nu.
 */
export function codeLabel(code, salt) {
  const prefix = String(code || "").slice(0, 4);
  const digest = salt ? hmacHex(salt, code).slice(0, 12) : "nosalt";
  return `${prefix}…#${digest}`;
}

/** Log estruturado, uma linha por evento. NUNCA recebe código completo. */
export function logEvent(fields) {
  console.log(JSON.stringify(fields));
}

/** Body JSON com teto de tamanho — não há razão pra payload grande aqui. */
export async function readJsonBody(req, maxBytes = 4096) {
  const text = await req.text();
  if (text.length > maxBytes) return { error: "payload_too_large" };
  if (!text) return { value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "invalid_json" };
    }
    return { value };
  } catch {
    return { error: "invalid_json" };
  }
}
