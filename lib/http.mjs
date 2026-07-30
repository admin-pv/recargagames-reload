// Helpers de HTTP compartilhados pelas Netlify Functions.
//
// Vive FORA de netlify/functions/ de propósito: qualquer arquivo lá dentro
// corre o risco de ser interpretado como uma function pelo bundler. Aqui é
// só um módulo importado — o esbuild inlina no bundle de quem importa.

import { createHmac } from "node:crypto";

// Domínio canônico do app. Previews e branch deploys entram via env do
// Netlify (URL / DEPLOY_PRIME_URL / DEPLOY_URL), então não é preciso
// hardcodar *.netlify.app nem liberar wildcard.
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
  for (const key of ["URL", "DEPLOY_PRIME_URL", "DEPLOY_URL"]) {
    const value = process.env[key];
    if (value) set.add(value.trim().replace(/\/+$/, ""));
  }
  if (isDev()) for (const o of DEV_ORIGINS) set.add(o);
  return set;
}

/**
 * Decide o destino de CORS da request.
 *
 * Origin ausente (curl, teste) → passa, mas sem header de ACAO: não há
 * cookie nem credencial pra proteger aqui, e o rate limit é a defesa real
 * contra automação. Origin presente e fora da lista → 403, sem exceção.
 */
export function resolveCors(req) {
  const origin = req.headers.get("origin");
  if (!origin) return { allowed: true, origin: null };
  const normalized = origin.trim().replace(/\/+$/, "");
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
