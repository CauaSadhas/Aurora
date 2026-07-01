# Correção do login na Vercel — V6

O banco já estava conectado e a tela de login carregava, mas o cookie de sessão não era gravado.

A Vercel recebe a conexão HTTPS e encaminha a requisição ao Express por um proxy. Agora o projeto usa:

```js
if (IS_VERCEL) app.set('trust proxy', 1);
```

Isso permite que o Express reconheça corretamente o protocolo HTTPS e grave o cookie seguro da sessão.

## Publicação

Substitua o arquivo `server.js` no GitHub e aguarde o novo deploy. Não é necessário alterar as variáveis de ambiente.
