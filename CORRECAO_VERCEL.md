# Correção da importação na Vercel

A versão anterior usava `includeFiles` como lista. O esquema atual do `vercel.json` exige uma única string.

Conteúdo correto de `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "version": 2,
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index"
    }
  ],
  "functions": {
    "api/index.js": {
      "includeFiles": "views/**"
    }
  }
}
```

Os arquivos de `public/` são servidos pela CDN da Vercel. Os arquivos de `views/` são incluídos na função Express para que o EJS consiga renderizar as páginas.
