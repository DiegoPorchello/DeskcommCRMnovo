---
impacto: nada_mudou
secao: corrigido
titulo: No modo Só os seus, iniciar conversa assume o atendimento livre para quem clicou
---

Um atendente que cadastrava um contato novo e iniciava a conversa podia receber
“está com outro atendente” sobre um atendimento sem dono. Agora a sessão de quem
clicou pode assumir a conversa livre e passar a vê-la. Conversa de colega não é
tomada e integração por token não assume em nome de uma pessoa.

A atribuição usa os mesmos efeitos de Assumir: sincroniza um negócio aberto sem
responsável quando permitido, registra auditoria, evento e a troca de comando
na linha do tempo. Uma tentativa posterior de assumir não repete esses efeitos.
Se outro atendente assumir antes, a disputa não tira a conversa dele.
Transferência e roteamento continuam exigindo visibilidade.

Nenhuma configuração nova. Contribuição de @webtecnica (#3479 / #3493).
