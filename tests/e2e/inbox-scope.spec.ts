/**
 * G4-02 — Inbox com escopo (acceptance 1, 3, 4). Smoke com 2 papéis reais do seed:
 *  - agent (org em modo default own_and_unassigned): NÃO vê a visão 'Todas';
 *  - manager: vê 'Todas' (org-wide read).
 * + deep-link para conversa fora do escopo → estado vazio claro, sem stack trace.
 *
 * Pré-requisito: `.e2e-creds.json` (o rbac-roles.spec já roda o seed; aqui só lê).
 */
import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

interface E2ECreds {
  org_id: string;
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), "loop/checkpoints/evidence/G4");

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * A SEGUNDA ORGANIZAÇÃO, criada aqui e apagada no fim.
 *
 * Não se pega emprestada a sobra de outra spec: `signup-journey` cria uma org
 * sem limpeza, e depender dela faria este caso medir uma coisa diferente a cada
 * rodada — ou passar por acidente numa ordem e falhar noutra.
 */
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const SUFIXO = randomUUID().slice(0, 8);
const NOME_DO_CONTATO_ALHEIO = `Contato de outra empresa ${SUFIXO}`;
let orgAlheia = "";
let conversaDeOutraOrg = "";

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

test.beforeAll(async () => {
  orgAlheia = await insere("organizations", {
    slug: `outra-empresa-${SUFIXO}`,
    legal_name: `Outra Empresa ${SUFIXO} LTDA`,
    display_name: `Outra Empresa ${SUFIXO}`,
  });
  const canal = await insere("channel_sessions", {
    organization_id: orgAlheia,
    waha_session_name: `escopo-${SUFIXO}`,
    display_name: `Canal alheio ${SUFIXO}`,
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const contato = await insere("contacts", {
    organization_id: orgAlheia,
    name: NOME_DO_CONTATO_ALHEIO,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
  });
  conversaDeOutraOrg = await insere("conversations", {
    organization_id: orgAlheia,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    last_message_at: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  // A organização cascateia o resto; apagá-la é o que impede esta spec de
  // deixar inquilino solto para as partes seguintes do job.
  if (orgAlheia) {
    const { error } = await db.from("organizations").delete().eq("id", orgAlheia);
    if (error) throw new Error("Não foi possível limpar a organização da prova de escopo.");
  }
});

test.describe("G4-02 — inbox com escopo", () => {
  test("mídia mantém o escopo da organização, inclusive na reprodução AAC", async ({ page }) => {
    test.setTimeout(60_000);
    const agent = creds.users.agent!;
    const sessao = createClient(credenciais.url, credenciais.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const marcador = randomUUID();
    const bytesA = Buffer.from(`midia-sintetica-a-${marcador}`);
    const bytesB = Buffer.from(`midia-sintetica-b-${marcador}`);
    const caminhos: string[] = [];
    let canal = "";
    let contato = "";
    let conversa = "";
    let mensagem = "";

    try {
      const acesso = await sessao.auth.signInWithPassword({ email: agent.email, password: creds.password });
      expect(acesso.error).toBeNull();
      expect(acesso.data.user?.id).toBe(agent.id);
      const outraConversa = await sessao.from("conversations").select("id").eq("id", conversaDeOutraOrg);
      expect(outraConversa.error).toBeNull();
      expect(outraConversa.data).toEqual([]);

      canal = await insere("channel_sessions", {
        organization_id: creds.org_id,
        waha_session_name: `midia-escopo-${marcador}`,
        display_name: "Canal da prova de mídia",
        status: "WORKING",
        webhook_secret_encrypted: "\\x00",
      });
      contato = await insere("contacts", {
        organization_id: creds.org_id,
        display_name: "Contato da prova de mídia",
      });
      conversa = await insere("conversations", {
        organization_id: creds.org_id,
        contact_id: contato,
        channel_session_id: canal,
        assigned_to_user_id: agent.id,
        status: "open",
      });
      const caminhoA = `${creds.org_id}/${conversa}/${marcador}.ogg`;
      const caminhoB = `${orgAlheia}/${conversaDeOutraOrg}/${marcador}.ogg`;
      caminhos.push(caminhoA, caminhoB);
      for (const [caminho, bytes] of [[caminhoA, bytesA], [caminhoB, bytesB]] as const) {
        const { error } = await db.storage.from("whatsapp-media").upload(caminho, bytes, {
          contentType: "audio/ogg",
          upsert: false,
        });
        expect(error, "os objetos sintéticos precisam existir").toBeNull();
      }
      const controleB = await db.storage.from("whatsapp-media").download(caminhoB);
      expect(controleB.error).toBeNull();
      expect(Buffer.from(await controleB.data!.arrayBuffer())).toEqual(bytesB);

      mensagem = await insere("messages", {
        organization_id: creds.org_id,
        contact_id: contato,
        conversation_id: conversa,
        channel_session_id: canal,
        direction: "outbound",
        type: "audio",
        status: "sent",
        sent_via: "user",
        sent_by_user_id: agent.id,
        media_mime: "audio/ogg",
        media_size_bytes: bytesA.length,
        media_storage_path: caminhoA,
      });
      const leitura = await sessao.from("messages")
        .select("id, organization_id, media_storage_path")
        .eq("id", mensagem)
        .eq("organization_id", creds.org_id)
        .single();
      expect(leitura.error).toBeNull();
      expect(leitura.data).toEqual({
        id: mensagem,
        organization_id: creds.org_id,
        media_storage_path: caminhoA,
      });

      await login(page, agent.email);
      const endpoint = `/api/v1/messages/${mensagem}/media`;
      const conferirA = async () => {
        const resposta = await page.request.get(endpoint, { maxRedirects: 0 });
        expect(resposta.status()).toBe(302);
        const location = resposta.headers().location;
        expect(location).toBeTruthy();
        const arquivo = await page.request.get(location!);
        expect(arquivo.status()).toBe(200);
        expect(await arquivo.body()).toEqual(bytesA);
      };
      await conferirA();

      const trocarCaminho = async (caminho: string) => {
        const alteracao = await sessao.from("messages")
          .update({ media_storage_path: caminho })
          .eq("id", mensagem)
          .eq("organization_id", creds.org_id)
          .select("media_storage_path")
          .single();
        expect(alteracao.error).toBeNull();
        expect(alteracao.data?.media_storage_path).toBe(caminho);
      };
      await trocarCaminho(caminhoB);
      for (const url of [endpoint, `${endpoint}?formato=aac`]) {
        const resposta = await page.request.get(url, { maxRedirects: 0 });
        expect(resposta.status()).toBe(404);
        expect(resposta.headers().location).toBeUndefined();
        expect(await resposta.json()).toMatchObject({
          error: { code: "not_found", message: "Mensagem sem mídia." },
        });
        expect((await resposta.body()).includes(bytesB)).toBe(false);
      }
      await trocarCaminho(caminhoA);
      await conferirA();
    } finally {
      const falhas: string[] = [];
      for (const [tabela, id] of [
        ["messages", mensagem],
        ["conversations", conversa],
        ["contacts", contato],
        ["channel_sessions", canal],
      ] as const) {
        if (!id) continue;
        const { error } = await db.from(tabela).delete().eq("id", id).eq("organization_id", creds.org_id);
        if (error) falhas.push(tabela);
      }
      if (caminhos.length > 0) {
        const { error } = await db.storage.from("whatsapp-media").remove(caminhos);
        if (error) falhas.push("objetos sintéticos");
      }
      const { error } = await sessao.auth.signOut();
      if (error) falhas.push("sessão de teste");
      expect(falhas, "a prova de mídia precisa limpar seus próprios recursos").toEqual([]);
    }
  });

  test("agent em modo own*: vê Minhas e Fila, NÃO vê Todas", async ({ page }) => {
    await login(page, creds.users.agent!.email);
    await page.goto("/app/inbox");
    await expect(page.getByRole("tab", { name: /Minhas/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Fila/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Todas/ })).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCE, "G4-02-inbox-scope-agent.png"), fullPage: true });
  });

  test("manager: vê a visão Todas", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto("/app/inbox");
    await expect(page.getByRole("tab", { name: /Todas/ })).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, "G4-02-inbox-scope-manager.png"), fullPage: true });
  });

  test("deep-link para conversa fora do escopo → estado vazio claro (sem stack trace)", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email);
    // Aquece a rota API autenticada (compile a frio em dev pode passar de 5s).
    await page.request.get("/api/v1/conversations/00000000-0000-4000-8000-0000000000ff");
    // UUID inexistente → RLS/404 → estado vazio claro (GAP D).
    await page.goto("/app/inbox/00000000-0000-4000-8000-0000000000ff");
    await expect(page.getByText(/fora do seu acesso/i)).toBeVisible({ timeout: 15_000 });
  });

  /**
   * ─── OS DOIS CASOS DO #1367 ────────────────────────────────────────────────
   *
   * O caso acima usa um UUID que NÃO EXISTE. Isso deixa duas metades de fora, e
   * as duas foram medidas na issue por LEITURA, não por execução:
   *
   *  1. conversa que EXISTE e é de OUTRA organização. O caminho de código é o
   *     mesmo (mesma consulta, mesmo `null`, mesmo 404) — mas "mesmo caminho" é
   *     inferência, e é esta a propriedade que separa "confunde o usuário" de
   *     "vaza entre empresas". Aqui ela vira execução.
   *  2. id MALFORMADO. `undefined` não é UUID: o `.eq("id", …)` numa coluna
   *     `uuid` fazia o Postgres devolver `22P02`, o handler traduzia QUALQUER
   *     erro de banco para 500, e a tela só sabe reagir a 404 (`isNotFound` é
   *     `status === 404`). Resultado: mensagem nenhuma e uma conversa vazia, que
   *     é indistinguível de "conversa sem mensagens".
   */
  test("deep-link para conversa de OUTRA organização → a mesma mensagem, nunca a conversa", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email);
    await page.request.get(`/api/v1/conversations/${conversaDeOutraOrg}`);
    await page.goto(`/app/inbox/${conversaDeOutraOrg}`);
    await expect(page.getByText(/fora do seu acesso/i)).toBeVisible({ timeout: 15_000 });
    // E nada do outro inquilino pode aparecer: o nome do contato é dado pessoal
    // de uma empresa que não é a desta sessão.
    await expect(page.getByText(NOME_DO_CONTATO_ALHEIO)).toHaveCount(0);
  });

  test("deep-link com id MALFORMADO → a mesma mensagem, não uma conversa vazia", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email);

    // O contrato da rota, preso aqui de propósito: id que não pode identificar
    // conversa nenhuma responde 404 — nunca 500. Sem esta asserção, um conserto
    // que trocasse 500 por 400 deixaria a tela muda do mesmo jeito.
    const resposta = await page.request.get("/api/v1/conversations/undefined");
    expect(resposta.status()).toBe(404);

    await page.goto("/app/inbox/undefined");
    await expect(page.getByText(/fora do seu acesso/i)).toBeVisible({ timeout: 15_000 });
  });
});
