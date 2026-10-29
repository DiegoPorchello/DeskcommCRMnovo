/**
 * #3642 — o NÚMERO segue o vendedor: a troca de dono leva a conversa para o
 * número do vendedor novo.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * Numa empresa com um número por vendedor, `fn_conversation_assign` (a porta
 * única de escrita da atribuição: Transferir um e em lote, Assumir, MCP,
 * automação) trocava só `assigned_to_user_id`. A conversa continuava com o
 * `channel_session_id` do vendedor ANTERIOR, e o envio sai pela sessão da
 * conversa — o vendedor novo respondia pelo WhatsApp do colega.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * 1. Transferir de A para B (cada um com o seu número) grava a sessão de B na
 *    conversa, e zera `provider_conversation_id` (a thread do number antigo não
 *    viaja).
 * 2. Número COMPARTILHADO (os dois na lista de responsáveis do mesmo número):
 *    nada muda — é o caso legítimo.
 * 3. Dono novo SEM número conectado: nada muda (a transferência não falha; quem
 *    recusa, com erro claro, é o ENVIO humano — `lib/channels/numero-do-atendente.ts`).
 * 4. Organização sem roteamento por vendedor (número sem policy): nada muda.
 * 5. O contato já tem conversa no número do vendedor novo: o dono muda e o
 *    número não (re-apontar estouraria `uniq_conversations_1to1_per_contact_session`
 *    e a transferência inteira falharia).
 * 6. A troca de CARTEIRA (`fn_definir_carteira_do_cliente`) leva as conversas
 *    abertas do dono anterior ao novo dono, pela mesma porta — e o número junto.
 * 7. A carteira NÃO rouba conversa que já é de outra pessoa.
 *
 * Organização própria (namespace `ffffffff-`) para não encostar nas governanças
 * que rodam no mesmo banco.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "ffffffff-0000-4000-8000-000000000001";
const VENDEDOR_A = "ffffffff-1111-4000-8000-000000000001"; // número A, dono original
const VENDEDOR_B = "ffffffff-1111-4000-8000-000000000002"; // número B
const VENDEDOR_C = "ffffffff-1111-4000-8000-000000000003"; // divide o número A
const SEM_NUMERO = "ffffffff-1111-4000-8000-000000000004"; // nenhum número conectado
const GESTOR = "ffffffff-1111-4000-8000-000000000005"; // manager (só ele muda carteira)

const SESSAO_A = "ffffffff-2222-4000-8000-000000000001";
const SESSAO_B = "ffffffff-2222-4000-8000-000000000002";
const SESSAO_SEM_POLICY = "ffffffff-2222-4000-8000-000000000003";

const POLITICA_A = "ffffffff-3333-4000-8000-000000000001";
const POLITICA_B = "ffffffff-3333-4000-8000-000000000002";

const CONTATO = "ffffffff-4444-4000-8000-000000000001";
const CONTATO_DA_CARTEIRA = "ffffffff-4444-4000-8000-000000000002";
const CONTATO_DO_COLEGA = "ffffffff-4444-4000-8000-000000000003";

/** Chama a RPC como a rota chama: `service_role`. */
function transfere(conversa: string, para: string | null, motivo = "transfer"): void {
  sql(`
    set role service_role;
    select public.fn_conversation_assign(
      '${ORG}', '${conversa}', ${para ? `'${para}'` : "null"}, '${motivo}');
  `);
}

/** A carteira, pela porta da ficha (`service_role`, ator explícito). */
function defineCarteira(contato: string, dono: string): void {
  sql(`
    set role service_role;
    select public.fn_definir_carteira_do_cliente('${ORG}', '${GESTOR}', '${contato}', '${dono}', 'manual');
  `);
}

function sessaoDe(conversa: string): string {
  return lastLine(
    sql(`select channel_session_id::text from public.conversations where id = '${conversa}';`),
  );
}

function donoDe(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'NULL') from public.conversations where id = '${conversa}';`),
  );
}

/** Uma conversa nova por caso, para um caso não contaminar o outro. */
function conversaNova(id: string, contato: string, sessao: string, dono: string | null): string {
  sql(`
    delete from public.conversations where id = '${id}';
    -- Um contato por conversa e por sessão (0027): o caso anterior desta suíte
    -- pode ter deixado uma no mesmo par.
    delete from public.conversations
     where organization_id = '${ORG}' and contact_id = '${contato}' and channel_session_id = '${sessao}';
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, provider_conversation_id)
    values ('${id}', '${ORG}', '${contato}', '${sessao}', 'claimed',
            ${dono ? `'${dono}'` : "null"}, 'thread-do-numero-antigo');
  `);
  return id;
}

describe("#3642 — a conversa segue o número do vendedor novo", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${VENDEDOR_A}', 'numero-a@invariant.test'),
        ('${VENDEDOR_B}', 'numero-b@invariant.test'),
        ('${VENDEDOR_C}', 'numero-c@invariant.test'),
        ('${SEM_NUMERO}', 'numero-sem@invariant.test'),
        ('${GESTOR}', 'numero-gestor@invariant.test')
      on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'numero-do-vendedor-inv', 'Numero Invariant Org', 'Numero Inv')
        on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${VENDEDOR_A}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_B}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_C}', '${ORG}', 'agent', now()),
        ('${SEM_NUMERO}', '${ORG}', 'agent', now()),
        ('${GESTOR}', '${ORG}', 'manager', now())
      on conflict (user_id, organization_id) do update
        set role = excluded.role, revoked_at = null, accepted_at = now();

      -- Três números: A e B com policy própria; o terceiro sem policy (legado).
      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name)
      values
        ('${SESSAO_A}', '${ORG}', 'waha', 'numero-inv-a', '\\x00'::bytea, 'WORKING', 'Numero A'),
        ('${SESSAO_B}', '${ORG}', 'waha', 'numero-inv-b', '\\x00'::bytea, 'WORKING', 'Numero B'),
        ('${SESSAO_SEM_POLICY}', '${ORG}', 'waha', 'numero-inv-legado', '\\x00'::bytea, 'WORKING', 'Numero Legado')
      on conflict (id) do update
        set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

      insert into public.channel_routing_policies (id, organization_id, channel_session_id) values
        ('${POLITICA_A}', '${ORG}', '${SESSAO_A}'),
        ('${POLITICA_B}', '${ORG}', '${SESSAO_B}')
      on conflict (id) do nothing;

      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
        ('${ORG}', '${POLITICA_A}', '${VENDEDOR_A}'),
        ('${ORG}', '${POLITICA_A}', '${VENDEDOR_C}'),  -- número COMPARTILHADO
        ('${ORG}', '${POLITICA_B}', '${VENDEDOR_B}')
      on conflict do nothing;

      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO}', '${ORG}', 'Contato Numero'),
        ('${CONTATO_DA_CARTEIRA}', '${ORG}', 'Contato Carteira'),
        ('${CONTATO_DO_COLEGA}', '${ORG}', 'Contato Do Colega')
      on conflict (id) do update
        set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null;
    `);
  });

  afterAll(() => {
    sql(`
      delete from public.conversations where organization_id = '${ORG}';
      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      delete from public.channel_routing_policies where organization_id = '${ORG}';
      delete from public.channel_sessions where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id in
        ('${VENDEDOR_A}', '${VENDEDOR_B}', '${VENDEDOR_C}', '${SEM_NUMERO}', '${GESTOR}');
    `);
  });

  it("transferir de A para B (cada um com o seu número) leva a conversa para o número de B", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000001", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);
    // A thread do número antigo não viaja: ela pertence ao número anterior.
    expect(
      lastLine(
        sql(`select coalesce(provider_conversation_id, 'NULL') from public.conversations where id = '${conversa}';`),
      ),
    ).toBe("NULL");
  });

  it("número COMPARTILHADO: transferir para quem já responde por ele mantém o número", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000002", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_C);

    expect(donoDe(conversa)).toBe(VENDEDOR_C);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });

  it("dono novo SEM número conectado: a transferência acontece e o número fica (quem recusa é o envio)", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000003", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, SEM_NUMERO);

    expect(donoDe(conversa)).toBe(SEM_NUMERO);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });

  it("organização sem roteamento por vendedor (número sem policy): nada muda — controle", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000004", CONTATO, SESSAO_SEM_POLICY, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_SEM_POLICY);
  });

  it("o contato já tem conversa no número do vendedor novo: o dono muda e o número não", () => {
    // A conversa anterior do contato NO NÚMERO DE B é o que impede o re-apontamento.
    const jaExiste = conversaNova(
      "ffffffff-5555-4000-8000-000000000005", CONTATO, SESSAO_B, null);
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000006", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
    // E a conversa que já estava lá não foi tocada.
    expect(sessaoDe(jaExiste)).toBe(SESSAO_B);
  });

  it("trocar a CARTEIRA leva as conversas abertas do dono anterior para o novo — e o número junto", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000007", CONTATO_DA_CARTEIRA, SESSAO_A, VENDEDOR_A);
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DA_CARTEIRA}';`);

    defineCarteira(CONTATO_DA_CARTEIRA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);
  });

  it("a carteira NÃO rouba a conversa que já é de outra pessoa", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000008", CONTATO_DO_COLEGA, SESSAO_A, VENDEDOR_C);
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DO_COLEGA}';`);

    defineCarteira(CONTATO_DO_COLEGA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_C);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });
});
