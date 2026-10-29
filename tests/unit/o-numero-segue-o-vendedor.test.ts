/**
 * #3642 — o número segue o vendedor: quem responde por esta conversa?
 *
 * O defeito medido: com um número por vendedor, a conversa continuava no
 * `channel_session_id` do vendedor ANTERIOR depois de uma transferência, e o
 * vendedor novo respondia pelo WhatsApp do colega (a mensagem saía pelo número do
 * antigo e a resposta do cliente ia para o celular dele).
 *
 * Duas peças fecham isso, e este arquivo prova a de TypeScript:
 *
 *  - `vereditoDoNumero` (pura): pode enviar? Se não, com qual frase.
 *  - `quadroDoNumero` (leitura): o que as duas tabelas do roteamento dizem sobre o
 *    número desta conversa e sobre quem está escrevendo.
 *
 * O lado do banco (o número acompanhar a troca de dono) é provado em
 * `tests/invariants/o-numero-segue-o-vendedor.test.ts` — aqui não há Postgres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  CODIGO_NUMERO_DE_OUTRO,
  CODIGO_SEM_NUMERO,
  MENSAGEM_DO_NUMERO,
  quadroDoNumero,
  vereditoDoNumero,
  type QuadroDoNumero,
} from "@/lib/channels/numero-do-atendente";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "22222222-2222-4222-8222-222222222222";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const COLEGA = "44444444-4444-4444-8444-444444444444";
const POLITICA = "55555555-5555-4555-8555-555555555555";

// ─── Banco falso (só as duas tabelas do roteamento) ──────────────────────────
type Linha = Record<string, unknown>;

/**
 * Duas tabelas com a cadeia exata que `quadroDoNumero` encadeia
 * (`select`/`eq`/`eq`/`maybeSingle` ou `await`). A leitura é a única coisa falsa:
 * a decisão é a de verdade, e é ela que o teste mede.
 */
function bancoFalso(opcoes: {
  policies: Linha[];
  responsibles: Linha[];
  erroEm?: "channel_routing_policies" | "channel_routing_responsibles";
}) {
  const tabelas: Record<string, Linha[]> = {
    channel_routing_policies: opcoes.policies,
    channel_routing_responsibles: opcoes.responsibles,
  };

  const from = (nome: string) => {
    const linhas = tabelas[nome] ?? [];
    const filtros: Array<[string, unknown]> = [];
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (filtros.push([c, v]), b);
    const ler = () => {
      if (opcoes.erroEm === nome) return { data: null, error: { message: "indisponivel" } };
      return { data: linhas.filter(casa), error: null };
    };
    b.maybeSingle = async () => {
      const r = ler();
      if (r.error) return r;
      return { data: r.data[0] ?? null, error: null };
    };
    b.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
      Promise.resolve(ler()).then(ok, erro);
    return b;
  };

  return { from } as unknown as SupabaseClient;
}

const LEITURA = { organizationId: ORG, channelSessionId: SESSAO, userId: ATENDENTE };

describe("#3642 — a decisão: quem responde por este número pode enviar?", () => {
  it("organização sem um número por vendedor: libera (controle — nada muda)", () => {
    const quadro: QuadroDoNumero = {
      roteamentoPorVendedor: false,
      atendenteRespondePelaSessao: false,
      atendenteTemNumero: false,
    };
    expect(vereditoDoNumero(quadro)).toEqual({ ok: true });
  });

  it("quem responde por este número envia (inclusive no número COMPARTILHADO)", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: true,
        atendenteTemNumero: true,
      }),
    ).toEqual({ ok: true });
  });

  it("vendedor com número próprio NÃO responde pela conversa que está no número do colega", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: false,
        atendenteTemNumero: true,
      }),
    ).toEqual({ ok: false, codigo: CODIGO_NUMERO_DE_OUTRO });
  });

  it("vendedor SEM número conectado é recusado — nunca pelo número do colega", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: false,
        atendenteTemNumero: false,
      }),
    ).toEqual({ ok: false, codigo: CODIGO_SEM_NUMERO });
  });

  it("as duas recusas têm frase no idioma de quem atende (e nenhuma promete o número alheio)", () => {
    for (const codigo of [CODIGO_SEM_NUMERO, CODIGO_NUMERO_DE_OUTRO]) {
      expect(MENSAGEM_DO_NUMERO[codigo]).toMatch(/número de outro atendente/);
    }
    expect(MENSAGEM_DO_NUMERO[CODIGO_SEM_NUMERO]).toMatch(/não tem um número/);
    expect(MENSAGEM_DO_NUMERO[CODIGO_NUMERO_DE_OUTRO]).toMatch(/Transfira a conversa para você/);
  });
});

describe("#3642 — a leitura do roteamento (quadroDoNumero)", () => {
  it("número sem policy: a instalação não separa números por vendedor", async () => {
    const db = bancoFalso({ policies: [], responsibles: [] });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("conversa sem sessão: não há número a conferir", async () => {
    const db = bancoFalso({ policies: [], responsibles: [] });
    const r = await quadroDoNumero(db, { ...LEITURA, channelSessionId: null });
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("policy com responsáveis: quem está na lista responde pelo número", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [
        { policy_id: POLITICA, user_id: ATENDENTE, organization_id: ORG },
        { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
      ],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: true, atendenteTemNumero: true },
    });
  });

  it("fora da lista, com número próprio em outra policy: o número é de OUTRO", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [
        { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
        { policy_id: "outra-policy", user_id: ATENDENTE, organization_id: ORG },
      ],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero: true },
    });
  });

  it("fora da lista e sem número nenhum: SEM número conectado", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [{ policy_id: POLITICA, user_id: COLEGA, organization_id: ORG }],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero: false },
    });
  });

  it("policy sem responsáveis (número em montagem): a regra ainda não vale", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("leitura que falha NÃO libera: o caminho do envio falha fechado", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
      erroEm: "channel_routing_policies",
    });
    expect(await quadroDoNumero(db, LEITURA)).toEqual({ leitura: "indisponivel" });
  });

  it("leitura dos responsáveis que falha também não libera", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
      erroEm: "channel_routing_responsibles",
    });
    expect(await quadroDoNumero(db, LEITURA)).toEqual({ leitura: "indisponivel" });
  });
});
