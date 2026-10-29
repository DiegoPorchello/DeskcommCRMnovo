/**
 * DE QUEM É O NÚMERO DESTA CONVERSA — a pergunta que o envio humano faz antes de
 * gravar a mensagem (#3642).
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * Com um número por vendedor (`channel_routing_policies` + os donos em
 * `channel_routing_responsibles`), a conversa tinha o número de UM vendedor e o
 * envio saía sempre pela sessão da conversa. Depois de uma transferência — ou de
 * uma troca de carteira — o vendedor novo respondia pelo WhatsApp do colega: a
 * mensagem saía pelo número do antigo, o cliente recebia a resposta dele ali, e o
 * antigo continuava recebendo as respostas no celular dele.
 *
 * A peça do banco (`fn_conversation_assign`, migration 9032) faz o número SEGUIR
 * o dono na hora da troca. Esta peça fecha o resto: o envio humano confere que
 * quem está escrevendo responde pelo número em que a conversa está. Se não
 * responde, NÃO sai — nunca pelo número de outra pessoa.
 *
 * ─── Por que recusar, e não "usar o número da conversa assim mesmo" ─────────
 *
 * O número da sessão é o telefone de uma PESSOA. Responder por ele é falar com o
 * cliente como se fosse ela, com o WhatsApp dela, e é exatamente o defeito que a
 * issue mediu. Entre recusar com uma frase clara ("esta conversa está no número
 * de outro atendente; transfira para você") e mandar a mensagem pelo celular do
 * colega, recusar é o desfecho honesto — e o único que não vaza.
 *
 * ─── Por que a organização sem roteamento por vendedor não muda ─────────────
 *
 * Sem policy no número (`legacy_unconfigured`) ou com a lista de responsáveis
 * vazia (`restricted_empty`), "de quem é o número" não é uma pergunta que a
 * instalação saiba responder — e o comportamento de sempre (todo mundo usa o
 * número da conversa) continua valendo. É o controle: a regra nova só existe
 * onde o produto já diz que cada vendedor tem o seu número.
 *
 * ─── Leitura ────────────────────────────────────────────────────────────────
 *
 * Sem banco na decisão: `vereditoDoNumero` é pura e recebe o quadro pronto. Quem
 * lê as duas tabelas é `quadroDoNumero`. Falha de leitura vira
 * `leitura: "indisponivel"` e o chamador recusa — o caminho do envio falha
 * FECHADO (a doutrina do `_handler`): um erro transitório não pode reabrir o
 * vazamento em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O atendente não tem número conectado: ele NÃO usa o do colega. */
export const CODIGO_SEM_NUMERO = "atendente_sem_numero_conectado" as const;
/** O atendente tem número próprio, mas esta conversa está no de outro. */
export const CODIGO_NUMERO_DE_OUTRO = "conversa_em_numero_de_outro_atendente" as const;

export type CodigoDoNumero = typeof CODIGO_SEM_NUMERO | typeof CODIGO_NUMERO_DE_OUTRO;

/** O que a decisão precisa saber — já lido, sem banco. */
export interface QuadroDoNumero {
  /** O número da conversa está sob roteamento por vendedor (policy com responsáveis)? */
  roteamentoPorVendedor: boolean;
  /** Quem está enviando responde por esse número? */
  atendenteRespondePelaSessao: boolean;
  /** Quem está enviando tem número próprio no roteamento? */
  atendenteTemNumero: boolean;
}

export type VereditoDoNumero = { ok: true } | { ok: false; codigo: CodigoDoNumero };

/** O quadro de quem não tem o que decidir: instalação sem um número por vendedor. */
const SEM_REGRA_DE_NUMERO: QuadroDoNumero = {
  roteamentoPorVendedor: false,
  atendenteRespondePelaSessao: true,
  atendenteTemNumero: false,
};

/**
 * A resposta, e só ela: pode ou não pode, e por quê.
 *
 * A ordem das perguntas é a regra. `roteamentoPorVendedor` primeiro porque é ela
 * que decide se a regra existe nesta instalação; `atendenteRespondePelaSessao`
 * antes de `atendenteTemNumero` porque o número COMPARTILHADO (a conversa está no
 * número que os dois usam) é o caso legítimo e não pode virar recusa.
 */
export function vereditoDoNumero(quadro: QuadroDoNumero): VereditoDoNumero {
  if (!quadro.roteamentoPorVendedor) return { ok: true };
  if (quadro.atendenteRespondePelaSessao) return { ok: true };
  if (quadro.atendenteTemNumero) return { ok: false, codigo: CODIGO_NUMERO_DE_OUTRO };
  return { ok: false, codigo: CODIGO_SEM_NUMERO };
}

export type LeituraDoNumero =
  | { leitura: "ok"; quadro: QuadroDoNumero }
  | { leitura: "indisponivel" };

export interface QuadroDoNumeroParams {
  organizationId: string;
  /** A sessão da CONVERSA — o número em que ela está hoje. */
  channelSessionId: string | null;
  /** Quem está enviando (o ator humano). */
  userId: string;
}

/**
 * Lê as duas tabelas do roteamento e devolve o quadro da decisão.
 *
 * Duas idas curtas no caso comum (`channel_routing_policies` sem linha = esta
 * instalação não tem um número por vendedor, e a resposta já está dada). A
 * terceira — "ele tem número próprio?" — só acontece quando a conversa está no
 * número de outra pessoa, que é justamente o caso em que a frase do erro precisa
 * ser a certa.
 */
export async function quadroDoNumero(
  db: SupabaseClient,
  p: QuadroDoNumeroParams,
): Promise<LeituraDoNumero> {
  if (!p.channelSessionId) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };

  const { data: policy, error: erroDaPolicy } = await db
    .from("channel_routing_policies")
    .select("id")
    .eq("organization_id", p.organizationId)
    .eq("channel_session_id", p.channelSessionId)
    .maybeSingle();
  if (erroDaPolicy) return { leitura: "indisponivel" };

  // Sem policy no número: a instalação não separa números por vendedor. Nada a
  // decidir, e nada muda no envio.
  if (!policy) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };

  const { data: responsaveis, error: erroDosResponsaveis } = await db
    .from("channel_routing_responsibles")
    .select("user_id")
    .eq("organization_id", p.organizationId)
    .eq("policy_id", policy.id);
  if (erroDosResponsaveis) return { leitura: "indisponivel" };

  const lista = (responsaveis ?? []).map((r) => String((r as { user_id: string }).user_id));
  const responde = lista.includes(p.userId);
  // Policy sem responsáveis = número em montagem (ou legado da 0228 sem lista):
  // ninguém responde por ele, então a regra de "número de um vendedor" ainda não
  // vale — o comportamento de sempre continua.
  if (lista.length === 0) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };
  if (responde) {
    return {
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: true, atendenteTemNumero: true },
    };
  }

  const { data: meus, error: erroMeus } = await db
    .from("channel_routing_responsibles")
    .select("policy_id")
    .eq("organization_id", p.organizationId)
    .eq("user_id", p.userId);
  if (erroMeus) return { leitura: "indisponivel" };

  return {
    leitura: "ok",
    quadro: {
      roteamentoPorVendedor: true,
      atendenteRespondePelaSessao: false,
      atendenteTemNumero: (meus ?? []).length > 0,
    },
  };
}

/** A frase do erro, no idioma de quem está atendendo. */
export const MENSAGEM_DO_NUMERO: Record<CodigoDoNumero, string> = {
  [CODIGO_SEM_NUMERO]:
    "Você não tem um número de WhatsApp conectado. Esta conversa está no número de outro atendente e não pode ser respondida por ele — peça a quem administra a Central de Conexões para conectar o seu.",
  [CODIGO_NUMERO_DE_OUTRO]:
    "Esta conversa está no número de outro atendente. Transfira a conversa para você para responder por aqui.",
};
