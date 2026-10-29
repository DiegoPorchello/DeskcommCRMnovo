/**
 * O PAINEL DIZ QUAL VETO BARROU A SUGESTÃO (issue #2975).
 *
 * O rascunho assistido guarda só o CÓDIGO do primeiro impedimento da prévia
 * (`ai_reply_drafts.error_code`); a frase que o veto carregava morre no
 * servidor. Antes, o estado `failed` mostrava a MESMA frase genérica para
 * todos os vetos — de "o contato está descadastrado" a "a janela de 24h
 * fechou" —, e quem atende não tinha como saber o caso nem o que fazer.
 *
 * Os casos cobrem as três pontas: código conhecido mostra a causa; código
 * ausente ou desconhecido mantém o genérico (que continua verdadeiro); e o
 * CONTROLE garante que a causa não vaza para um rascunho que não falhou.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: deps.get, post: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { ReplyReviewPanel } from "./ReplyReviewPanel";

const GENERICA = "Confira a configuração do agente e tente gerar novamente.";
const REESCRITA = /A primeira versão desta resposta foi barrada/;

const draft = (extra: Record<string, unknown> = {}) => ({
  id: "d1",
  revision: "1",
  status: "failed",
  original_body: null,
  edited_body: null,
  error_code: null,
  proposals: [],
  ...extra,
});

function montar(drafts: unknown[]) {
  deps.get.mockResolvedValue({ data: { drafts } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReplyReviewPanel conversationId="c1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o painel diz QUAL veto barrou a sugestão (issue #2975)", () => {
  it("⭐ failed com código conhecido mostra a causa, não a frase genérica", async () => {
    montar([draft({ error_code: "messaging_window_closed" })]);

    expect(await screen.findByText(/janela de 24 horas/)).toBeTruthy();
    expect(screen.queryByText(GENERICA)).toBeNull();
  });

  it("failed SEM código mantém o texto de sempre", async () => {
    montar([draft({ error_code: null })]);

    expect(await screen.findByText(GENERICA)).toBeTruthy();
  });

  it("failed com código DESCONHECIDO também cai no texto de sempre", async () => {
    montar([draft({ error_code: "veto_novo_sem_par" })]);

    expect(await screen.findByText(GENERICA)).toBeTruthy();
  });

  /**
   * UM CASO POR FAMÍLIA — inclusive a conferência de afirmação de fato (#2231),
   * que é de onde a issue nasceu (triagem do #2959).
   *
   * O caso do ⭐ acima prova que o painel USA o mapa; estes provam que o mapa,
   * lido pela tela, devolve a frase da FAMÍLIA CERTA. Sem eles, trocar dois
   * corpos em `motivoDoVeto` passa despercebido: os 24 casos da base ficavam
   * verdes com `factual_claim_contradicted` e `..._unsupported` invertidos.
   *
   * O `naoContem` é o que separa as duas famílias vizinhas (contradição × falta
   * de apoio) e as definitivas das acionáveis: a frase do outro caso não pode
   * aparecer no lugar.
   */
  const FAMILIAS: Array<[string, string, RegExp, RegExp]> = [
    [
      "contato bloqueado (opt-out)",
      "contato_bloqueado",
      /não receber mensagens/,
      /CONTRADIZ|sem apoio/,
    ],
    ["LGPD anonimizado", "lgpd_anonymized", /anonimizado/, /CONTRADIZ|sem apoio/],
    ["janela de 24h fechada", "messaging_window_closed", /janela de 24 horas/, /CONTRADIZ/],
    ["promessa fora da tabela", "promise_out_of_table", /fora da tabela aprovada/, /CONTRADIZ/],
    [
      "#2231 afirmação CONTRADITA",
      "factual_claim_contradicted",
      /CONTRADIZ/,
      /sem apoio no material de referência/,
    ],
    [
      "#2231 afirmação SEM APOIO",
      "factual_claim_unsupported",
      /sem apoio no material de referência/,
      /CONTRADIZ/,
    ],
    ["falha de geração", "generation_failed", /A geração da sugestão falhou/, /CONTRADIZ/],
  ];

  it.each(FAMILIAS)(
    "família %s: o painel mostra a frase dela, e não a da vizinha",
    async (_familia, codigo, contem, naoContem) => {
      montar([draft({ error_code: codigo })]);

      const causa = await screen.findByText(contem);
      expect(causa.textContent).not.toMatch(naoContem);
      expect(screen.queryByText(GENERICA)).toBeNull();
    },
  );

  /**
   * Este caso provava o SILÊNCIO: "pendente" com código gravado não mostrava
   * causa nenhuma. Mudou de propósito (doc de decisão 234, opção A): pendente
   * COM texto e COM código é a reescrita que o agente fez depois de uma barrada
   * na mesma rodada, e quem atende passa a saber disso e do motivo.
   */
  it("pendente com texto e código conta que a primeira versão foi barrada, e por quê", async () => {
    montar([draft({ status: "pending", original_body: "Oi", error_code: "messaging_window_closed" })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    const aviso = screen.getByText(REESCRITA);
    expect(aviso.textContent).toMatch(/janela de 24 horas/);
    expect(screen.queryByText(GENERICA)).toBeNull();
  });
});

describe("a reescrita depois de uma barrada aparece no painel (doc 234, issue #2975)", () => {
  it("⭐ afirmação sem apoio barrada e reescrita: o aviso traz o motivo da família certa", async () => {
    montar([
      draft({
        status: "pending",
        original_body: "Temos o plano anual com desconto.",
        error_code: "factual_claim_unsupported",
      }),
    ]);

    const aviso = await screen.findByText(REESCRITA);
    expect(aviso.textContent).toMatch(/sem apoio no material de referência/);
    expect(aviso.textContent).not.toMatch(/CONTRADIZ/);
    // A sugestão continua oferecida: o aviso informa, não tira o botão.
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeTruthy();
  });

  it("CONTROLE: pendente sem código não mostra aviso nenhum", async () => {
    montar([draft({ status: "pending", original_body: "Oi", error_code: null })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(REESCRITA)).toBeNull();
  });

  it("CONTROLE: pendente só com proposta (decidiu não responder) não fala em reescrita", async () => {
    montar([
      draft({
        status: "pending",
        original_body: "",
        error_code: "no_candidate",
        proposals: [{ tool: "crm_request_human_handoff", arguments: {} }],
      }),
    ]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(REESCRITA)).toBeNull();
  });

  /**
   * `unknown_preview_tool` está no mapa, mas não vem de um envio barrado: a
   * prévia o grava quando o modelo chama uma ferramenta que ela não conhece
   * (`preview.ts`, ramo da ferramenta desconhecida), e o texto que vem depois
   * passou na cadeia sem nenhuma versão recusada. Dizer "a primeira versão foi
   * barrada" ali seria falso, e o motivo mandaria gerar de novo uma sugestão boa.
   */
  it("CONTROLE: ferramenta desconhecida na prévia não é versão barrada", async () => {
    montar([draft({ status: "pending", original_body: "Oi, tudo bem?", error_code: "unknown_preview_tool" })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(REESCRITA)).toBeNull();
    expect(screen.queryByText(/ação que a prévia não reconhece/)).toBeNull();
  });

  it("CONTROLE: código desconhecido em pendente não inventa motivo", async () => {
    montar([draft({ status: "pending", original_body: "Oi", error_code: "veto_novo_sem_par" })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(REESCRITA)).toBeNull();
  });
});
