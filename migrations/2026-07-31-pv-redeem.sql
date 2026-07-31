-- =====================================================================
-- Migration: Redeemer real (Brief 3) — colunas de persistência do resgate
-- Data: 2026-07-31
-- Objetivo: dar ao pv_redeem_attempts o que o resgate de verdade precisa
--           guardar (dado pessoal do portador, custo da order, snapshot
--           de câmbio) e criar o CLAIM ATÔMICO do voucher.
--
-- Como rodar: colar este arquivo inteiro no Supabase SQL Editor
--             (instância ashmirzgyuhspymldpfv) e executar.
--             Idempotente — pode ser re-executado sem erro.
--
-- ADITIVA. Não altera coluna existente, não apaga nada, não toca em
-- pv_batches / pv_batch_contents / pv_validate_rate nem em bonus_vouchers.
-- A RLS das tabelas pv_* já está trancada pelo Brief 1 (admin-only, sem
-- policy pra anon); colunas novas herdam a trava da tabela.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) pv_redeem_attempts — colunas novas, TODAS nullable.
--
--    Nullable de propósito: o attempt nasce ANTES da chamada à Lapak
--    (é ele que registra a tentativa em voo), então custo e câmbio só
--    existem depois da resposta do create. NOT NULL aqui impediria a
--    trilha de existir justamente no momento em que ela mais importa.
--
--    LGPD: email/cpf/marketing_optin são o dado do portador coletado no
--    formulário; ip_hash é HMAC-SHA256(IP_HASH_SALT, ip). O IP CRU não
--    tem coluna aqui e não deve ganhar uma. O CPF é gravado só em
--    dígitos (a máscara é apresentação, não dado).
--
--    Câmbio: fx_usd_idr / fx_brl_usd são o SNAPSHOT usado no cálculo, não
--    a cotação de hoje. Guardar as duas taxas junto do resultado é o que
--    permite reauditar o custo meses depois sem depender do valor que a
--    env var tinha na época.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_redeem_attempts
  ADD COLUMN IF NOT EXISTS email            text,
  ADD COLUMN IF NOT EXISTS cpf              text,      -- só dígitos, sem máscara
  ADD COLUMN IF NOT EXISTS marketing_optin  boolean,
  ADD COLUMN IF NOT EXISTS ip_hash          text,      -- HMAC(salt, ip). NUNCA o IP cru.
  ADD COLUMN IF NOT EXISTS cost_idr         numeric,   -- total_price da resposta do create
  ADD COLUMN IF NOT EXISTS fx_usd_idr       numeric,   -- snapshot: quantos IDR valem 1 USD
  ADD COLUMN IF NOT EXISTS fx_brl_usd       numeric,   -- snapshot: quantos BRL valem 1 USD
  ADD COLUMN IF NOT EXISTS cost_usd         numeric,   -- cost_idr / fx_usd_idr
  ADD COLUMN IF NOT EXISTS cost_brl         numeric,   -- cost_usd * fx_brl_usd
  ADD COLUMN IF NOT EXISTS pin_delivered    boolean NOT NULL DEFAULT false,
  -- ADIÇÃO ao brief: throttle do polling. Netlify Functions são stateless,
  -- então o "cache de 3s" pra não martelar o fornecedor não pode viver em
  -- memória — ele vive aqui. O /api/status só consulta a Lapak se passaram
  -- ≥3s desde a última consulta DESTE attempt.
  ADD COLUMN IF NOT EXISTS last_polled_at   timestamptz;


-- ---------------------------------------------------------------------
-- 2) Índices
--    - voucher_id: o redeemer conta as tentativas do voucher pra montar o
--      attempt_ref (<code>-a<n>) e a reconciliação busca o attempt em voo.
--    - PARCIAL em pv_vouchers(status) WHERE status='PROCESSING': é a
--      varredura do job de reconciliação. Parcial porque PROCESSING é um
--      estado transitório e raro — o índice fica minúsculo mesmo com
--      milhões de vouchers USADO/EMITIDO. (Existe também o índice cheio
--      pv_vouchers_status_idx do Brief 1; este é o que o planner escolhe
--      pra essa query específica.)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS pv_redeem_attempts_voucher_id_idx
  ON public.pv_redeem_attempts (voucher_id);

CREATE INDEX IF NOT EXISTS pv_vouchers_processing_idx
  ON public.pv_vouchers (status)
  WHERE status = 'PROCESSING';


-- ---------------------------------------------------------------------
-- 3) pv_redeem_claim() — ADIÇÃO ao schema do brief. É a peça central.
--
--    POR QUE UMA FUNÇÃO: o create da Lapak não aceita referência externa
--    (confirmado no A0), então NÃO EXISTE idempotência do lado do
--    fornecedor. O flip EMITIDO → PROCESSING é a ÚNICA barreira contra
--    resgate duplicado — se dois requests simultâneos passarem, saem duas
--    orders e o dinheiro sai duas vezes.
--
--    O UPDATE ... WHERE status='EMITIDO' é atômico: o segundo request
--    fica bloqueado na linha, e quando o primeiro commita ele RE-AVALIA
--    o WHERE (READ COMMITTED) e não casa mais. Zero linhas = perdeu a
--    corrida.
--
--    PostgREST não expressa isso: um PATCH com filtro não dá o join com
--    pv_batches (lote ativo e não vencido), e ler-depois-escrever é
--    exatamente a corrida que estamos tentando evitar.
--
--    Devolve também o attempt_number seguinte, na MESMA chamada, pra que
--    o attempt_ref (<code>-a<n>) seja calculado com o voucher já travado.
--    Fora da trava, duas tentativas poderiam calcular o mesmo n e bater
--    no UNIQUE de attempt_ref.
--
--    Zero linhas retornadas = não pode resgatar (inexistente, já usado,
--    cancelado, vencido, lote cancelado ou já em PROCESSING). A função
--    NÃO diferencia o motivo de propósito: quem chama devolve a mensagem
--    genérica única, e um motivo detalhado aqui viraria oráculo lá.
--
--    SECURITY INVOKER (default): quem chama é o service_role, que já
--    bypassa RLS. Não há razão pra DEFINER.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pv_redeem_claim(p_code text)
RETURNS TABLE (voucher_id uuid, attempt_number int)
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.pv_vouchers v
     SET status = 'PROCESSING'
   WHERE v.code = p_code
     AND v.status = 'EMITIDO'
     AND EXISTS (
       SELECT 1
         FROM public.pv_batches b
        WHERE b.id = v.batch_id
          AND b.status = 'active'
          AND b.expires_at > now()
     )
  RETURNING v.id INTO v_id;

  -- Perdeu a corrida (ou o voucher não estava apto): zero linhas.
  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT v_id,
           (SELECT count(*)::int + 1
              FROM public.pv_redeem_attempts a
             WHERE a.voucher_id = v_id);
END;
$$;

-- Funções nascem com EXECUTE pro PUBLIC. Fechar e liberar só service_role.
REVOKE ALL ON FUNCTION public.pv_redeem_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pv_redeem_claim(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pv_redeem_claim(text) TO service_role;

-- PostgREST cacheia o schema. Normalmente o Supabase recarrega sozinho no
-- DDL; se o RPC responder 404 (PGRST202) depois desta migration:
--     NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- 4) TESTES DE VERIFICAÇÃO  (rodar DEPOIS dos blocos acima)
-- ---------------------------------------------------------------------
-- IMPORTANTE: o SQL Editor roda como 'postgres' (owner/superuser), que
-- BYPASSA RLS. Para provar a trava é preciso virar 'anon' dentro de uma
-- transação (SET LOCAL ROLE) e dar ROLLBACK. Mesmo procedimento dos
-- Briefs 1 e 2.
--
-- Rodar UM BLOCO POR VEZ. Nos testes 1 a 3 o ERRO é o resultado esperado.
--
-- Teste 1 — SELECT das colunas novas como anon:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       SELECT email, cpf, ip_hash, cost_brl FROM public.pv_redeem_attempts;
--     ROLLBACK;
--     -- esperado: ERROR 42501 permission denied for table
--     --  (ou 0 linhas, se quem barrou foi a RLS — as duas passam)
--
-- Teste 2 — INSERT como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       INSERT INTO public.pv_redeem_attempts
--         (voucher_id, attempt_number, product_code, attempt_ref, email)
--       VALUES (gen_random_uuid(), 1, 'RLS-TEST', 'rls-test-a1', 'x@y.com');
--     ROLLBACK;
--     -- esperado: ERROR 42501 (permission denied / violates RLS policy)
--
-- Teste 3 — RPC de claim como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       SELECT * FROM public.pv_redeem_claim('RLBK-QUALQUER01');
--     ROLLBACK;
--     -- esperado: ERROR 42501 permission denied for function
--     -- ESTE É O TESTE QUE MAIS IMPORTA: se anon executar esta função,
--     -- qualquer um na internet flipa voucher alheio pra PROCESSING.
--
-- Teste 4 — o claim é ATÔMICO (como postgres, sem erro).
--     Prova que a segunda chamada NÃO devolve linha. É a barreira
--     anti-duplicação inteira; se as duas devolverem, PARE o deploy.
--     Usa um voucher descartável, criado e apagado no mesmo bloco.
--
--     BEGIN;
--       INSERT INTO public.pv_batches (id, name, partner, expires_at, status)
--       VALUES ('00000000-0000-4000-8000-000000000001',
--               'claim-test', 'claim-test', now() + interval '1 day', 'active');
--       INSERT INTO public.pv_vouchers (code, batch_id, status)
--       VALUES ('CLAIMTEST00001',
--               '00000000-0000-4000-8000-000000000001', 'EMITIDO');
--
--       SELECT 'primeira' AS chamada, count(*) AS linhas
--         FROM public.pv_redeem_claim('CLAIMTEST00001');   -- esperado: 1
--       SELECT 'segunda'  AS chamada, count(*) AS linhas
--         FROM public.pv_redeem_claim('CLAIMTEST00001');   -- esperado: 0
--     ROLLBACK;
--     -- O SQL Editor mostra só o resultado da ÚLTIMA instrução: rode o
--     -- bloco com o primeiro SELECT, anote, depois com o segundo.
--     -- O ROLLBACK desfaz o lote e o voucher de teste — nada persiste.
--
-- Teste 5 — voucher vencido NÃO é reclamável (mesmo bloco, expires_at no
--     passado). Esperado: 0 linhas na primeira chamada.
--
--     BEGIN;
--       INSERT INTO public.pv_batches (id, name, partner, expires_at, status)
--       VALUES ('00000000-0000-4000-8000-000000000002',
--               'claim-test-venc', 'claim-test', now() - interval '1 day', 'active');
--       INSERT INTO public.pv_vouchers (code, batch_id, status)
--       VALUES ('CLAIMTEST00002',
--               '00000000-0000-4000-8000-000000000002', 'EMITIDO');
--       SELECT count(*) AS deve_ser_zero FROM public.pv_redeem_claim('CLAIMTEST00002');
--     ROLLBACK;
--
-- Teste 6 — sanidade das colunas novas (como postgres):
--     SELECT column_name, data_type, is_nullable
--       FROM information_schema.columns
--      WHERE table_schema = 'public' AND table_name = 'pv_redeem_attempts'
--      ORDER BY ordinal_position;
--     -- esperado: as 11 colunas novas presentes, todas YES em is_nullable
--     --  exceto pin_delivered (NOT NULL DEFAULT false).
-- =====================================================================


-- =====================================================================
-- 5) ROLLBACK (Plano B) — descomentar e rodar para desfazer.
--
--    APAGA DADO PESSOAL E TRILHA DE CUSTO junto com as colunas. Se já
--    houver resgate real registrado, exporte antes:
--      SELECT * FROM public.pv_redeem_attempts WHERE lapak_tid IS NOT NULL;
--
--    Nada de DROP TABLE aqui: pv_redeem_attempts é do Brief 1 e continua
--    de pé. O rollback desta migration remove só o que ela adicionou.
-- ---------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS public.pv_redeem_claim(text);
-- DROP INDEX    IF EXISTS public.pv_vouchers_processing_idx;
-- DROP INDEX    IF EXISTS public.pv_redeem_attempts_voucher_id_idx;
-- ALTER TABLE public.pv_redeem_attempts
--   DROP COLUMN IF EXISTS email,
--   DROP COLUMN IF EXISTS cpf,
--   DROP COLUMN IF EXISTS marketing_optin,
--   DROP COLUMN IF EXISTS ip_hash,
--   DROP COLUMN IF EXISTS cost_idr,
--   DROP COLUMN IF EXISTS fx_usd_idr,
--   DROP COLUMN IF EXISTS fx_brl_usd,
--   DROP COLUMN IF EXISTS cost_usd,
--   DROP COLUMN IF EXISTS cost_brl,
--   DROP COLUMN IF EXISTS pin_delivered,
--   DROP COLUMN IF EXISTS last_polled_at;
-- =====================================================================
