"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import type { BoardData } from "@/lib/kanban/types";
import { atalhosDoFunil, type AtalhoDoCard } from "@/lib/leads/atalhos-do-card";

/**
 * OS ATALHOS CADASTRADOS NO FUNIL DESTE CARD (issue #3487).
 *
 * ─── Por que ler o cache, e não buscar de novo ─────────────────────────────
 *
 * É o mesmo argumento de `useMotivosDePerdaDoFunil`, e ele vale igual aqui: o
 * quadro já carrega `pipeline.settings` INTEIRO na chave `["board", pipelineId]`,
 * e o dossiê só existe a partir de um card que esse quadro desenhou. Uma chamada
 * nova custaria rede e um estado de carregamento para um dado que a tela tem.
 *
 * Cache frio (dossiê aberto fora do quadro, teste isolado) devolve `[]` — e `[]`
 * é o comportamento de antes da entrega: nenhum botão. Degrada para o antigo,
 * nunca para um erro na cara de quem atende.
 *
 * Quem chama pode passar a lista por prop quando TEM o funil em mão e não está
 * dentro da árvore do quadro (o calendário do funil, por exemplo) — ver o
 * `atalhos` opcional de `LeadDossier`.
 */
export function useAtalhosDoFunil(pipelineId: string): AtalhoDoCard[] {
  const qc = useQueryClient();
  // A MESMA chave de `useBoard`, não uma literal igual: literal igual é igual só
  // até alguém mudar um dos lados, e aí este hook devolve `[]` sem erro nenhum.
  const settings = qc.getQueryData<BoardData>(chaveDoQuadro(pipelineId))?.pipeline?.settings ?? null;
  return useMemo(() => atalhosDoFunil(settings), [settings]);
}
