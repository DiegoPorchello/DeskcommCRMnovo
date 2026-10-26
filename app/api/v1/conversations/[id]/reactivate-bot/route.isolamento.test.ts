/**
 * reactivate-bot — ISOLAMENTO POR ORGANIZAÇÃO (#3436).
 *
 * Diferente de `route.dono.test.ts` (que mede a REGRA da rota com a função
 * mockada), aqui roda a rota REAL e a função REAL (`devolverAtendimentoAoAgente`)
 * sobre um dublê que só devolve a linha quando TODOS os filtros batem —
 * `organization_id` inclusive. Dois tenants semeados:
 *
 *   - o `agent` do tenant B chama a rota com a conversa do tenant A → 404, e a
 *     conversa do A continua exatamente como estava (dono, `assignee_kind`,
 *     silêncio) e nenhuma RPC de atribuição é chamada;
 *   - o `agent` do tenant A na própria conversa → 200, com a devolução escrita
 *     de verdade (é o CONTROLE: sem ele, um teste que sempre devolve 404
 *     passaria por "isolamento").
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * Apagar `.eq("organization_id", organizationId)` da leitura da conversa em
 * `lib/escalacao/retomada.ts` (o primeiro `select` de `conversations`) deixa o
 * caso cross-tenant VERMELHO: o dublê passa a devolver a conversa do A e a rota
 * responde 409 ("Alguém assumiu esta conversa agora") em vez de 404, além de
 * chamar `fn_conversation_assign` com o id da conversa de outro tenant.
 *
 * O que este arquivo NÃO mede: RLS (não há Postgres aqui) e a atomicidade da
 * `fn_conversation_assign` — o dublê reproduz o contrato dela (casa `id` E
 * `organization_id`; sem linha, retorna vazio sem erro).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_A = "aaaaaaaa-3333-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-3333-4000-8000-00000000000b";
const CONV_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const CONTATO_A = "aaaaaaaa-5555-4000-8000-00000000000a";
const SILENCIO_A = "2026-10-20T12:00:00.000Z";

type Linha = Record<string, unknown>;

function linhaDe(linhas: Linha[], id: string): Linha {
  const achada = linhas.find((l) => l.id === id);
  if (!achada) throw new Error(`dublê sem a linha ${id}`);
  return achada;
}

interface Estado {
  tabelas: Record<string, Linha[]>;
  /** Toda RPC chamada, na ordem — é assim que se prova quem tentou escrever. */
  rpcs: Array<{ nome: string; params: Linha }>;
  /** As atribuições que a `fn_conversation_assign` do dublê efetivamente aplicou. */
  escritasDeComando: Linha[];
}

/**
 * Dublê com PREDICADO (molde das rotas irmãs: `transfer/route.test.ts`): a linha
 * só aparece quando TODO filtro bate, `organization_id` inclusive. `thenable`
 * porque a função escreve tanto por `.maybeSingle()` quanto por `await builder`
 * direto (ex.: `restaurarTrava`).
 */
function clienteFalso(estado: Estado) {
  function builder(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    let inserida: Linha | null = null;
    const linhas = () => (estado.tabelas[tabela] ??= []);
    const aplica = () => {
      const alvos = linhas().filter((l) => filtros.every((f) => f(l)));
      if (patch) for (const l of alvos) Object.assign(l, patch);
      return alvos;
    };
    const q = {
      select: () => q,
      update: (v: Linha) => {
        patch = v;
        return q;
      },
      insert: (v: Linha) => {
        inserida = v;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push((l) => l[c] === v);
        return q;
      },
      is: (c: string, v: unknown) => {
        filtros.push((l) => (l[c] ?? null) === v);
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        filtros.push((l) => vs.includes(l[c]));
        return q;
      },
      order: () => q,
      limit: () => q,
      range: () => q,
      maybeSingle: async () => {
        if (inserida) {
          const row = { ...inserida };
          linhas().push(row);
          return { data: row, error: null };
        }
        return { data: aplica()[0] ?? null, error: null };
      },
      single: async () => {
        if (inserida) {
          const row = { ...inserida };
          linhas().push(row);
          return { data: row, error: null };
        }
        const alvo = aplica()[0];
        if (!alvo) throw new Error(`dublê: nenhuma linha em ${tabela}`);
        return { data: alvo, error: null };
      },
      then: (
        comOk: (v: unknown) => unknown,
        comErro: (e: unknown) => unknown,
      ) => {
        if (inserida) {
          const row = { ...inserida };
          linhas().push(row);
          return Promise.resolve({ data: row, error: null }).then(comOk, comErro);
        }
        return Promise.resolve({ data: aplica(), error: null }).then(comOk, comErro);
      },
    };
    return q;
  }

  return {
    from: builder,
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      if (nome === "fn_conversation_assign") {
        // Contrato da função do banco: casa `id` E `organization_id`; sem linha,
        // retorna vazio sem erro (migration 0667).
        const conv = (estado.tabelas.conversations ?? []).find(
          (c) => c.id === params.p_conversation_id && c.organization_id === params.p_organization_id,
        );
        if (!conv) return { data: [], error: null };
        estado.escritasDeComando.push({ ...params });
        conv.assigned_to_user_id = (params.p_to_user_id as string | null) ?? null;
        conv.assignee_kind = params.p_to_user_id ? "user" : null;
        return { data: [conv], error: null };
      }
      return { data: null, error: null };
    },
  };
}

/** Sessão mutável por teste (hoisted: nasce antes dos imports). */
const sess = vi.hoisted(() => ({ orgId: "", role: "agent", userId: "" }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: sess.userId, idioma: "pt-BR" },
    org: { orgId: sess.orgId, role: sess.role },
  })),
}));

let estado: Estado;

function semear(opcoes: { dono: string | null } = { dono: USER_A }) {
  estado = {
    tabelas: {
      conversations: [
        {
          id: CONV_A,
          organization_id: ORG_A,
          contact_id: CONTATO_A,
          status: "open",
          // `assignee_kind='user'` exige dono (CHECK 0032); sem dono, a conversa
          // já está com a IA.
          assigned_to_user_id: opcoes.dono,
          assignee_kind: opcoes.dono ? "user" : "ai",
          bot_silenced_until: opcoes.dono ? SILENCIO_A : null,
          last_handoff_at: opcoes.dono ? SILENCIO_A : null,
        },
      ],
      contacts: [
        { id: CONTATO_A, organization_id: ORG_A, ai_opt_out: false, force_human: opcoes.dono !== null },
      ],
    },
    rpcs: [],
    escritasDeComando: [],
  };
  vi.mocked(createClient).mockResolvedValue(clienteFalso(estado) as unknown as SupabaseClient);
}

function chamarComo(org: string, userId: string, role = "agent") {
  sess.orgId = org;
  sess.userId = userId;
  sess.role = role;
  return POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONV_A}/reactivate-bot`, { method: "POST" }),
    { params: Promise.resolve({ id: CONV_A }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sess.orgId = "";
  sess.userId = "";
  sess.role = "agent";
  semear();
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
});

describe("reactivate-bot — a conversa de outro tenant não existe para mim (#3436)", () => {
  it("agent do tenant B na conversa do tenant A: 404 e NADA é escrito", async () => {
    const antes = { ...linhaDe(estado.tabelas.conversations!, CONV_A) };

    const res = await chamarComo(ORG_B, USER_B);
    const corpo = await res.json();

    expect(res.status).toBe(404);
    expect(corpo.error.code).toBe("not_found");
    // A linha do outro tenant fica byte a byte como estava.
    expect(linhaDe(estado.tabelas.conversations!, CONV_A)).toEqual(antes);
    expect(linhaDe(estado.tabelas.conversations!, CONV_A)).toMatchObject({
      organization_id: ORG_A,
      assigned_to_user_id: USER_A,
      assignee_kind: "user",
      bot_silenced_until: SILENCIO_A,
    });
    // Nem a RPC de atribuição nem o sinal de devolução foram chamados.
    expect(estado.rpcs).toHaveLength(0);
    expect(estado.escritasDeComando).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("agent do tenant B na conversa SEM dono do tenant A: 404 igual (não é o dono que barra)", async () => {
    semear({ dono: null });

    const res = await chamarComo(ORG_B, USER_B);

    expect(res.status).toBe(404);
    expect(linhaDe(estado.tabelas.conversations!, CONV_A)).toMatchObject({
      organization_id: ORG_A,
      assigned_to_user_id: null,
      assignee_kind: "ai",
    });
    expect(estado.rpcs).toHaveLength(0);
  });

  it("CONTROLE: agent do tenant A na própria conversa devolve de verdade (200)", async () => {
    semear({ dono: null });

    const res = await chamarComo(ORG_A, USER_A);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.reactivated).toBe(true);
    expect(linhaDe(estado.tabelas.conversations!, CONV_A)).toMatchObject({
      organization_id: ORG_A,
      assignee_kind: "ai",
      status: "ai_handling",
      bot_silenced_until: null,
    });
    // A trava dura do contato caiu (é o defeito que `retomada.ts` consertou).
    expect((estado.tabelas.contacts ?? []).find((c) => c.id === CONTATO_A)?.force_human).toBe(false);
    expect(estado.rpcs.map((r) => r.nome)).toContain("emit_event");
    const evento = estado.rpcs.find((r) => r.nome === "emit_event");
    expect(evento?.params.p_payload).toMatchObject({ conversation_id: CONV_A, organization_id: ORG_A });
  });

  it("CONTROLE: agent do tenant A na conversa do COLEGA (mesma org) também não devolve", async () => {
    // Depende da regra da rota, não do filtro de org: prova que os dois
    // invariantes convivem.
    semear({ dono: USER_A });

    const res = await chamarComo(ORG_A, "aaaaaaaa-9999-4000-8000-00000000000a");

    expect(res.status).toBe(403);
    expect(linhaDe(estado.tabelas.conversations!, CONV_A)).toMatchObject({
      assigned_to_user_id: USER_A,
      assignee_kind: "user",
    });
    expect(estado.escritasDeComando).toHaveLength(0);
  });
});
