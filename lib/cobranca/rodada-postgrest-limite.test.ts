import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ sincronizar: vi.fn(), aplicarRegua: vi.fn() }));
vi.mock("./sincronizar", () => ({ sincronizar: h.sincronizar, aplicarRegua: h.aplicarRegua }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { rodadaDaCobranca } from "./rodada";

/** Servidor falso com o teto de 1.000 linhas: só pagina quem pede ordem total. */
async function rodar(total: number) {
  const orgs = Array.from({ length: total }, (_, i) => `org-${String(i).padStart(5, "0")}`);
  const leituras: Cadeia[] = [];
  const responder = (c: Cadeia): Resposta => {
    if (c.tabela === "cobranca_planos") return { data: [] };
    if (c.tabela === "organizations") return { data: [] };
    leituras.push(c);
    const ordenada = c.passos.some((p) => p.metodo === "order" && p.args[0] === "organization_id");
    // sem ordem, cada página sai numa ordem diferente: é o que o Postgres não promete manter
    const base = ordenada || leituras.length % 2 === 1 ? orgs : [...orgs].reverse();
    const range = c.passos.find((p) => p.metodo === "range")?.args as [number, number] | undefined;
    const [from, to] = range ?? [0, total - 1];
    const fatia = base.slice(from, to + 1).slice(0, 1000);
    return { data: fatia.map((organization_id) => ({ organization_id })) };
  };
  const rpc = (nome: string): Resposta => (nome === "fn_cobranca_reconciliaveis" ? { data: [] } : { data: true });
  await rodadaDaCobranca(bancoFalso(responder, rpc).cliente as never);
  return { chamadas: h.aplicarRegua.mock.calls.map((c) => c[1] as string), leituras, orgs };
}

describe("rodada: a régua passa por toda assinatura, mesmo além de 1.000", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sincronizar.mockResolvedValue({ tipo: "aplicada", acao: "nada" });
    h.aplicarRegua.mockResolvedValue("nada");
  });

  it.each([999, 1000, 1001, 2000])("%i assinaturas: cada organização uma vez, nenhuma de fora", async (total) => {
    const r = await rodar(total);
    expect(new Set(r.chamadas).size).toBe(total);
    expect(r.chamadas).toHaveLength(total);
    expect([...r.chamadas].sort()).toEqual(r.orgs);
  });

  it("toda página da lista pede ordem pela chave primária", async () => {
    const r = await rodar(1001);
    expect(r.leituras.length).toBeGreaterThan(1);
    for (const c of r.leituras) {
      expect(c.passos.some((p) => p.metodo === "order" && p.args[0] === "organization_id")).toBe(true);
    }
  });
});
