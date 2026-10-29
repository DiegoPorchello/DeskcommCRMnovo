import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVIDERS_DE_TELEFONE, transportaMensagem } from "@/lib/channels/capabilities";
import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";

export interface CanalDoLembrete {
  id: string;
  provider: string | null;
  status: string;
  archived_at: string | null;
  metadata?: { disabled?: boolean } | null;
  lastInboundAt: string | null;
}

export type MotivoSemRemetente =
  | "falha_ao_ler_remetente"
  | "conversa_do_compromisso_invalida"
  | "canal_indicado_indisponivel"
  | "canal_fora_da_janela_24h"
  | "sem_canal"
  | "remetente_ambiguo";
export type RemetenteDoLembrete =
  { canal: CanalDoLembrete; motivo: null } | { canal: null; motivo: MotivoSemRemetente };

/** Um vínculo é autoridade, não preferência: indisponível nunca libera outro número. */
export function decidirRemetenteDoLembrete(
  canais: CanalDoLembrete[],
  canalIndicadoId: string | null,
  agora: Date,
  telefoneDoContato?: unknown,
): RemetenteDoLembrete {
  const operante = (c: CanalDoLembrete) =>
    c.status === "WORKING" &&
    !c.archived_at &&
    c.metadata?.disabled !== true &&
    transportaMensagem(c.provider);
  if (canalIndicadoId) {
    const canal = canais.find((c) => c.id === canalIndicadoId);
    if (!canal || !operante(canal)) return { canal: null, motivo: "canal_indicado_indisponivel" };
    return canalAceitaTextoLivreAgora(canal.provider, canal.lastInboundAt, agora)
      ? { canal, motivo: null }
      : { canal: null, motivo: "canal_fora_da_janela_24h" };
  }

  // #2594: preferir o canal do próprio contato — WhatsApp (canal de telefone)
  // primeiro quando houver telefone. Sem telefone, cai para o canal disponível
  // (social/outro). Quando o filtro não reduz a lista (ou o telefone não foi
  // informado), preserva o comportamento anterior (ambíguo com >1 elegível).
  const telefone = normalizarTelefoneDoContato(telefoneDoContato);
  const filtrarPorTelefone = telefone !== undefined;
  let base = canais;
  if (filtrarPorTelefone) {
    const temTelefone = telefone !== null;
    const alcancaveis = canais.filter((c) => {
      const deTelefone = (PROVIDERS_DE_TELEFONE as readonly string[]).includes(
        c.provider ?? "",
      );
      return temTelefone ? deTelefone : !deTelefone;
    });
    if (alcancaveis.length > 0) base = alcancaveis;
  }
  const candidatos = base
    .filter(operante)
    .filter((c) => canalAceitaTextoLivreAgora(c.provider, c.lastInboundAt, agora));
  if (candidatos.length > 1) return { canal: null, motivo: "remetente_ambiguo" };
  const unico = candidatos[0];
  if (candidatos.length === 1 && unico) return { canal: unico, motivo: null };
  return { canal: null, motivo: canais.some(operante) ? "canal_fora_da_janela_24h" : "sem_canal" };
}

/** Leitura sempre recortada à organização E ao contato da reserva. Falha não é ausência. */
export async function resolverRemetenteDoLembrete(
  admin: SupabaseClient,
  compromisso: { organization_id: string; contact_id: string; conversation_id?: string | null },
  canalDoTipoId: string | null,
  agora: Date,
): Promise<RemetenteDoLembrete> {
  const org = compromisso.organization_id;
  let indicado = canalDoTipoId;
  if (!indicado && compromisso.conversation_id) {
    const { data, error } = await admin
      .from("conversations")
      .select("channel_session_id")
      .eq("id", compromisso.conversation_id)
      .eq("organization_id", org)
      .eq("contact_id", compromisso.contact_id)
      .maybeSingle();
    if (error) return { canal: null, motivo: "falha_ao_ler_remetente" };
    if (!data?.channel_session_id)
      return { canal: null, motivo: "conversa_do_compromisso_invalida" };
    indicado = data.channel_session_id;
  }
  // #2594: telefone do contato, para preferir canal de telefone (WhatsApp).
  let telefoneDoContato: string | null = null;
  {
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("id", compromisso.contact_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (erroContato) return { canal: null, motivo: "falha_ao_ler_remetente" };
    if (contato?.phone_number) telefoneDoContato = contato.phone_number;
  }
  // O automático lê os candidatos e confere a contagem total: uma lista
  // truncada não pode provar que só existe um remetente.
  let query = admin
    .from("channel_sessions")
    .select("id, provider, status, archived_at, metadata", { count: "exact" })
    .eq("organization_id", org);
  if (indicado) query = query.eq("id", indicado);
  else query = query.eq("status", "WORKING").is("archived_at", null);
  const { data, error, count } = await query;
  if (error) return { canal: null, motivo: "falha_ao_ler_remetente" };
  // PostgREST pode cortar por max_rows. Lista parcial nunca prova remetente único.
  if (!indicado && count != null && count > (data?.length ?? 0)) {
    return { canal: null, motivo: "remetente_ambiguo" };
  }
  const canais: CanalDoLembrete[] = (data ?? []).map((c) => ({ ...c, lastInboundAt: null }));
  const restritos = canais.filter(
    (c) => transportaMensagem(c.provider) && !canalAceitaTextoLivreAgora(c.provider, null, agora),
  );
  if (restritos.length) {
    const { data: conversas, error: erro } = await admin
      .from("conversations")
      .select("channel_session_id, last_inbound_at")
      .eq("organization_id", org)
      .eq("contact_id", compromisso.contact_id)
      .in(
        "channel_session_id",
        restritos.map((c) => c.id),
      );
    if (erro) return { canal: null, motivo: "falha_ao_ler_remetente" };
    for (const conversa of conversas ?? []) {
      const canal = canais.find((c) => c.id === conversa.channel_session_id);
      if (
        canal &&
        conversa.last_inbound_at &&
        (!canal.lastInboundAt || conversa.last_inbound_at > canal.lastInboundAt)
      ) {
        canal.lastInboundAt = conversa.last_inbound_at;
      }
    }
  }
  return decidirRemetenteDoLembrete(canais, indicado, agora, telefoneDoContato);
}

/** Normaliza o telefone do contato vindo de várias formas (string, objeto, boolean). */
function normalizarTelefoneDoContato(valor: unknown): string | null | undefined {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor === "boolean") return valor ? "x" : null;
  if (typeof valor === "string") return valor.trim() ? valor.trim() : null;
  if (typeof valor === "object") {
    const v = valor as Record<string, unknown>;
    const candidato =
      v.telefoneDoContato ??
      v.telefone ??
      v.phone ??
      v.phone_number ??
      (typeof v.contato === "object" && v.contato
        ? (v.contato as Record<string, unknown>).phone_number
        : undefined) ??
      (typeof v.contact === "object" && v.contact
        ? (v.contact as Record<string, unknown>).phone_number
        : undefined);
    if (candidato === undefined) {
      if (v.hasPhone !== undefined) return v.hasPhone ? "x" : null;
      if (v.has_phone !== undefined) return v.has_phone ? "x" : null;
      return undefined;
    }
    if (candidato === null) return null;
    const s = String(candidato).trim();
    return s ? s : null;
  }
  return undefined;
}

/** Alias histórico usado por testes da issue #2594. */
export const escolherCanalDoLembrete = decidirRemetenteDoLembrete;
