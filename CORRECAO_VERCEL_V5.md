# Correção da instalação na Vercel — versão 5

O `package-lock.json` anterior apontava para um registro interno que não existe na Vercel.

Nesta versão:

- todos os pacotes apontam para `https://registry.npmjs.org/`;
- o `package.json` e o `package-lock.json` estão sincronizados na versão 5.0.0;
- a instalação usa `npm ci --no-audit --no-fund`;
- as pastas `views` e `public` são incluídas na função da Vercel;
- o projeto foi testado localmente com instalação limpa.

## Publicação

Substitua os arquivos do repositório pelos arquivos desta pasta e faça um novo deploy sem cache.
