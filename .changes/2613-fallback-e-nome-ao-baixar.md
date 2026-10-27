---
impacto: nada_mudou
secao: corrigido
titulo: O cartão do documento diz "Documento XLSX" quando não há nome, e o download usa o nome original
---

O cartão de documento do Inbox tinha duas pontas soltas depois da entrega que passou a mostrar o nome original. A primeira: sem nome guardado — anexo de antes da ingestão, ou canal que não manda o nome — o cartão mostrava só `XLSX`, que se lê como se fosse o título do arquivo. Agora diz `Documento XLSX`, com a extensão identificada como extensão, como a issue pede.

A segunda: o nome aparecia na tela e morria no arquivo salvo. O ícone de download do cartão virou um link próprio (`?baixar=1`), e a rota de mídia devolve o arquivo nomeado — pela URL assinada quando a mídia já está no Storage, pelo `Content-Disposition` (com `filename` simples e `filename*` para acento) na janela em que o worker ainda não persistiu os bytes. A área do cartão continua abrindo a mídia como antes, então quem lê um PDF em aba nova não passou a baixá-lo.

Sem nome guardado, nada é inventado: nem no rótulo, nem no nome do arquivo. Não há como preencher os anexos antigos — o caminho no Storage é canônico (`{organização}/{conversa}/{mensagem}.{ext}`) e o provedor não reenvia o nome depois do webhook —, então eles ficam com `Documento XLSX` e baixam sem nome, como hoje.

No celular, o cartão também respeita a largura da bolha e separa a área de
toque do download do menu da mensagem. Os dois controles continuam acessíveis
sem que um cubra o outro; o nome completo permanece no título e nos links.
