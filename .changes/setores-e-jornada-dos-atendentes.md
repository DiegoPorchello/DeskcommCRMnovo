---
impacto: capacidade_nova
secao: adicionado
titulo: Setores de atendimento na Equipe, e o horário de trabalho passa a ser definido só pelo gerente
---

Em **Equipe › Setores** dá para cadastrar os setores da empresa (Comercial, Suporte, Financeiro…), com nome e descrição, e ver quantos atendentes há em cada um. Na aba **Atendimento**, cada atendente ganha a coluna **Setor**, onde o gerente escolhe o setor da pessoa, e um filtro para ver a equipe de um setor só. Apagar um setor não mexe em ninguém: os atendentes dele ficam "sem setor", com jornada, carga e conversas intactas. Junto disso, o **horário de atendimento** de cada pessoa passa a ser definido apenas por gerentes e administradores — antes a própria pessoa conseguia reescrever a jornada pela API e, com isso, ficar de plantão fora do expediente. A chave de plantão continua com o atendente, e fora das janelas publicadas ele segue sem receber conversa. Nada muda na VPS: a atualização cria as tabelas sozinha.
