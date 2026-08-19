-- =====================================================================
-- Migration: pv_sku_delivery_map (Brief 6) — catálogo de tipo de entrega
-- Data: 2026-08-19
-- Objetivo: tirar do CÓDIGO a resposta para "este SKU entrega PIN ou DTU?".
--
-- Até o Brief 3 essa resposta vinha do forms-map.json
-- (`sku_delivery_patterns`), que é arquivo do bundle: jogo novo exigia
-- deploy. A campanha da Plusmo (mercado MX, Minecraft e Roblox, só PIN)
-- torna isso insustentável — as denominações ainda nem foram definidas.
-- Catálogo é dado operacional, não código.
--
-- Como rodar: colar este arquivo inteiro no Supabase SQL Editor
--             (instância ashmirzgyuhspymldpfv) e executar.
--             Idempotente — pode ser re-executado sem erro.
--
-- ADITIVA. Cria UMA tabela nova e não toca em nenhuma existente.
--
-- >>> ORDEM DE APLICAÇÃO IMPORTA <<<
-- Aplicar esta migration ANTES do merge/deploy do código do Brief 6.
-- O redeemer novo lê SÓ desta tabela: se ele subir antes dela existir (ou
-- com ela vazia), TODO SKU passa a ser recusado com unmapped_delivery_sku
-- e o resgate para inteiro. Nenhum voucher é queimado nesse cenário — a
-- recusa acontece antes do claim — mas o app fica inútil até o seed rodar.
-- Na ordem certa (tabela primeiro) não há janela nenhuma: a tabela fica
-- ociosa até o deploy, porque nada mais no banco a consulta.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) A tabela.
--
--    SEMÂNTICA DE sku_pattern: é um PREFIXO, e o MATCH MAIS LONGO GANHA.
--    Um SKU exato é o caso degenerado (o prefixo é o SKU inteiro), então
--    a mesma coluna atende os dois usos sem modo nem flag.
--
--    Por que "mais longo ganha" e não uma coluna de prioridade: a lista
--    de regex que isto substitui era ORDENADA, e a ordem era uma armadilha
--    (^FFBV TINHA que vir antes de ^FF, senão todo voucher de Free Fire
--    seria classificado como top-up e a trava inverteria de sinal). Com
--    prioridade explícita esse erro voltaria a ser possível, agora via
--    INSERT no SQL Editor. Com o mais longo ganhando, 'FFBV' (4 chars)
--    vence 'FF' (2) sozinho — a ordem correta é uma propriedade dos dados,
--    não uma disciplina do operador.
--
--    O desempate é impossível por construção: dois patterns do MESMO
--    tamanho que casem com o MESMO SKU seriam a mesma string, e o UNIQUE
--    barra. Ou seja, não existe SKU com dois vencedores.
--
--    Comparação é CASE-INSENSITIVE (a regex antiga usava flag 'i'). Em vez
--    de fazer isso na consulta, o CHECK obriga o pattern a ser guardado em
--    CAIXA ALTA e o redeemer sobe o SKU pra caixa alta antes de comparar.
--    Guardar canônico também impede que 'ff' e 'FF' coexistam driblando o
--    UNIQUE — duas regras conflitantes para o mesmo prefixo.
--
--    length >= 2 NÃO é frescura: um pattern de 1 char ('F') seria o
--    curinga que engole o fail-closed. Ele nunca venceria de um pattern
--    mais longo, mas passaria a resolver qualquer SKU desconhecido que
--    comece com a letra — exatamente o que a recusa existe para impedir.
--
--    requires_ip: SKUs da Hoyoverse (Genshin, Zenless, HSR) exigem
--    `end_user_ip_address` no create da Lapak. Fica aqui como flag por
--    linha porque é característica do produto, não do nosso app. Ligada,
--    o redeemer manda o IP CRU do portador PARA O FORNECEDOR e mais nada:
--    não vai pra log, não vai pro banco (lá só existe o HMAC do IP). É
--    decisão de LGPD por SKU, e é por isso que ela é explícita e default
--    false.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pv_sku_delivery_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_pattern   text NOT NULL UNIQUE,
  delivery_type text NOT NULL,
  requires_ip   boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pv_sku_delivery_map_type_chk
    CHECK (delivery_type IN ('PIN', 'DTU')),

  -- Canônico: caixa alta, sem espaço nas pontas, mínimo 2 chars.
  CONSTRAINT pv_sku_delivery_map_pattern_chk
    CHECK (sku_pattern = upper(btrim(sku_pattern)) AND length(sku_pattern) >= 2)
);

COMMENT ON TABLE public.pv_sku_delivery_map IS
  'Brief 6. SKU -> tipo de entrega. sku_pattern e PREFIXO em CAIXA ALTA; '
  'o match mais longo ganha. SKU sem match e RECUSADO pelo redeemer '
  '(fail-closed) — nao existe default. Escrita: admin (is_admin()). '
  'Leitura: service_role do app de resgate.';

COMMENT ON COLUMN public.pv_sku_delivery_map.requires_ip IS
  'true = o create da Lapak leva end_user_ip_address (caso Hoyoverse). O IP '
  'cru vai SO para o fornecedor: nunca para log, nunca persistido em claro.';


-- ---------------------------------------------------------------------
-- 2) Row Level Security — mesmo padrão das tabelas pv_* do Brief 1.
--
--    Escrita e leitura pelo painel: 'authenticated' que passe em
--    is_admin(). NENHUMA policy para 'anon' → default DENY.
--
--    O app de resgate lê com a Secret key (service_role), que BYPASSA RLS
--    por design — mas ele só precisa LER, então os privilégios de tabela
--    são reduzidos a SELECT logo abaixo. RLS e GRANT são camadas
--    independentes e ambas valem: mesmo bypassando a policy, o
--    service_role não consegue escrever sem o GRANT.
--
--    ATENÇÃO PARA O BRIEF 4 (CRUD no admin): o painel deve escrever como
--    'authenticated' + is_admin(), NÃO com a service key. Se um dia algo
--    tentar INSERT com a Secret key, vai levar 42501 — e isso é o desenho,
--    não um bug.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_sku_delivery_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pv_sku_delivery_map_admin_all ON public.pv_sku_delivery_map;
CREATE POLICY pv_sku_delivery_map_admin_all ON public.pv_sku_delivery_map
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- anon não tem policy E não tem privilégio: as duas portas fechadas.
REVOKE ALL ON public.pv_sku_delivery_map FROM anon;

-- authenticated precisa do privilégio para a policy acima poder valer.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pv_sku_delivery_map TO authenticated;

-- O redeemer só lê. REVOKE antes do GRANT porque o Supabase concede ALL
-- por default privilege ao service_role em tabelas novas do schema public.
REVOKE ALL  ON public.pv_sku_delivery_map FROM service_role;
GRANT SELECT ON public.pv_sku_delivery_map TO service_role;


-- ---------------------------------------------------------------------
-- 3) Seed — as famílias já validadas em produção.
--
--    Reproduz o sku_delivery_patterns do forms-map.json BYTE A BYTE em
--    comportamento: FFBV → PIN, FFLATAM → DTU, FF → DTU. Com o match mais
--    longo ganhando, a ordem da lista antiga deixa de existir e o
--    resultado é idêntico para todo SKU de Free Fire.
--
--    FFLATAM resolveria DTU pelo 'FF' de qualquer jeito — a linha existe
--    pela NOTA, que é o aviso operacional que não pode se perder.
--
--    ON CONFLICT DO NOTHING: re-executar a migration não sobrescreve o que
--    o admin já tiver ajustado à mão.
-- ---------------------------------------------------------------------
INSERT INTO public.pv_sku_delivery_map (sku_pattern, delivery_type, requires_ip, notes)
VALUES
  ('FFBV', 'PIN', false,
   'Voucher Free Fire Brazil (variant VOUCHER, forms:[]) — entrega por PIN. Ex: FFBV100-S22-br.'),
  ('FFLATAM', 'DTU', false,
   'Free Fire Latam EXCLUI o Brasil (achado do teste A0). Cadastrado só para nunca cair em regra mais curta por acidente; NAO usar em lote brasileiro: com check_id OFF cobra sem entregar.'),
  ('FF', 'DTU', false,
   'Top-up Free Fire por ID do jogador. Ex: FF100_10-S116-br.')
ON CONFLICT (sku_pattern) DO NOTHING;


-- PostgREST cacheia o schema. O Supabase costuma recarregar sozinho no
-- DDL; se a tabela responder 404 (PGRST205) depois desta migration:
--     NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- 4) TESTES DE VERIFICAÇÃO  (rodar DEPOIS dos blocos acima)
-- ---------------------------------------------------------------------
-- IMPORTANTE: o SQL Editor roda como 'postgres' (owner/superuser), que
-- BYPASSA RLS. Para provar a trava é preciso virar 'anon' dentro de uma
-- transação (SET LOCAL ROLE) e dar ROLLBACK. Mesmo procedimento dos
-- Briefs 1, 2 e 3.
--
-- Rodar UM BLOCO POR VEZ. Nos testes 1 e 2 o ERRO é o resultado esperado.
--
-- Teste 1 — SELECT como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       SELECT * FROM public.pv_sku_delivery_map;
--     ROLLBACK;
--     -- esperado: ERROR 42501 permission denied for table
--     --  (ou 0 linhas, se quem barrou foi a RLS — as duas passam)
--
-- Teste 2 — INSERT como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       INSERT INTO public.pv_sku_delivery_map (sku_pattern, delivery_type)
--       VALUES ('RLSTEST', 'PIN');
--     ROLLBACK;
--     -- esperado: ERROR 42501
--     -- ESTE É O TESTE QUE MAIS IMPORTA: quem escreve aqui decide se um
--     -- SKU entrega PIN ou top-up. Escrita aberta = order do tipo errado.
--
-- Teste 3 — o CHECK de canonicidade barra pattern fora do padrão:
--     BEGIN;
--       INSERT INTO public.pv_sku_delivery_map (sku_pattern, delivery_type)
--       VALUES ('ffbv', 'PIN');           -- caixa baixa
--     ROLLBACK;
--     -- esperado: ERROR 23514 pv_sku_delivery_map_pattern_chk
--
--     BEGIN;
--       INSERT INTO public.pv_sku_delivery_map (sku_pattern, delivery_type)
--       VALUES ('F', 'PIN');              -- curinga de 1 char
--     ROLLBACK;
--     -- esperado: ERROR 23514 pv_sku_delivery_map_pattern_chk
--
--     BEGIN;
--       INSERT INTO public.pv_sku_delivery_map (sku_pattern, delivery_type)
--       VALUES ('MCPIN', 'VOUCHER');      -- tipo inexistente
--     ROLLBACK;
--     -- esperado: ERROR 23514 pv_sku_delivery_map_type_chk
--
-- Teste 4 — o seed resolve o Free Fire igual ao forms-map.json antigo.
--     Simula o "mais longo ganha" em SQL (o redeemer faz o mesmo em JS):
--
--     WITH skus(sku) AS (VALUES
--       ('FFBV100-S22-br'),      -- esperado: PIN
--       ('FF100_10-S116-br'),    -- esperado: DTU
--       ('FFLATAM50-S9'),        -- esperado: DTU
--       ('MCPIN500-mx')          -- esperado: (nulo) → RECUSA
--     )
--     SELECT s.sku,
--            (SELECT m.delivery_type
--               FROM public.pv_sku_delivery_map m
--              WHERE upper(s.sku) LIKE m.sku_pattern || '%'
--              ORDER BY length(m.sku_pattern) DESC
--              LIMIT 1) AS delivery_type
--       FROM skus s;
--     -- Se FFBV100-S22-br voltar DTU, PARE: a trava está invertida e um
--     -- cartão de PIN sairia como top-up.
--
-- Teste 5 — sanidade do schema:
--     SELECT column_name, data_type, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_schema = 'public' AND table_name = 'pv_sku_delivery_map'
--      ORDER BY ordinal_position;
-- =====================================================================


-- =====================================================================
-- 5) COMO CADASTRAR UM SKU NOVO (até o CRUD do admin existir, Brief 4)
--
--    Um INSERT por família. Confirme o tipo de entrega no catálogo da
--    Lapak (variant VOUCHER = PIN; top-up = DTU) ANTES de inserir: esta
--    tabela é a última palavra do redeemer, e não há reembolso de entrega
--    no tipo errado.
--
--    Exemplo (campanha Plusmo — denominações ainda não definidas):
--      INSERT INTO public.pv_sku_delivery_map
--        (sku_pattern, delivery_type, requires_ip, notes)
--      VALUES ('MCPIN', 'PIN', false,
--              'Minecraft MX, campanha Plusmo. Confirmado VOUCHER no catalogo.');
--
--    Lembre: o pattern é PREFIXO em CAIXA ALTA. Prefira o prefixo mais
--    ESPECÍFICO que cubra a família — quanto mais curto, mais chance de
--    capturar um jogo futuro por acidente.
--
--    Para um SKU exato, basta usar o SKU inteiro como pattern.
-- =====================================================================


-- =====================================================================
-- 6) ROLLBACK (Plano B) — descomentar e rodar para desfazer.
--
--    Só faz sentido DEPOIS de reverter o código do Brief 6: com o
--    redeemer novo no ar e sem esta tabela, todo resgate é recusado.
--    O caminho normal do rollback é o inverso — reverter o PR e DEIXAR a
--    tabela de pé, órfã e sem efeito, pronta pra nova tentativa.
--
--    Não há dado pessoal aqui: é catálogo. Apagar não perde trilha de
--    resgate nenhuma.
-- ---------------------------------------------------------------------
-- DROP TABLE IF EXISTS public.pv_sku_delivery_map;
-- =====================================================================
