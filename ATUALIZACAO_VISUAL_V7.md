# Aurora V7 — atualização visual e de usabilidade

Esta versão mantém o banco Turso, o login e todas as funções da V6, mas melhora a experiência visual e o uso em computador e celular.

## Melhorias principais

- painel inicial com resumo mais claro;
- Kanban ocupando melhor a largura da tela;
- cartões com prioridade, cliente, prazo, checklist e cronômetro mais legíveis;
- contagem das colunas atualizada ao arrastar tarefas;
- visualização em planilha com busca e contador de resultados;
- calendário mais limpo e destaque do dia atual;
- menu lateral redesenhado;
- menu inferior com nomes no celular;
- formulários e janelas adaptados para telas pequenas;
- modais acessíveis, fechamento com Esc e foco automático;
- proteção contra envios duplos de formulários;
- restauração da posição horizontal do Kanban;
- cabeçalhos de segurança e cache dos arquivos estáticos.

## Publicação

Substitua os arquivos do repositório pelos arquivos desta versão. A Vercel fará um novo deploy automaticamente. As variáveis já cadastradas devem ser mantidas:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `SESSION_SECRET`
