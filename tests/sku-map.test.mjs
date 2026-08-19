/* =====================================================================
   Testes de lib/sku-map.mjs — a REGRA DE MATCH do catálogo (Brief 6).

   Este arquivo prova a decisão central do brief: sku_pattern é prefixo e
   o MAIS LONGO GANHA. É o que substitui a lista ordenada de regex do
   forms-map.json, onde ^FFBV precisava vir antes de ^FF.

   Sem banco: buildSkuMap() e resolveDelivery() são funções puras. A
   integração com o Supabase (loadSkuMap) é exercida em functions.test.mjs
   e redeem.test.mjs, pelo stub do fetch.

   Rodar:  npm test
   ===================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSkuMap, resolveDelivery, MIN_PATTERN_LENGTH } from "../lib/sku-map.mjs";
import { SEED_ROWS, HOYO_ROW, PLUSMO_ROW } from "./sku-map-fixture.mjs";

const SEED = buildSkuMap(SEED_ROWS);
const type = (map, sku) => resolveDelivery(map, sku)?.deliveryType ?? null;

/* ------------------- a regra: mais longo ganha -------------------- */

test("o prefixo MAIS LONGO ganha — FFBV vence FF, venha na ordem que vier", () => {
  // A garantia que substitui a ordem da lista antiga: se 'FF' vencesse,
  // todo cartão de PIN do Free Fire sairia como top-up por ID.
  assert.equal(type(SEED, "FFBV100-S22-br"), "PIN");
  assert.equal(type(SEED, "FF100_10-S116-br"), "DTU");

  // Embaralhar a ordem das linhas não muda nada — é o ponto do desenho.
  const embaralhado = buildSkuMap([...SEED_ROWS].reverse());
  assert.equal(type(embaralhado, "FFBV100-S22-br"), "PIN");
  assert.equal(type(embaralhado, "FF100_10-S116-br"), "DTU");
});

test("SKU exato funciona como prefixo — é o caso degenerado, sem modo novo", () => {
  const map = buildSkuMap([
    { sku_pattern: "FF", delivery_type: "DTU", requires_ip: false },
    // O SKU inteiro como pattern: mais longo, então vence a família.
    { sku_pattern: "FF100_10-S116-BR", delivery_type: "PIN", requires_ip: false },
  ]);
  assert.equal(type(map, "FF100_10-S116-br"), "PIN");
  assert.equal(type(map, "FF200_20-S116-br"), "DTU");
});

test("match é case-insensitive dos dois lados (a regex antiga usava flag 'i')", () => {
  assert.equal(type(SEED, "ffbv100-s22-br"), "PIN");
  assert.equal(type(SEED, "  FFBV100-S22-br  "), "PIN");
  // Pattern gravado fora do canônico ainda resolve: o CHECK do banco já
  // impede isso, mas o código não depende do banco ter sido respeitado.
  const frouxo = buildSkuMap([{ sku_pattern: " ffbv ", delivery_type: "PIN" }]);
  assert.equal(type(frouxo, "FFBV100-S22-br"), "PIN");
});

test("FFLATAM continua DTU — a família excluída do Brasil não muda de tipo", () => {
  assert.equal(type(SEED, "FFLATAM50-S9"), "DTU");
});

/* ----------------------- fail-closed ------------------------------ */

test("SKU sem match devolve null — e null lá em cima é RECUSA", () => {
  assert.equal(resolveDelivery(SEED, "MLBB50-S9-br"), null);
  assert.equal(resolveDelivery(SEED, "MCPIN500-mx"), null);
  // Prefixo do SKU não basta: o pattern é que tem que ser prefixo DELE.
  assert.equal(resolveDelivery(SEED, "F"), null);
});

test("catálogo vazio ou ilegível recusa tudo, inclusive o que já funcionava", () => {
  // O cenário de "subiu o código antes da migration": nada resgata, e
  // nada é entregue no tipo errado. Fail-closed é isso.
  for (const vazio of [[], null, undefined]) {
    assert.equal(resolveDelivery(buildSkuMap(vazio), "FFBV100-S22-br"), null);
  }
});

test("SKU vazio ou lixo nunca casa, nem com pattern curto", () => {
  for (const lixo of ["", "   ", null, undefined, {}]) {
    assert.equal(resolveDelivery(SEED, lixo), null);
  }
});

/* ------------- linhas malformadas são descartadas ----------------- */

test("delivery_type fora de (PIN, DTU) é descartado, não interpretado", () => {
  const map = buildSkuMap([
    { sku_pattern: "MCPIN", delivery_type: "VOUCHER", requires_ip: false },
    ...SEED_ROWS,
  ]);
  // Não vira PIN por parecer voucher: cai no fail-closed.
  assert.equal(resolveDelivery(map, "MCPIN500-mx"), null);
  assert.equal(type(map, "FFBV100-S22-br"), "PIN");
});

test(`pattern com menos de ${MIN_PATTERN_LENGTH} chars é descartado — curinga engoliria o fail-closed`, () => {
  const map = buildSkuMap([{ sku_pattern: "F", delivery_type: "PIN" }, ...SEED_ROWS]);
  // 'F' resolveria QUALQUER SKU começando com F, que é justamente o que a
  // recusa existe pra impedir. O banco barra no INSERT; aqui é a 2ª camada.
  assert.equal(resolveDelivery(map, "FOO123"), null);
  assert.equal(type(map, "FFBV100-S22-br"), "PIN");
});

/* --------------------------- requires_ip -------------------------- */

test("requires_ip vem da linha e só é true quando gravado como boolean true", () => {
  const map = buildSkuMap([HOYO_ROW, PLUSMO_ROW, ...SEED_ROWS]);

  assert.equal(resolveDelivery(map, "GENSHIN60-S1-mx").requiresIp, true);
  assert.equal(resolveDelivery(map, "MCPIN500-mx").requiresIp, false);
  assert.equal(resolveDelivery(map, "FFBV100-S22-br").requiresIp, false);

  // Coluna ausente ou "truthy" não liga a flag: mandar IP pro fornecedor é
  // decisão de LGPD, não acidente de tipagem.
  const duvidoso = buildSkuMap([
    { sku_pattern: "AAA", delivery_type: "PIN" },
    { sku_pattern: "BBB", delivery_type: "PIN", requires_ip: "true" },
    { sku_pattern: "CCC", delivery_type: "PIN", requires_ip: 1 },
  ]);
  assert.equal(resolveDelivery(duvidoso, "AAA1").requiresIp, false);
  assert.equal(resolveDelivery(duvidoso, "BBB1").requiresIp, false);
  assert.equal(resolveDelivery(duvidoso, "CCC1").requiresIp, false);
});

test("a campanha Plusmo (Minecraft/Roblox, MX, PIN) passa a resolver sem deploy", () => {
  // O caso de uso que motivou o brief: hoje recusado, resolvido por INSERT.
  assert.equal(resolveDelivery(SEED, "MCPIN500-mx"), null);

  const comPlusmo = buildSkuMap([PLUSMO_ROW, ...SEED_ROWS]);
  assert.equal(type(comPlusmo, "MCPIN500-mx"), "PIN");
  assert.equal(type(comPlusmo, "MCPIN1000-mx"), "PIN");
  // E nada do Free Fire se mexeu.
  assert.equal(type(comPlusmo, "FFBV100-S22-br"), "PIN");
  assert.equal(type(comPlusmo, "FF100_10-S116-br"), "DTU");
});
