// Catálogo SKU → tipo de entrega, lido de pv_sku_delivery_map (Brief 6).
//
// ============================ LEIA ANTES DE MEXER =====================
// Este módulo responde a pergunta que decide o TIPO da order: "o SKU
// FFBV100-S22-br entrega um PIN ou uma recarga por ID?". Errar aqui não
// gera formulário feio — gera order do tipo errado, com dinheiro real e
// sem reembolso (check_id OFF nos SKUs de Free Fire).
//
// Até o Brief 3 a resposta vinha de uma lista de regex ORDENADA no
// forms-map.json, onde ^FFBV precisava vir antes de ^FF. Isso é código: um
// jogo novo exigia deploy, e a campanha da Plusmo (Minecraft e Roblox, MX,
// só PIN) tornou isso insustentável. Agora é tabela.
//
// REGRA DE MATCH: sku_pattern é PREFIXO e o MAIS LONGO GANHA.
//   'FFBV' (4) vence 'FF' (2) em FFBV100-S22-br, sem coluna de prioridade
//   e sem ordem implícita. A ordem correta virou propriedade dos dados.
//   SKU exato é o caso degenerado: o prefixo é o SKU inteiro.
//   Empate é impossível: dois patterns do mesmo tamanho que casem com o
//   mesmo SKU seriam a mesma string, e o UNIQUE da tabela barra.
//
// FAIL-CLOSED, sem chave de escape: SKU sem match devolve null e quem
// chama RECUSA. Não existe mais o `unknown_sku_delivery: "allow"` do
// forms-map.json — afrouxar agora exige mudar este arquivo, com revisão.
// ======================================================================
//
// Sem cache de propósito. A tabela é minúscula e a leitura vai pro mesmo
// Supabase que a request já consulta, então o custo é um SELECT a mais no
// caminho que já é lento. Cache em memória de function é servido por
// container e expira sem hora marcada — durante um incidente ("corrigi a
// linha errada, por que não pegou?") isso vira tempo perdido. Se um dia o
// volume justificar, o lugar do TTL é aqui, e só aqui.

import { sbSelect } from "./supabase.mjs";

/**
 * Piso de tamanho do prefixo, espelhando o CHECK da migration.
 *
 * Um pattern de 1 char ('F') nunca venceria de um mais longo, mas passaria
 * a resolver qualquer SKU DESCONHECIDO que comece com a letra — que é
 * exatamente o que a recusa existe pra impedir. O banco já barra no
 * INSERT; aqui é a segunda camada, pro caso de a constraint ter sido
 * afrouxada à mão no SQL Editor.
 */
export const MIN_PATTERN_LENGTH = 2;

const VALID_DELIVERY = new Set(["PIN", "DTU"]);

const SELECT_PATH =
  "pv_sku_delivery_map?select=sku_pattern,delivery_type,requires_ip&order=sku_pattern.asc";

/**
 * Transforma as linhas da tabela na estrutura de busca. Função pura — a
 * regra de match fica testável sem banco.
 *
 * Linha malformada é DESCARTADA, não corrigida: um pattern vazio ou um
 * delivery_type fora de (PIN, DTU) só pode ter chegado ali driblando as
 * constraints, e adivinhar a intenção seria pior que ignorar. Descartada,
 * ela cai no fail-closed; interpretada, viraria uma order.
 */
export function buildSkuMap(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      pattern: String(row?.sku_pattern ?? "").trim().toUpperCase(),
      deliveryType: String(row?.delivery_type ?? "").trim().toUpperCase(),
      requiresIp: row?.requires_ip === true,
    }))
    .filter(
      (rule) => rule.pattern.length >= MIN_PATTERN_LENGTH && VALID_DELIVERY.has(rule.deliveryType)
    )
    .sort((a, b) => b.pattern.length - a.pattern.length || a.pattern.localeCompare(b.pattern));
}

/**
 * Resolve o SKU no mapa. Devolve { pattern, deliveryType, requiresIp } ou
 * null quando nada casa — e null aqui significa RECUSA lá em cima, nunca
 * "assume o mais provável".
 *
 * Case-insensitive dos dois lados (a regex antiga usava flag 'i', e a
 * migration obriga o pattern a ser guardado em caixa alta).
 */
export function resolveDelivery(map, productCode) {
  const sku = String(productCode ?? "").trim().toUpperCase();
  if (!sku) return null;
  // `map` já vem ordenado do mais longo pro mais curto: o primeiro que
  // casar é o vencedor.
  for (const rule of Array.isArray(map) ? map : []) {
    if (sku.startsWith(rule.pattern)) return rule;
  }
  return null;
}

/**
 * Lê a tabela inteira e monta o mapa. Uma chamada por request.
 *
 * Propaga UpstreamError: quem chama devolve 503. NÃO existe fallback pro
 * forms-map.json — duas fontes de verdade fariam o comportamento de um SKU
 * mudar silenciosamente durante um incidente, que é justamente quando
 * ninguém está olhando. Fail-closed vale também pra falha de leitura.
 */
export async function loadSkuMap(cfg) {
  return buildSkuMap(await sbSelect(cfg, SELECT_PATH));
}
