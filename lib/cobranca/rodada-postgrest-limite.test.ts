import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ sincronizar: vi.fn(), aplicarRegua: vi.fn() }));
vi.mock("./sincronizar", () => ({ sincronizar: h.sincronizar, aplicarRegua: h.aplicarRegua }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { rodadaDaCobranca } from "./rodada";

const TOTAL = 1001;
const orgs = Array.from({ length: TOTAL }, (_, i) => `org-${i}`);

describe("rodada: régua alcança a 1.001ª organização", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sincronizar.mockResolvedValue({ tipo: "aplicada", acao: "nada" });
    h.aplicarRegua.mockResolvedValue("nada");
  });

  it("1.001 assinaturas: a última organização entra no passo da régua", async () => {
    const responder = (c: Cadeia): Resposta => {
      if (c.tabela === "cobranca_planos") return { data: [] };
      if (c.tabela === "organizations") return { data: [] };
      // distingue a query do teto (com in plano_id)
      if (c.passos.some((p) => p.metodo === "in" && p.args[0] === "plano_id")) return { data: [] };
      const range = c.passos.find((p) => p.metodo === "range")?.args as [number, number] | undefined;
      const from = range?.[0] ?? 0;
      const to = range?.[1] ?? (TOTAL - 1);
      const pedaco = orgs.slice(from, to + 1).slice(0, 1000);
      return { data: pedaco.map((organization_id) => ({ organization_id })) };
    };
    const rpc = (nome: string): Resposta => {
      if (nome === "fn_cobranca_reconciliaveis") return { data: [] };
      return { data: true };
    };
    const banco = bancoFalso(responder, rpc);
    const resumo = await rodadaDaCobranca(banco.cliente as never);
    const chamadas = h.aplicarRegua.mock.calls.map((c) => c[1]);
    expect(chamadas).toContain(`org-${TOTAL - 1}`);
    expect(chamadas).toHaveLength(TOTAL);
  });
});
