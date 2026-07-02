# Aurora — Gestor de Tarefas V8

Gestor de tarefas responsivo com login, banco de dados, Kanban, planilha, calendário, lista, checklists, cronômetros e obrigações mensais.

A V8 foi otimizada para Vercel e Turso, reduzindo significativamente a quantidade de consultas remotas por página.

## Recursos

- Cadastro e login com senha protegida;
- Banco SQLite no computador;
- Banco Turso persistente na Vercel;
- Visualizações Kanban, planilha, calendário e lista;
- Checklists e cronômetros por tarefa;
- Obrigações mensais automáticas;
- Estrutura preparada para Gmail e WhatsApp Business;
- Interface responsiva para computador e celular;
- Diagnóstico de conexão e latência em `/health`.

## Rodar no computador

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

## Publicar na Vercel

Envie todos os arquivos para a raiz do repositório. Na primeira tela do GitHub devem aparecer diretamente:

```text
api
public
views
package.json
server.js
vercel.json
```

As variáveis necessárias são:

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
SESSION_SECRET
```

## Conta de demonstração

- E-mail: `demo@gestor.local`
- Senha: `123456`
