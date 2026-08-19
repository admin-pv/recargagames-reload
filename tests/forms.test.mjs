/* =====================================================================
   Testes unitários de lib/forms.mjs — os VALORES do payload limpo.
   Existe separado de functions.test.mjs porque o stub das functions não
   expõe o player_data saneado (de propósito: ele carrega dado pessoal e
   não vai pra log nem pra resposta). Aqui a função é chamada direto.

   Rodar:  npm test
   ===================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fieldsForContent,
  validatePlayerData,
  isValidCpf,
  purposeNote,
  checkSkuDelivery,
  expectedDeliveryType,
} from "../lib/forms.mjs";
import { buildSkuMap } from "../lib/sku-map.mjs";
import { SEED_ROWS, HOYO_ROW } from "./sku-map-fixture.mjs";

// O catálogo que no ar vem da tabela pv_sku_delivery_map (Brief 6). Aqui
// ele é injetado direto: forms.mjs não fala com banco, recebe o mapa
// pronto — foi o que manteve este arquivo puro depois do brief.
const MAP = buildSkuMap(SEED_ROWS);

const DTU = { id: "c1", delivery_type: "DTU", product_code: "FF100_10-S116-br" };
const PIN = { id: "c2", delivery_type: "PIN", product_code: "FFBV100-S22-br" };
const DTU_NAO_MAPEADO = { id: "c3", delivery_type: "DTU", product_code: "MLBB50-S9-br" };
// O caso do Brief 2 §8.2: SKU de voucher (PIN) cadastrado como DTU.
const SKU_TROCADO = { id: "c4", delivery_type: "DTU", product_code: "FFBV100-S22-br" };

const fieldsOf = (content) => fieldsForContent(content, MAP).fields;

test("fail-closed: SKU sem regra de entrega não resolve formulário", () => {
  const mapeado = fieldsForContent(DTU, MAP);
  assert.equal(mapeado.ok, true);
  assert.equal(mapeado.categoryKey, "free_fire");

  // MLBB não casa com nenhuma linha do catálogo: barra na trava de
  // entrega, antes mesmo de faltar categoria.
  const naoMapeado = fieldsForContent(DTU_NAO_MAPEADO, MAP);
  assert.equal(naoMapeado.ok, false);
  assert.equal(naoMapeado.reason, "unmapped_delivery_sku");
  assert.deepEqual(naoMapeado.fields, []);
});

/* ---------------- trava SKU × delivery_type (Brief 3) --------------- */

test("expectedDeliveryType: FFBV é PIN e FF é DTU — regressão do Brief 3", () => {
  // O comportamento que a tabela do Brief 6 tinha que preservar byte a
  // byte. Se 'FF' vencesse 'FFBV', todo voucher Free Fire seria
  // classificado como top-up e a trava inverteria de sinal.
  assert.equal(expectedDeliveryType("FFBV100-S22-br", MAP), "PIN");
  assert.equal(expectedDeliveryType("FF100_10-S116-br", MAP), "DTU");
  assert.equal(expectedDeliveryType("MLBB50-S9-br", MAP), null);
});

test("SKU de voucher cadastrado como DTU é RECUSADO (§8.2 do Brief 2)", () => {
  const verdict = checkSkuDelivery(SKU_TROCADO, MAP);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sku_delivery_mismatch");
  assert.equal(verdict.expected, "PIN");

  // E o formulário não sai: sem isso o app pediria user_id pra um produto
  // que entrega PIN, e a order sairia com o campo errado.
  const form = fieldsForContent(SKU_TROCADO, MAP);
  assert.equal(form.ok, false);
  assert.equal(form.reason, "sku_delivery_mismatch");
});

test("SKU desconhecido é recusado inclusive em PIN", () => {
  // PIN não passa por categoria, então a trava de entrega é a ÚNICA
  // defesa dele contra SKU não conferido.
  const pinDesconhecido = { id: "c5", delivery_type: "PIN", product_code: "MLBB50-S9-br" };
  const form = fieldsForContent(pinDesconhecido, MAP);
  assert.equal(form.ok, false);
  assert.equal(form.reason, "unmapped_delivery_sku");
});

test("cadastro correto passa nos dois tipos", () => {
  assert.equal(checkSkuDelivery(DTU, MAP).ok, true);
  assert.equal(checkSkuDelivery(PIN, MAP).ok, true);
});

/* -------------- requires_ip atravessa até o formulário -------------- */

test("requires_ip do catálogo chega em fieldsForContent, sem virar campo do form", () => {
  const map = buildSkuMap([HOYO_ROW, ...SEED_ROWS]);

  // Free Fire: a flag existe e é false. Nenhum IP sai daqui.
  assert.equal(fieldsForContent(PIN, map).requiresIp, false);
  assert.equal(fieldsForContent(DTU, map).requiresIp, false);

  // Hoyoverse: a flag sobe pro redeemer, que é quem decide mandar o IP no
  // create. O formulário NÃO ganha campo nenhum — o portador não digita IP.
  const genshin = { id: "c6", delivery_type: "DTU", product_code: "GENSHIN60-S1-mx" };
  const form = fieldsForContent(genshin, map);
  // Categoria não mapeada no forms-map.json: recusa por unmapped_sku, que
  // é a trava do Brief 2 e continua valendo — a flag de IP não a atravessa.
  assert.equal(form.ok, false);
  assert.equal(form.reason, "unmapped_sku");
  assert.equal(form.requiresIp, false);

  // Já um SKU de PIN com requires_ip resolve, porque PIN não usa categoria.
  const hoyoPin = { id: "c7", delivery_type: "PIN", product_code: "GENSHINPIN-mx" };
  const mapPin = buildSkuMap([
    { sku_pattern: "GENSHINPIN", delivery_type: "PIN", requires_ip: true },
    ...SEED_ROWS,
  ]);
  const pinForm = fieldsForContent(hoyoPin, mapPin);
  assert.equal(pinForm.ok, true);
  assert.equal(pinForm.requiresIp, true);
  assert.deepEqual(
    pinForm.fields.map((f) => f.field),
    ["email", "cpf", "marketing_optin"]
  );
});

test("catálogo vazio recusa até o Free Fire — o cenário 'deploy antes da migration'", () => {
  const vazio = buildSkuMap([]);
  for (const content of [PIN, DTU]) {
    const form = fieldsForContent(content, vazio);
    assert.equal(form.ok, false);
    assert.equal(form.reason, "unmapped_delivery_sku");
  }
});

test("PIN resolve só os campos comuns", () => {
  const pin = fieldsForContent(PIN, MAP);
  assert.equal(pin.ok, true);
  assert.deepEqual(
    pin.fields.map((f) => f.field),
    ["email", "cpf", "marketing_optin"]
  );
});

test("optin desmarcado por padrão: valor limpo é false quando não vem nada", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "a@b.com" });
  assert.equal(ok, true);
  assert.equal(clean.marketing_optin, false);
  assert.equal(typeof clean.marketing_optin, "boolean");
});

test("optin marcado vira true; string 'true'/'on' também", () => {
  for (const enviado of [true, "true", "on", 1, "1"]) {
    const { clean } = validatePlayerData(fieldsOf(PIN), {
      email: "a@b.com",
      marketing_optin: enviado,
    });
    assert.equal(clean.marketing_optin, true, `falhou pra ${JSON.stringify(enviado)}`);
  }
  for (const enviado of [false, "false", "off", 0, null, undefined, "qualquer"]) {
    const { clean } = validatePlayerData(fieldsOf(PIN), {
      email: "a@b.com",
      marketing_optin: enviado,
    });
    assert.equal(clean.marketing_optin, false, `falhou pra ${JSON.stringify(enviado)}`);
  }
});

test("email é normalizado pra minúsculas e sem espaço nas pontas", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "  Jogador@Email.COM  " });
  assert.equal(ok, true);
  assert.equal(clean.email, "jogador@email.com");
});

test("email acima de 254 chars é recusado", () => {
  const longo = `${"a".repeat(250)}@email.com`;
  const { ok, errors } = validatePlayerData(fieldsOf(PIN), { email: longo });
  assert.equal(ok, false);
  assert.ok(errors.email);
});

test("CPF é guardado só em dígitos, sem máscara", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), {
    email: "a@b.com",
    cpf: "111.444.777-35",
  });
  assert.equal(ok, true);
  assert.equal(clean.cpf, "11144477735");
});

test("CPF ausente não entra no payload limpo (é opcional)", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "a@b.com" });
  assert.equal(ok, true);
  assert.equal("cpf" in clean, false);
});

test("dígito verificador de CPF", () => {
  for (const valido of ["11144477735", "52998224725", "15350946056"]) {
    assert.equal(isValidCpf(valido), true, `${valido} deveria ser válido`);
  }
  for (const invalido of [
    "11144477736", // último dígito errado
    "11144477725", // penúltimo dígito errado
    "00000000000",
    "99999999999",
    "1114447773", // 10 dígitos
    "111444777350", // 12 dígitos
    "abcdefghijk",
    "",
  ]) {
    assert.equal(isValidCpf(invalido), false, `${invalido} deveria ser inválido`);
  }
});

test("campos não declarados são descartados do payload limpo", () => {
  const { clean } = validatePlayerData(fieldsOf(DTU), {
    user_id: "13846816197",
    email: "a@b.com",
    product_code: "FF-HACK",
    admin: true,
    price: 0,
  });
  assert.deepEqual(Object.keys(clean).sort(), ["email", "marketing_optin", "user_id"]);
});

test("linha de finalidade existe e fala de resgate e fraude", () => {
  assert.match(purposeNote(), /validação do resgate/i);
  assert.match(purposeNote(), /fraude/i);
});
