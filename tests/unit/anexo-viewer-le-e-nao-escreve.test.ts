// @vitest-environment node
/**
 * O CAMPO DE ARQUIVO DO NEGÓCIO, DOS DOIS LADOS — issues #3431 e #3433.
 *
 * ─── #3431: quem só lê (viewer) ──────────────────────────────────────────────
 *
 * O `FileUploadCustomField` aparece travado para o `viewer`, mas busca a lista de
 * anexos assim mesmo — é ela que dá a contagem e o link do documento. Enquanto os
 * `GET` da rota de anexos pediam `agent`, a resposta era 403 `forbidden_role`, o
 * componente mostrava "Não foi possível carregar os anexos." e o cabeçalho dizia
 * "0 arquivos" — um zero FALSO, com o arquivo existindo no Storage.
 *
 * Ler o anexo é ler o negócio. A escrita não: subir e apagar continuam `agent`.
 * E nada disso pode abrir a porta entre organizações — o anexo de outra empresa
 * continua 404, e a mídia dela não é assinada.
 *
 * ─── #3433: a criação ────────────────────────────────────────────────────────
 *
 * O anexo mora em `crm_lead_attachments.lead_id`: só existe DEPOIS do negócio.
 * Cobrar o campo `file` na criação era um deadlock — nem anexar antes (o negócio
 * não nasceu), nem criar sem o anexo (422 `required_fields_missing`, sempre).
 * A régua ganhou `semAnexosAinda`, que a criação passa e o move NÃO passa: o
 * documento volta a ser exigido na movimentação, onde há como prová-lo.
 *
 * ─── A tabela de casos ──────────────────────────────────────────────────────
 *
 * A1  viewer lê a lista e a contagem certa (não "0 arquivos")
 * A2  viewer abre a mídia do anexo (302 para o link assinado)
 * A3  CONTROLE — viewer NÃO sobe arquivo (403, e nada vai ao Storage)
 * A4  CONTROLE — viewer NÃO apaga (403, e o anexo continua na tabela)
 * A5  CONTROLE — agent continua lendo a lista
 * A6  CONTROLE — agent continua apagando
 * A7  ISOLAMENTO — lead de outra organização: 404, não 200 e não 403
 * A8  ISOLAMENTO — mídia de outra organização: 404 e NENHUM link assinado
 * B1  criação numa etapa que exige arquivo: CRIA (era 422 sem saída)
 * B2  CONTROLE — campo de TEXTO exigido e vazio continua recusando na criação
 * B3  texto + arquivo na mesma etapa: a recusa da criação cita SÓ o de texto
 * C1  CONTROLE — mover para a etapa exigente sem anexo: 422, nada gravado
 * C2  mover para a etapa exigente COM o anexo no negócio: 200 e a etapa muda
 *
 * ─── A ROTA EM SI — o que ela não pode fazer ───────────────────────────────
 *
 * R1  a lista respeita o `field_key` pedido — dois campos, um pedido, um arquivo
 * R2  a lista não devolve linha de OUTRA organização, ainda que o `lead_id` case
 * R3  POST sem arquivo é 422, e nada vai ao Storage
 * R4  POST com formato fora da lista aceita é 415 (PDF e imagem, só)
 * R5  POST numa chave que não é campo de arquivo do NEGÓCIO é 422
 * R6  mídia com caminho fora do prefixo do negócio é 404 — e nada é assinado
 * R7  DELETE de anexo de OUTRA organização é 404, e nada é removido
 * R8  POST válido (agent, PDF) grava o anexo e devolve a lista já atualizada
 *
 * Sabotagem prevista antes de medir, em
 * `cache/scratch/previsao-sabotagem-3431.md`: devolver o `GET` para `agent`
 * derruba A1 e A7; devolver o arquivo à lista de obrigatórios da criação
 * derruba B1 e B3.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLE_RANK, type Role } from "@/lib/auth/types";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "99999999-9999-4999-8999-999999999999";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_A = "66666666-6666-4666-8666-666666666666";
const ETAPA_X = "77777777-7777-4777-8777-777777777777";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ANEXO = "88888888-8888-4888-8888-888888888888";
const USER = "55555555-5555-4555-8555-555555555555";
const CAMINHO = `${ORG_A}/leads/${LEAD}/comprovante/${ANEXO}.pdf`;
const ANEXO_ALHEIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARREGADO = "2026-10-24T10:00:00.000Z";
const CAMINHO_FORA = `outra-pasta/${LEAD}/comprovante/${ANEXO}.pdf`;

/** O funil da rota: dois campos de arquivo e um de texto, nada exigido. */
const SETTINGS_DA_ROTA = {
  fields: [
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [] } },
    { key: "laudo", label: "Laudo", type: "file" },
    { key: "concorrente", label: "Concorrente", type: "text" },
  ],
};

/** O funil que exige o ARQUIVO para receber o negócio na etapa X. */
const EXIGE_ARQUIVO = {
  fields: [
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA_X] } },
  ],
};

/** O mesmo, com um campo de TEXTO exigido junto — o controle do recorte. */
const EXIGE_TEXTO_E_ARQUIVO = {
  fields: [
    { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [ETAPA_X] } },
    { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA_X] } },
  ],
};

interface Resultado {
  data: unknown;
  error: { message: string } | null;
}

const h = vi.hoisted(() => {
  const db: Record<string, Record<string, unknown>[]> = {};
  const upload = vi.fn();
  const remove = vi.fn();
  const assinar = vi.fn();
  const audit = vi.fn();
  const atividade = vi.fn();
  const patches: Record<string, unknown>[] = [];

  /**
   * Consulta encadeável que APLICA os `eq`/`in` vistos. Sem isso, uma rota que
   * esquecesse o `organization_id` passaria neste arquivo por construção — e o
   * teste estaria mentindo a favor do produto, justo no caso A7/A8, que é o de
   * vazamento entre organizações.
   */
  function consulta(tabela: string) {
    const filtros: ((linha: Record<string, unknown>) => boolean)[] = [];
    const executa = (): Resultado => ({
      data: (db[tabela] ?? []).filter((linha) => filtros.every((filtro) => filtro(linha))),
      error: null,
    });
    const primeira = async (): Promise<Resultado> => {
      const linhas = executa().data as Record<string, unknown>[];
      return { data: linhas[0] ?? null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((linha) => linha[coluna] === valor);
        return b;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push((linha) => (valores as unknown[]).includes(linha[coluna]));
        return b;
      },
      update: (patch: Record<string, unknown>) => {
        patches.push(patch);
        return b;
      },
      delete: () => b,
      insert: (linha: Record<string, unknown>) => {
        const comId = { created_at: CARREGADO, ...linha };
        db[tabela] = [...(db[tabela] ?? []), comId];
        b.__inserida = comId;
        return b;
      },
      maybeSingle: primeira,
      single: async (): Promise<Resultado> => {
        const inserida = b.__inserida as Record<string, unknown> | undefined;
        return inserida ? { data: inserida, error: null } : primeira();
      },
      then: (ok: (r: Resultado) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(executa()).then(ok, falha),
    };
    return b;
  }

  return { db, consulta, upload, remove, assinar, audit, atividade, patches };
});

/** O papel de quem está na sessão — muda por caso, como muda na vida real. */
let papelDaSessao: Role = "viewer";
/** A organização de quem está na sessão. */
let orgDaSessao = ORG_A;

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (minimo: Role) => {
    if (ROLE_RANK[papelDaSessao] < ROLE_RANK[minimo]) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return {
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: orgDaSessao, name: "Org", role: papelDaSessao },
    };
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: h.consulta, rpc: () => Promise.resolve({ error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: h.consulta,
    rpc: () => Promise.resolve({ error: null }),
    storage: { from: () => ({ upload: h.upload, remove: h.remove, createSignedUrl: h.assinar }) },
  }),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: h.atividade,
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { DELETE, GET, POST } from "@/app/api/v1/leads/[id]/attachments/route";
import { GET as GET_MIDIA } from "@/app/api/v1/leads/[id]/attachments/[attachmentId]/media/route";
import { POST as MOVER } from "@/app/api/v1/leads/[id]/move/route";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";

const ctxDoNegocio = { params: Promise.resolve({ id: LEAD }) };
const ctxDaMidia = { params: Promise.resolve({ id: LEAD, attachmentId: ANEXO }) };

const pedido = (metodo: string) =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: metodo });

const moverPedido = (etapa: string) =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move`, {
    method: "POST",
    body: JSON.stringify({
      stage_id: etapa,
      position_in_stage: 2000,
      expected_updated_at: CARREGADO,
    }),
    headers: { "content-type": "application/json" },
  });

const listaComFiltro = (query = "") =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments${query}`, { method: "GET" });

function uploadPedido(campos: { file?: File | null; field_key?: string }) {
  const form = new FormData();
  if (campos.field_key) form.set("field_key", campos.field_key);
  if (campos.file) form.set("file", campos.file);
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, {
    method: "POST",
    body: form,
  });
}

function apagarPedido(attachmentId: string, fieldKey = "comprovante") {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, {
    method: "DELETE",
    body: JSON.stringify({ field_key: fieldKey, attachment_id: attachmentId }),
    headers: { "content-type": "application/json" },
  });
}

const ctxDoHandler = { organization_id: ORG_A, actor: { type: "user" as const, id: USER }, requestId: "req-1" };

const payloadDaCriacao = {
  pipeline_id: FUNIL,
  stage_id: ETAPA_X,
  title: "Negócio numa etapa que pede documento",
  tags: [],
  source: "manual",
};

/** O negócio, o anexo e o funil de cada cenário. Cada teste diz o que NÃO quer. */
function semear(opcoes: { anexos?: Record<string, unknown>[]; settings?: unknown } = {}) {
  for (const chave of Object.keys(h.db)) delete h.db[chave];
  h.db.crm_leads = [
    {
      id: LEAD,
      organization_id: ORG_A,
      pipeline_id: FUNIL,
      stage_id: ETAPA_A,
      status: "open",
      contact_id: null,
      updated_at: CARREGADO,
      custom_fields: {},
      won_reason: null,
    },
  ];
  h.db.crm_stages = [
    { id: ETAPA_A, pipeline_id: FUNIL, organization_id: ORG_A, name: "Entrada", is_won: false, is_lost: false },
    { id: ETAPA_X, pipeline_id: FUNIL, organization_id: ORG_A, name: "Documentação", is_won: false, is_lost: false },
  ];
  h.db.crm_pipelines = [{ id: FUNIL, organization_id: ORG_A, settings: opcoes.settings ?? EXIGE_ARQUIVO }];
  h.db.organizations = [{ id: ORG_A, currency: "BRL" }];
  h.db.crm_lead_attachments = opcoes.anexos ?? [
    {
      id: ANEXO,
      organization_id: ORG_A,
      lead_id: LEAD,
      field_key: "comprovante",
      file_name: "contrato.pdf",
      file_size: 1024,
      mime_type: "application/pdf",
      storage_path: CAMINHO,
      created_at: CARREGADO,
    },
  ];
}

beforeEach(() => {
  papelDaSessao = "viewer";
  orgDaSessao = ORG_A;
  semear();
  h.patches.length = 0;
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.remove.mockReset().mockResolvedValue({ error: null });
  h.assinar
    .mockReset()
    .mockResolvedValue({ data: { signedUrl: "https://storage.local/assinado" }, error: null });
  h.audit.mockReset().mockResolvedValue(undefined);
  h.atividade.mockReset().mockResolvedValue({ ok: true });
});

describe("#3431 — quem só lê lê o anexo do negócio", () => {
  it("A1: viewer recebe a LISTA e a contagem certa — não '0 arquivos'", async () => {
    const res = await GET(pedido("GET"), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string; name: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]).toMatchObject({ id: ANEXO, name: "contrato.pdf" });
  });

  it("A2: viewer ABRE a mídia do anexo — 302 para o link assinado", async () => {
    const res = await GET_MIDIA(pedido("GET"), ctxDaMidia);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.local/assinado");
    expect(h.assinar).toHaveBeenCalledTimes(1);
  });

  it("A3: CONTROLE — viewer NÃO sobe arquivo, e nada chega ao Storage", async () => {
    const res = await POST(pedido("POST"), ctxDoNegocio);

    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("forbidden_role");
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("A4: CONTROLE — viewer NÃO apaga, e o anexo continua na tabela", async () => {
    const res = await DELETE(pedido("DELETE"), ctxDoNegocio);

    expect(res.status).toBe(403);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments).toHaveLength(1);
  });

  it("A5: CONTROLE — agent continua lendo a lista", async () => {
    papelDaSessao = "agent";

    const res = await GET(pedido("GET"), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: unknown[] } };
    expect(corpo.data?.files).toHaveLength(1);
  });

  it("A6: CONTROLE — agent continua apagando", async () => {
    papelDaSessao = "agent";
    const pedidoDeApagar = new NextRequest(
      `http://localhost/api/v1/leads/${LEAD}/attachments`,
      {
        method: "DELETE",
        body: JSON.stringify({ field_key: "comprovante", attachment_id: ANEXO }),
        headers: { "content-type": "application/json" },
      },
    );

    const res = await DELETE(pedidoDeApagar, ctxDoNegocio);

    expect(res.status).toBe(200);
    expect(h.remove).toHaveBeenCalledTimes(1);
  });

  it("A7: ISOLAMENTO — lead de outra organização responde 404 (nem 200, nem 403)", async () => {
    orgDaSessao = ORG_B;

    const res = await GET(pedido("GET"), ctxDoNegocio);

    expect(res.status).toBe(404);
    const corpo = (await res.json()) as { data?: { files?: unknown[] } };
    expect(corpo.data?.files).toBeUndefined();
  });

  it("A8: ISOLAMENTO — mídia de outra organização responde 404 e não assina nada", async () => {
    orgDaSessao = ORG_B;

    const res = await GET_MIDIA(pedido("GET"), ctxDaMidia);

    expect(res.status).toBe(404);
    expect(h.assinar).not.toHaveBeenCalled();
  });
});

describe("#3433 — a criação não cobra o arquivo; o move cobra", () => {
  it("B1: cria direto na etapa que exige o arquivo (era 422 sem saída)", async () => {
    semear({ settings: EXIGE_ARQUIVO });

    await createLeadHandler(
      { from: h.consulta, rpc: () => Promise.resolve({ error: null }) } as never,
      ctxDoHandler,
      payloadDaCriacao,
    );

    const criados = (h.db.crm_leads ?? []).filter((linha) => linha.title === payloadDaCriacao.title);
    expect(criados).toHaveLength(1);
    expect(criados[0]).toMatchObject({ stage_id: ETAPA_X });
  });

  it("B2: CONTROLE — campo de TEXTO exigido e vazio continua recusando a criação", async () => {
    semear({ settings: EXIGE_TEXTO_E_ARQUIVO });

    const erro = await createLeadHandler(
      { from: h.consulta, rpc: () => Promise.resolve({ error: null }) } as never,
      ctxDoHandler,
      payloadDaCriacao,
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "required_fields_missing",
      details: { faltando: [{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" }] },
    });
  });

  it("B3: texto E arquivo exigidos — a recusa da criação cita SÓ o de texto", async () => {
    semear({ settings: EXIGE_TEXTO_E_ARQUIVO });

    const erro = await createLeadHandler(
      { from: h.consulta, rpc: () => Promise.resolve({ error: null }) } as never,
      ctxDoHandler,
      payloadDaCriacao,
    ).catch((e: unknown) => e);

    const detalhes = (erro as { details: { faltando: { chave: string; tipo?: string }[] } }).details;
    expect(detalhes.faltando.map((campo) => campo.chave)).toEqual(["concorrente"]);
    expect(detalhes.faltando.some((campo) => campo.tipo === "file")).toBe(false);
  });

  it("C1: CONTROLE — mover para a etapa exigente SEM anexo: 422, e nada é gravado", async () => {
    papelDaSessao = "agent";
    semear({ anexos: [] });

    const res = await MOVER(moverPedido(ETAPA_X), ctxDoNegocio);

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error?: { code?: string; details?: { faltando?: { chave: string; tipo?: string }[] } };
    };
    expect(corpo.error?.code).toBe("required_fields_missing");
    expect(corpo.error?.details?.faltando).toEqual([
      { chave: "comprovante", rotulo: "Comprovante", tipo: "file" },
    ]);
    // A recusa veio ANTES da escrita: nenhum patch de etapa saiu.
    expect(h.patches.some((patch) => patch.stage_id === ETAPA_X)).toBe(false);
  });

  it("C2: mover para a etapa exigente COM o anexo no negócio: passa e a etapa muda", async () => {
    papelDaSessao = "agent";
    semear();

    const res = await MOVER(moverPedido(ETAPA_X), ctxDoNegocio);

    expect(res.status).toBe(200);
    expect(h.patches[0]).toMatchObject({ stage_id: ETAPA_X });
  });
});

describe("a rota — o que ela não pode fazer (#3431)", () => {
  it("R1: com dois campos, o `field_key` pedido devolve só o anexo dele", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });
    h.db.crm_lead_attachments = [
      ...(h.db.crm_lead_attachments ?? []),
      {
        id: ANEXO_ALHEIO,
        organization_id: ORG_A,
        lead_id: LEAD,
        field_key: "laudo",
        file_name: "laudo.pdf",
        file_size: 2048,
        mime_type: "application/pdf",
        storage_path: CAMINHO,
        created_at: CARREGADO,
      },
    ];

    const res = await GET(listaComFiltro("?field_key=comprovante"), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]?.id).toBe(ANEXO);
  });

  it("R2: anexo de OUTRA organização, com o mesmo lead_id, não entra na lista", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });
    h.db.crm_lead_attachments = [
      ...(h.db.crm_lead_attachments ?? []),
      {
        id: ANEXO_ALHEIO,
        organization_id: ORG_B,
        lead_id: LEAD,
        field_key: "comprovante",
        file_name: "intruso.pdf",
        file_size: 10,
        mime_type: "application/pdf",
        storage_path: CAMINHO,
        created_at: CARREGADO,
      },
    ];

    const res = await GET(listaComFiltro(), ctxDoNegocio);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string; name: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]?.name).toBe("contrato.pdf");
  });

  it("R3: POST sem arquivo é 422 e nada vai ao Storage", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(uploadPedido({ field_key: "comprovante" }), ctxDoNegocio);

    expect(res.status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("R4: formato fora da lista é 415 (PDF e imagem, só)", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(
      uploadPedido({
        field_key: "comprovante",
        file: new File(["conteudo"], "planilha.csv", { type: "text/csv" }),
      }),
      ctxDoNegocio,
    );

    expect(res.status).toBe(415);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("R5: chave que não é campo de ARQUIVO do negócio é 422", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(
      uploadPedido({
        field_key: "concorrente",
        file: new File(["conteudo"], "contrato.pdf", { type: "application/pdf" }),
      }),
      ctxDoNegocio,
    );

    expect(res.status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("R6: mídia com caminho fora do prefixo do negócio é 404 e não assina", async () => {
    semear({ settings: SETTINGS_DA_ROTA });
    const [anexo] = h.db.crm_lead_attachments ?? [];
    h.db.crm_lead_attachments = [{ ...anexo, storage_path: CAMINHO_FORA }];

    const res = await GET_MIDIA(listaComFiltro(), ctxDaMidia);

    expect(res.status).toBe(404);
    expect(h.assinar).not.toHaveBeenCalled();
  });

  it("R7: DELETE de anexo de OUTRA organização é 404 e nada é removido", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });
    const [anexo] = h.db.crm_lead_attachments ?? [];
    h.db.crm_lead_attachments = [{ ...anexo, id: ANEXO_ALHEIO, organization_id: ORG_B }];

    const res = await DELETE(apagarPedido(ANEXO_ALHEIO), ctxDoNegocio);

    expect(res.status).toBe(404);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments).toHaveLength(1);
  });

  it("R8: PDF válido grava o anexo e devolve a lista já atualizada", async () => {
    papelDaSessao = "agent";
    semear({ settings: SETTINGS_DA_ROTA });

    const res = await POST(
      uploadPedido({
        field_key: "comprovante",
        file: new File(["%PDF-1.4"], "novo.pdf", { type: "application/pdf" }),
      }),
      ctxDoNegocio,
    );

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as {
      data?: { attachment?: { name: string }; files?: { name: string }[] };
    };
    expect(corpo.data?.attachment?.name).toBe("novo.pdf");
    expect(corpo.data?.files).toHaveLength(2);
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
});
