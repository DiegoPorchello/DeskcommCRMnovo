---
impacto: nada_mudou
secao: alterado
titulo: "Cada tela do sistema pergunta menos ao banco quem você é e o que pode fazer"
---

Antes, cada navegação refazia a conferência inteira de acesso no banco: quem está logado, de quais empresas a pessoa faz parte, se é dona da instalação e se há um acompanhamento em curso. Agora o resultado vale por até 30 segundos dentro do mesmo processo, o que corta a maior parte dessas consultas (a #3696 mediu cerca de 42 mil em 17 horas de uso; a estimativa para o mesmo uso é de cerca de 11 mil). Tirar alguém da equipe, trocar o papel, suspender ou reativar a empresa pelo painel, entrar ou sair de um acompanhamento, sair da conta e ativar a verificação em duas etapas continuam valendo já na requisição seguinte. Na cobrança, também vale na hora quando a mudança sai do próprio sistema: "Já paguei", cancelar a assinatura, a rodada de hora em hora da cobrança, a troca de conexão com o provedor, dar prazo e tornar a empresa isenta. Quando a mudança chega pelo aviso do provedor de pagamento, quem a processa é o serviço de fundo (worker), que não alcança a memória do app: ali a tela pode levar até 30 segundos para refletir a suspensão ou a liberação. A conferência de papel que libera cada ação continua indo ao banco toda vez. Nada muda na VPS.

Crédito: @webtecnica.
