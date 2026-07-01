# Publicação na Vercel — versão 3

Esta versão possui uma entrada explícita em `api/index.js`. Isso força a Vercel a criar a função Node/Express, evitando o deploy vazio que retornava `404: NOT_FOUND`.

## Arquivos que devem aparecer na raiz do GitHub

- `api/`
- `public/`
- `views/`
- `package.json`
- `package-lock.json`
- `server.js`
- `vercel.json`

## Configuração do projeto na Vercel

Em `Settings → Build and Deployment`:

- Framework Preset: `Other`
- Root Directory: `./` ou vazio, apontando para a raiz do repositório
- Build Command: Override desligado
- Output Directory: Override desligado
- Install Command: Override desligado

Depois vá em `Deployments`, abra o menu da implantação e escolha `Redeploy`. Desative a opção de usar o cache anterior, caso ela apareça.

## Resultado esperado nos novos logs

A Vercel deve mostrar etapas como instalação das dependências e criação de uma função para `api/index.js`. Um deploy que termina em poucos milissegundos sem instalar dependências continua incorreto.

## Banco de dados

Para salvar usuários e tarefas na Vercel, cadastre em `Settings → Environment Variables`:

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
SESSION_SECRET
```

Sem essas variáveis, a aplicação abrirá uma tela de configuração em vez do painel.

## Teste

Abra primeiro:

```text
https://SEU-PROJETO.vercel.app/health
```

Com o Turso conectado, o resultado deverá indicar `turso-cloud`.
