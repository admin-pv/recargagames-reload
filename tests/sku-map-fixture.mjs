/* =====================================================================
   Fixture do catálogo pv_sku_delivery_map (Brief 6).

   NÃO é arquivo de teste — é o dado que os quatro arquivos de teste
   compartilham, para que o stub do fetch e as chamadas diretas a
   lib/forms.mjs vejam exatamente o MESMO catálogo.

   SEED_ROWS espelha o seed da migration 2026-08-19-pv-sku-delivery-map.sql
   linha por linha. Se a migration mudar e isto não, a suíte passa a
   testar um mundo que não existe — é o único acoplamento manual entre o
   SQL e os testes, e é de propósito: o alternativo seria parsear o .sql.
   ===================================================================== */

/** O seed de produção: as famílias Free Fire já validadas no Brief 3. */
export const SEED_ROWS = [
  { sku_pattern: "FFBV", delivery_type: "PIN", requires_ip: false },
  { sku_pattern: "FFLATAM", delivery_type: "DTU", requires_ip: false },
  { sku_pattern: "FF", delivery_type: "DTU", requires_ip: false },
];

/**
 * SKU fictício da Hoyoverse, com requires_ip ligado. Não existe no seed:
 * é o cadastro que o Brief 6 tornou possível SEM deploy, e serve para
 * provar que a flag chega até o corpo do create.
 */
export const HOYO_ROW = {
  sku_pattern: "GENSHIN",
  delivery_type: "DTU",
  requires_ip: true,
};

/** SKU de PIN da campanha Plusmo (MX) — o caso de uso que motivou o brief. */
export const PLUSMO_ROW = {
  sku_pattern: "MCPIN",
  delivery_type: "PIN",
  requires_ip: false,
};

/** Resposta do PostgREST para o SELECT da tabela. */
export const skuMapRows = (extra = []) => [...SEED_ROWS, ...extra];
