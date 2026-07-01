# Aurora — Gestor de Tarefas v3

Versão preparada para publicação na Vercel com uma função explícita em `api/index.js`.

## Recursos

- Cadastro, login e senha criptografada;
- Banco SQLite local durante o desenvolvimento;
- Banco Turso persistente na Vercel;
- Kanban, planilha, calendário e lista;
- Checklists, cronômetro e obrigações mensais;
- Estrutura preparada para Gmail e WhatsApp Business.

## Rodar no computador

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

## Publicar na Vercel

Envie todos os arquivos deste pacote para a raiz do repositório. A primeira tela do GitHub deve mostrar `api`, `public`, `views`, `package.json`, `server.js` e `vercel.json`.

Na Vercel, deixe o Root Directory na raiz do repositório, desligue qualquer Override de Build Command e Output Directory, e faça um Redeploy sem usar o cache.

## Conta de demonstração

- E-mail: `demo@gestor.local`
- Senha: `123456`
