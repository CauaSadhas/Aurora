# Aurora V8 — atualização de desempenho

Esta versão foi criada para corrigir a lentidão percebida na V7.

## O que mudou

- A tela do quadro agora carrega os dados em uma única consulta principal ao banco.
- A tela inicial deixou de consultar checklist e cronômetro tarefa por tarefa.
- As obrigações mensais são verificadas apenas quando necessário, com cache temporário.
- Criação de colunas e áreas padrão utiliza operações em lote.
- Mover tarefa, atualizar, excluir, checklist e cronômetro usam menos idas ao banco.
- Foram adicionados índices específicos para tarefas, checklists, cronômetros e obrigações.
- O banco não repete toda a criação das tabelas em cada inicialização da função.
- CSS e JavaScript possuem nomes versionados e cache longo na Vercel.
- Fluid Compute é habilitado na configuração da Vercel.
- `/health` agora informa a latência do banco e a região da função.

## Como atualizar pelo GitHub

1. Extraia `aurora-atualizacao-desempenho-v8.zip`.
2. No repositório AURORA, clique em **Add file → Upload files**.
3. Arraste todo o conteúdo extraído, mantendo as pastas `public` e `views`.
4. Confirme a substituição dos arquivos existentes.
5. Clique em **Commit changes**.
6. Aguarde a Vercel concluir a nova implantação.

As variáveis já cadastradas continuam as mesmas:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `SESSION_SECRET`

Não é necessário recriar o banco. As tarefas existentes permanecem no Turso.

## Verificação

Após a implantação, abra:

`https://SEU-DOMINIO.vercel.app/health`

O resultado mostrará `databaseLatencyMs`. Caso esse número fique frequentemente acima de 250 ms, a região da função Vercel e a região principal do Turso devem ser alinhadas.
