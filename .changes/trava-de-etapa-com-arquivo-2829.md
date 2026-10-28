---
impacto: nada_mudou
secao: corrigido
titulo: A etapa que exige documento barra o card sem arquivo — e não trava mais a criação
---

O campo personalizado do tipo arquivo já podia ser marcado como exigido numa
etapa do funil, e o quadro já mostrava no card quantos arquivos cada negócio
tem. Faltava a regra valendo de ponta a ponta: entrar numa etapa que exige um
documento sem ter o documento é recusado, com a lista do que falta e o NOME do
campo — é ele que a tela vira em formulário, para a pessoa subir o arquivo e
tentar de novo. Com o arquivo anexado, o movimento passa. Vale igual para o
ganho e para a perda quando o funil marca o campo como exigido nesses desfechos.

O que conta é o anexo de verdade, naquele campo: arquivo anexado em outro campo
não libera a etapa, e um valor escrito em "campos personalizados" com o nome do
campo de arquivo não substitui o documento no Storage.

Dois cuidados que a regra respeita: etapa que NÃO declara o campo como exigido
continua livre (nada muda para quem nunca configurou isso, e a régua dos campos
de texto — data, concorrente, motivo — segue exatamente como estava); e a
CRIAÇÃO do negócio não cobra documento, porque o anexo pertence ao negócio e só
pode ser enviado depois que ele existe. Era por aí que a troca de funil e a
retomada ficavam impossíveis: as duas criam o negócio no destino e respondiam
recusa para sempre. Agora elas entram, e a cobrança do documento acontece na
primeira movimentação — quando anexar já é possível.

Nenhuma migração de banco é necessária: os anexos já moram na tabela própria,
criada junto com o campo.
