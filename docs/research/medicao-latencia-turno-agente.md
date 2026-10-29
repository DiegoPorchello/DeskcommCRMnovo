# Medição da latência do turno do agente (#1099)

Esta issue é a medição que autoriza (ou veta) a quarta mudança de latência proposta
no PR #849. **Nenhuma mudança de comportamento de envio foi feita nesta rodada.**

## 1. O que foi medido

O turno do agente (`executarTurnoDoAgente`, `lib/agent-engine/agent/inbound-turn.ts`)
gasta tempo em quatro fases distintas. Pontos de instrumentação já existentes:

| Fase | Onde está no código | Instrumentação existente |
|---|---|---|
| Classificadores auxiliares (estágio + jailbreak + Jev) | `inbound-turn.ts` ~5171 (`Promise.all` de `classifyStage`, `classifyJailbreak`, `perguntaAoJev`) | chamada única; duração não logada hoje — medir envolvendo o `Promise.all` |
| Chamada ao modelo (LLM) | `invokeBot` em `inbound-turn.ts` ~1153-1160 | `latency_ms` devolvido em `BotResponse` e agregado em `llm_calls` |
| Pausa humana (atraso antes da 1ª bolha) | `esperarComoHumano` em `lib/agent-engine/agent/atraso-humano.ts` | log `atraso humano antes da 1ª bolha` com `atraso_ms`; desconta `processamentoMs = performance.now() - inicioDoProcessamento` (#849) |
| Throttle anti-ban entre bolhas/envios | `runBeforeSend` em `lib/agent-engine/guardrails/before-send.ts` ~1621 (`throttleWaitMs`) e `decidePacing` em `lib/agent-engine/pacing/engine.ts` | `waitMs = max(0, throttleMs + jitter - (now - lastSentAt))` |
| Escoamento da fila (lote) | `runDrainLoop` em `lib/agent-engine/edge/crm/drain.ts` ~655 | `drained >= batchSize ? 0 : ...` (lote cheio não espera — já entrou) |

O relógio do turno começa em `inicioDoProcessamento = performance.now()` (linha ~2249) e é
usado para o desconto da pausa humana. O traço do turno (`agent_turn_traces`, via
`registrarTracoDoTurno`) já guarda `latency_ms` agregado por `job_id`.

## 2. Metodologia

1. Coletar, em instalação com carga real de WhatsApp, por **pelo menos 7 dias**:
   - log `turno do agente concluído` + `atraso humano antes da 1ª bolha`;
   - `agent_turn_traces.latency_ms` por turno;
   - `llm_calls.latency_ms` (modelo) e `duracao_ms` de ferramentas no traço.
2. Decompor cada turno em:
   - `T_classif = fim(Promise.all dos classificadores) - início do turno`
   - `T_llm = latency_ms do invokeBot`
   - `T_pausa = atraso_ms logado`
   - `T_throttle = soma de throttleWaitMs no turno`
   - `T_total = latency_ms do traço`
3. Calcular p50/p95/p99 de cada componente e a fração de `T_total` que cada um representa.
4. Para a quarta mudança (trocar padrão por tempo), medir adicionalmente:
   - distribuição de `now - lastSentAt` no momento do envio;
   - fração de envios em que `now - lastSentAt >= throttleMs + jitterMaxMs` (ou seja,
     o throttle já teria sido "pago" pelo tempo decorrido — candidato a virar 0).

## 3. Tabela medida

Sem carga real de WhatsApp disponível nesta rodada, **a tabela fica vazia de propósito**.
Preencher com números medidos; número inventado é o pior resultado possível aqui.

| Componente | p50 (ms) | p95 (ms) | p99 (ms) | % do turno | n |
|---|---:|---:|---:|---:|---:|
| Classificadores (paralelo) | — | — | — | — | 0 |
| LLM (`invokeBot`) | — | — | — | — | 0 |
| Pausa humana (`atraso_ms`) | — | — | — | — | 0 |
| Throttle anti-ban entre envios | — | — | — | — | 0 |
| Escoamento/lote (drain) | — | — | — | — | 0 |
| **Total do turno** | — | — | — | 100% | 0 |

## 4. A conta da quarta mudança (trocar padrão por tempo)

A quarta mudança proposta: quando `now - lastSentAt` já cobre o intervalo anti-ban
(`throttleMs + jitter`), o throttle entre envios deixa de dormir — troca-se o
**padrão fixo** por **tempo decorrido**. Ganho de latência estimado: até
`throttleMs + jitterMaxMs` por envio em turnos espaçados. Custo: risco de banimento
se a medição de `lastSentAt` estiver errada (relógio do daemon vs. do banco, sessão
compartilhada, envio concorrente no mesmo número).

**Condição de autorização (a ser verificada com os números da tabela):**

- ganho mediano ≥ 2× o jitter típico (≈ 1,6 s) em ≥ 50% dos turnos; **e**
- a fração de envios em que o tempo decorrido já cobre o gap é ≥ 80%, **e**
- não há caso de `lastSentAt` nulo/stale em produção (senão o throttle viraria 0
  por engano e o número perderia a proteção).

## 5. Decisão desta rodada

**Não mexer.** A conta não fecha sem os números da tabela: a fração de envios em que
o tempo decorrido já cobre o gap anti-ban é desconhecida, e o risco de banimento por
um `lastSentAt` stale é alto e não quantificado. Reduzir o throttle com base em
suposição compraria latência pagando com o canal do cliente.

Reabrir quando a tabela da seção 3 estiver preenchida com carga real de WhatsApp.
Até lá, manter o comportamento atual (throttle fixo por `decidePacing`).
