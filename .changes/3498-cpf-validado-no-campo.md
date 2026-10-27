---
impacto: nada_mudou
secao: corrigido
titulo: CPF com dígito errado passa a ser avisado no próprio campo do contato
---

Quem digitava um CPF errado no cadastro de contato não recebia sinal nenhum enquanto digitava: o campo aceitava, e a frase "CPF inválido" só aparecia no rodapé do diálogo depois do clique em criar — longe do campo que causou o problema. Na prática, dava a impressão de que a tela não validava nada.

Agora a conferência acontece no próprio campo, quando a pessoa sai dele. A mensagem nasce embaixo do input, o campo fica marcado como inválido para leitores de tela, e nada é enviado até o documento estar certo. A régua é a do país da organização, como já era no servidor: organização brasileira confere o dígito verificador do CPF, e o mesmo mecanismo serve a qualquer perfil que declare o seu documento.

O campo continua opcional: em branco, passa como antes. Nenhum dado existente muda e nenhuma configuração é necessária.

Contribuição de @webtecnica (#3498).
