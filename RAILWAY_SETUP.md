# Setup Railway - Serviço WhatsApp Paraná Pop

## 1. Criar serviço

Suba este projeto em um repositório GitHub separado, por exemplo:

```txt
paranapop-whatsapp-service
```

Depois, no Railway:

```txt
New Project > Deploy from GitHub repo > paranapop-whatsapp-service
```

## 2. Variáveis

Configure:

```env
SERVICE_TOKEN=uma-chave-forte-igual-no-flask
AUTH_DIR=/app/auth
BOT_NAME=ParanaPOP Bot
CORS_ORIGINS=*
MEDIA_DOWNLOAD_TIMEOUT_MS=30000
MAX_MEDIA_BYTES=15000000
```

O Railway define `PORT` automaticamente. Não precisa configurar.

## 3. Volume

Crie um volume no serviço WhatsApp e monte em:

```txt
/app/auth
```

Esse volume guarda a sessão do WhatsApp. Sem ele, o bot pode perder o login em redeploys.

## 4. URL no admin Flask

No admin `/admin/whatsapp`, coloque a URL pública do serviço:

```txt
https://SEU-SERVICO-WHATSAPP.up.railway.app
```

Também configure o mesmo token no serviço Flask se o patch do admin tiver campo/env para isso.

## 5. Endpoints de teste

```txt
GET /health
GET /status
GET /qr
GET /groups
POST /send-message
POST /send-news
```

Para teste com token:

```bash
curl -H "Authorization: Bearer SUA_CHAVE" https://SEU-SERVICO.up.railway.app/status
```
