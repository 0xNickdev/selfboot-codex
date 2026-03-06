# Deploy to Railway

## Быстрый деплой (5 минут)

### 1. Push на GitHub
```bash
git init
git add .
git commit -m "Self-Boot Codex v3"
git remote add origin https://github.com/YOUR/repo.git
git push -u origin main
```

### 2. Railway
1. railway.app → New Project → Deploy from GitHub
2. Выбери репо
3. Railway автоматически найдёт `package.json` и запустит `node server.js`

### 3. Persistent Storage (важно!)
Без этого данные сотрутся при редеплое:

Railway Dashboard → твой сервис → **Volumes** → Add Volume
- Mount Path: `/data`
- Потом добавь переменную: `DATA_DIR=/data`

### 4. Environment Variables
В Railway Dashboard → Variables:
```
PORT=3000          # Railway подставит сам
DATA_DIR=/data     # если добавил Volume
```

### 5. Готово
Railway даст тебе URL вида: `https://selfboot-codex-production.up.railway.app`

---

## Почему не Vercel

| | Railway | Vercel |
|---|---|---|
| Node.js server | ✅ нативно | ❌ нужен рефактор |
| Filesystem | ✅ Volume | ❌ эфемерная |
| SSE streaming | ✅ работает | ⚠️ обрыв на 10s |
| Agent loops (30-45s) | ✅ | ❌ timeout |
| Цена | $5/мес hobby | бесплатно (но не работает) |

Vercel подойдёт если переписать на Next.js API routes + подключить Vercel KV или Postgres.
Это возможно — но это другой проект.
