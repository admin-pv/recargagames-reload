-- =====================================================================
-- Migration: Rate limit do app de resgate (pv_validate_rate) — Brief 2
-- Data: 2026-07-30
-- Objetivo: dar estado ao rate limit do POST /api/validate. As Netlify
--           Functions são stateless, então o contador vive no banco.
--           Uma tabela nova, RLS ligada, ZERO policy: só a Secret key
--           (service_role, que bypassa RLS) toca nela.
--
-- Como rodar: colar este arquivo inteiro no Supabase SQL Editor
--             (instância ashmirzgyuhspymldpfv) e executar.
--             Idempotente — pode ser re-executado sem erro.
--
-- NÃO toca em pv_batches / pv_batch_contents / pv_vouchers /
-- pv_redeem_attempts (Brief 1) nem em bonus_vouchers.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) pv_validate_rate — tentativas por IP por janela
--    ip_hash: SHA-256 de (IP + salt de env var). IP cru NUNCA é gravado.
--    window_start: início da janela de 10 min, truncado (floor) no
--                  servidor — janela fixa, não sliding. Simples e
--                  suficiente pra travar brute force de código.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pv_validate_rate (
  ip_hash      text        NOT NULL,
  window_start timestamptz NOT NULL,
  attempts     int         NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, window_start)
);

-- Índice pro DELETE de limpeza da função abaixo (janelas velhas).
CREATE INDEX IF NOT EXISTS pv_validate_rate_window_idx
  ON public.pv_validate_rate (window_start);


-- ---------------------------------------------------------------------
-- 2) RLS — trancado sem policy nenhuma.
--    Sem policy => default DENY pra anon e authenticated. A Secret key
--    (service_role) tem BYPASSRLS, então o acesso server-side continua.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_validate_rate ENABLE ROW LEVEL SECURITY;

-- Privilégio de tabela explícito (não confiar só no default privilege
-- do schema public). service_role e mais ninguém.
REVOKE ALL ON TABLE public.pv_validate_rate FROM PUBLIC;
REVOKE ALL ON TABLE public.pv_validate_rate FROM anon, authenticated;
GRANT ALL  ON TABLE public.pv_validate_rate TO service_role;


-- ---------------------------------------------------------------------
-- 3) pv_validate_rate_hit() — ADIÇÃO ao schema do brief.
--
--    Por quê: o brief define só a tabela, mas incrementar via PostgREST
--    exigiria ler-depois-escrever (duas chamadas), o que é corrida em
--    concorrência — dois requests simultâneos do mesmo IP leriam o mesmo
--    valor e o contador andaria 1 em vez de 2, furando o limite. Um
--    INSERT ... ON CONFLICT DO UPDATE ... RETURNING resolve atomicamente,
--    e PostgREST não expressa isso — daí a função.
--
--    SECURITY INVOKER (default) de propósito: quem chama é o service_role,
--    que já bypassa RLS. Não há razão pra DEFINER aqui.
--
--    Reversível: remover a função e trocar por read+write na function
--    (aceitando a corrida). Ver §6.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pv_validate_rate_hit(
  p_ip_hash      text,
  p_window_start timestamptz
) RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_attempts int;
BEGIN
  -- Limpeza oportunista: a tabela é efêmera por natureza, nada aqui
  -- precisa sobreviver mais que a janela. Mantém a tabela minúscula
  -- sem precisar de cron/pg_cron.
  DELETE FROM public.pv_validate_rate
   WHERE window_start < now() - interval '1 hour';

  INSERT INTO public.pv_validate_rate (ip_hash, window_start, attempts)
  VALUES (p_ip_hash, p_window_start, 1)
  ON CONFLICT (ip_hash, window_start)
  DO UPDATE SET attempts = public.pv_validate_rate.attempts + 1
  RETURNING attempts INTO v_attempts;

  RETURN v_attempts;
END;
$$;

-- Funções nascem com EXECUTE pro PUBLIC. Fechar e liberar só service_role.
REVOKE ALL ON FUNCTION public.pv_validate_rate_hit(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pv_validate_rate_hit(text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pv_validate_rate_hit(text, timestamptz) TO service_role;

-- PostgREST cacheia o schema. Normalmente o Supabase recarrega sozinho
-- no DDL; se o RPC responder 404 depois de rodar esta migration:
--     NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- 4) TESTES DE VERIFICAÇÃO DA RLS  (rodar DEPOIS de criar a tabela)
-- ---------------------------------------------------------------------
-- IMPORTANTE: o SQL Editor roda como 'postgres' (owner/superuser), que
-- BYPASSA RLS. Para provar a trava é preciso virar 'anon' dentro de uma
-- transação (SET LOCAL ROLE) e dar ROLLBACK. Mesmo procedimento do Brief 1.
--
-- Teste 1 — SELECT como anon deve retornar 0 (deny = vazio, não erro):
--     BEGIN;
--       SET LOCAL ROLE anon;
--       SELECT count(*) AS deve_ser_zero FROM public.pv_validate_rate;
--     ROLLBACK;
--     -- esperado: deve_ser_zero = 0
--     -- (se estourar 42501 'permission denied for table', melhor ainda:
--     --  o REVOKE de privilégio pegou antes da RLS)
--
-- Teste 2 — INSERT como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       INSERT INTO public.pv_validate_rate (ip_hash, window_start)
--       VALUES ('rls-test', now());
--     ROLLBACK;
--     -- esperado: ERROR 42501 (permission denied / violates RLS policy)
--
-- Teste 3 — RPC como anon deve estourar 42501:
--     BEGIN;
--       SET LOCAL ROLE anon;
--       SELECT public.pv_validate_rate_hit('rls-test', now());
--     ROLLBACK;
--     -- esperado: ERROR 42501 permission denied for function
--
-- Teste 4 — sanidade do incremento (como postgres, e limpa depois):
--     SELECT public.pv_validate_rate_hit('smoke-test', date_trunc('hour', now()));  -- 1
--     SELECT public.pv_validate_rate_hit('smoke-test', date_trunc('hour', now()));  -- 2
--     DELETE FROM public.pv_validate_rate WHERE ip_hash = 'smoke-test';
-- =====================================================================


-- =====================================================================
-- 5) ROLLBACK (Plano B) — descomentar e rodar para desfazer tudo.
-- ---------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS public.pv_validate_rate_hit(text, timestamptz);
-- DROP TABLE    IF EXISTS public.pv_validate_rate;
-- =====================================================================
