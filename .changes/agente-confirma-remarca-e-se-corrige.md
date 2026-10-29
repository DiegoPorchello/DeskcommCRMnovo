---
impacto: nada_mudou
secao: corrigido
titulo: Agente confirma hora sem agendar, remarcação não duplica e turno mudo se corrige
---

O agente deixava de confirmar horário "de cabeça": uma frase abrindo com
"Confirmado: …" sem a ferramenta de agenda ter sido chamada agora é vetada
pela cerca before-send e ele usa a agenda de verdade antes de prometer.
A remarcação pedida por descrição não cria mais um segundo agendamento — o
movimento sai com a ferramenta certa, com a receita de ferramenta alinhada ao
prompt publicado. Quando o turno termina sem nenhuma mensagem chegar ao
cliente (resposta cortada ou texto escrito fora do envio), o sistema pede uma
única correção e ela agora consegue entregar a mensagem em vez de morrer em
silêncio; assuntos de saúde seguem saindo por handoff para um humano. Nada
muda na VPS — a correção chega pela atualização normal.
