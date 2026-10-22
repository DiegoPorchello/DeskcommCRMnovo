// @vitest-environment node
/**
 * "NO MÁXIMO UMA VEZ POR CONTATO" (#2974) — o motor, medido.
 *
 * O defeito: o motor dispara TODA regra que casa em TODO evento que casa. O lead
 * que volta pelo mesmo anúncio recebe a sequência inteira outra vez — várias
 * fotos e textos repetidos na mesma conversa, que parece robô quebrado e ainda
 * aumenta o volume automático no número.
 *
 * O que este arquivo prova, caso a caso:
 *
 *   1. com a opção DESLIGADA o comportamento é o de hoje (roda sempre) — é o
 *      que impede a entrega de mexer com quem não ligou nada;
 *   2. com a opção LIGADA a primeira passagem do contato roda e a segunda NÃO
 *      roda, e a decisão fica REGISTRADA com a razão;
 *   3. um contato DIFERENTE continua rodando;
 *   4. a decisão vem do ESTADO PERSISTIDO: o que barra é a LINHA gravada com
 *      `contact_id`, e não memória do processo — o mesmo motivo faz uma linha
 *      de OUTRO contato não barrar ninguém;
 *   5. FAIL-OPEN quando o evento não tem contato resolvível: a regra segue como
 *      sempre, com `contact_id` nulo na linha.
 *
 * O banco é um dublê mínimo (`from().select()/insert()/update()`, `eq`,
 * `order`, `limit`, `maybeSingle`) que GUARDA o que o motor grava — é assim que
 * a segunda passagem encontra o que a primeira deixou.
 *
 *     pnpm vitest run lib/automation/limite-por-contato-no-motor.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO_A = "22222222-2222-4222-8222-222222222222";
const CONTATO_B = "33333333-3333-4333-8333-333333333333";
const LEAD_A = "44444444-4444-4444-8444-444444444444";
const LEAD_B = "55555555-5555-4555-8555-555555555555";
const REGRA = "77777777-7777-4777-8777-7777777777a1";

const regrasQueRodaram: string[] = [];
registerAction({
  type: "call_webhook",
  async execute(ctx) {
    regrasQueRodaram.push(ctx.ruleId);
    return { type: "call_webhook", status: "success" };
  },
});

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  function consulta(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let limite: number | null = null;
    let inserindo: Linha | null = null;
    let atualizando: Linha | null = null;
    const guardadas = () => tabelas[tabela] ?? [];
    const casadas = () => guardadas().filter((l) => filtros.every(([c, v]) => l[c] === v));
    async function executar() {
      if (inserindo) {
        const linha = { id: `run-${guardadas().length + 1}`, ...inserindo };
        (tabelas[tabela] ??= []).push(linha);
        return { data: [linha], error: null };
      }
      if (atualizando) {
        for (const linha of casadas()) Object.assign(linha, atualizando);
        return { data: casadas(), error: null };
      }
      const linhas = casadas();
      return { data: limite === null ? linhas : linhas.slice(0, limite), error: null };
    }
    const q = {
      select: () => q,
      insert: (linha: Linha) => {
        inserindo = linha;
        return q;
      },
      update: (linha: Linha) => {
        atualizando = linha;
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limite = n;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => {
        const r = await executar();
        const linhas = (r.data ?? []) as Linha[];
        return { data: linhas[0] ?? null, error: null };
      },
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => executar().then(ok),
    };
    return q;
  }
  return { cliente: { from: consulta } as unknown as SupabaseClient, tabelas };
}

function regra(triggerConfig: Record<string, unknown>): Linha {
  return {
    id: REGRA,
    organization_id: ORG,
    trigger_event: "lead.created",
    is_active: true,
    name: "Boas-vindas ao contato novo",
    conditions: [],
    actions: [{ type: "call_webhook", config: { url: "https://exemplo.test/hook" } }],
    trigger_config: triggerConfig,
  };
}

/** O mundo com um lead POR contato (o contato chega pelo lead, não pelo payload). */
function mundo(triggerConfig: Record<string, unknown>, comContato: boolean) {
  return bancoFalso({
    automation_rules: [regra(triggerConfig)],
    crm_leads: [
      { id: LEAD_A, organization_id: ORG, contact_id: comContato ? CONTATO_A : null },
      { id: LEAD_B, organization_id: ORG, contact_id: comContato ? CONTATO_B : null },
    ],
    contacts: [
      { id: CONTATO_A, organization_id: ORG },
      { id: CONTATO_B, organization_id: ORG },
    ],
    automation_rule_runs: [],
  });
}

let evento = 0;
function leadCreated(leadId: string): EventRow {
  evento += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${evento}`,
    organization_id: ORG,
    event_type: "lead.created",
    entity_kind: "crm_lead",
    entity_id: leadId,
    payload: { lead_id: leadId },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function linhasDeExecucao(tabelas: Record<string, Linha[]>, contactId?: string): Linha[] {
  return (tabelas.automation_rule_runs ?? []).filter(
    (l) => contactId === undefined || l.contact_id === contactId,
  );
}

beforeEach(() => {
  regrasQueRodaram.length = 0;
  evento = 0;
});

describe("a opção desligada mantém o comportamento de hoje", () => {
  it("a chave ausente: o mesmo contato roda a regra em toda mensagem", async () => {
    const { cliente, tabelas } = mundo({}, true);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA, REGRA]);
    // Duas execuções gravadas, ambas com o contato — a opção não inventa uma
    // decisão de bloqueio onde ninguém pediu.
    expect(linhasDeExecucao(tabelas).length).toBe(2);
  });

  it("a chave explícita em `false`: idem", async () => {
    const { cliente } = mundo({ uma_vez_por_contato: false }, true);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA, REGRA]);
  });

  it("um valor torto (`\"sim\"`) NÃO liga a opção — ela é lida com `=== true`", async () => {
    const { cliente } = mundo({ uma_vez_por_contato: "sim" }, true);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA, REGRA]);
  });
});

describe("com a opção ligada, o contato roda uma vez só", () => {
  it("⭐ a primeira mensagem roda; a segunda NÃO roda e a decisão fica registrada com a razão", async () => {
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, true);

    const primeira = await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    expect(primeira.status).toBe("ok");
    expect(regrasQueRodaram).toEqual([REGRA]);

    const primeiraLinha = linhasDeExecucao(tabelas)[0]!;
    expect(primeiraLinha.contact_id).toBe(CONTATO_A);
    expect(primeiraLinha.status).toBe("success");

    const segunda = await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    // A AÇÃO não roda de novo...
    expect(regrasQueRodaram, "a segunda mensagem do mesmo contato rodou a ação").toEqual([REGRA]);
    // ...e a decisão não é silêncio: sai uma linha com a razão.
    expect(segunda).toEqual({
      consumer_key: "automation-rules",
      status: "ok",
      detail: "uma_vez_por_contato",
    });
    const bloqueio = linhasDeExecucao(tabelas).at(-1)!;
    expect(bloqueio.rule_id).toBe(REGRA);
    expect(bloqueio.contact_id).toBe(CONTATO_A);
    expect(bloqueio.status).toBe("failed");
    expect(bloqueio.actions_result).toEqual([
      { type: "call_webhook", status: "skipped", error: "uma_vez_por_contato" },
    ]);
  });

  it("o contador da regra não mente: a passagem bloqueada não conta como execução", async () => {
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, true);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(tabelas.automation_rules![0]!.run_count).toBe(1);
  });

  it("⭐ um contato DIFERENTE continua rodando", async () => {
    const { cliente } = mundo({ uma_vez_por_contato: true }, true);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_B));

    expect(regrasQueRodaram).toEqual([REGRA, REGRA]);
  });

  it("⭐ a decisão vem do ESTADO PERSISTIDO, não de memória do processo", async () => {
    // A linha gravada com `contact_id` é o que barra: um banco que JÁ tem a
    // execução de outro processo (worker reiniciado, outro worker, outro
    // evento) bloqueia na primeira passagem desta execução nova.
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, true);
    tabelas.automation_rule_runs!.push({
      id: "run-de-antes",
      organization_id: ORG,
      rule_id: REGRA,
      event_id: null,
      contact_id: CONTATO_A,
      status: "success",
      actions_result: [],
    });

    const r = await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram, "a linha persistida não barrou a execução").toEqual([]);
    expect(r.detail).toBe("uma_vez_por_contato");
  });

  it("uma execução de OUTRO contato não barra este — a chave é o par regra+contato", async () => {
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, true);
    tabelas.automation_rule_runs!.push({
      id: "run-do-outro",
      organization_id: ORG,
      rule_id: REGRA,
      event_id: null,
      contact_id: CONTATO_B,
      status: "success",
      actions_result: [],
    });

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA]);
  });

  it("uma execução de OUTRA regra não barra esta", async () => {
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, true);
    tabelas.automation_rule_runs!.push({
      id: "run-de-outra-regra",
      organization_id: ORG,
      rule_id: "99999999-9999-4999-8999-999999999999",
      event_id: null,
      contact_id: CONTATO_A,
      status: "success",
      actions_result: [],
    });

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA]);
  });
});

describe("FAIL-OPEN quando o evento não tem contato resolvível", () => {
  it("⭐ sem contato no payload nem no lead, a regra segue como sempre — e a linha grava `contact_id` nulo", async () => {
    const { cliente, tabelas } = mundo({ uma_vez_por_contato: true }, false);

    await runAutomationForEvent(cliente, leadCreated(LEAD_A));
    await runAutomationForEvent(cliente, leadCreated(LEAD_A));

    // Calar por falta de leitura esconderia automação legítima.
    expect(regrasQueRodaram).toEqual([REGRA, REGRA]);
    const linhas = linhasDeExecucao(tabelas);
    expect(linhas.length).toBe(2);
    for (const linha of linhas) expect(linha.contact_id).toBeNull();
  });

  it("o contato do PAYLOAD também conta (a conferência não depende do lead)", async () => {
    const { cliente } = mundo({ uma_vez_por_contato: true }, false);
    const comContatoNoPayload = (leadId: string): EventRow => {
      const row = leadCreated(leadId);
      return { ...row, payload: { ...row.payload, contact_id: CONTATO_A } };
    };

    await runAutomationForEvent(cliente, comContatoNoPayload(LEAD_A));
    await runAutomationForEvent(cliente, comContatoNoPayload(LEAD_A));

    expect(regrasQueRodaram).toEqual([REGRA]);
  });
});
