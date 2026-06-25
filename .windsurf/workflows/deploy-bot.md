---
description: Обновление Telegram-бота на VPS
---

## Деплой бота на VPS

После изменения `bot/main.py` выполнить следующие шаги:

### 1. Залить файл на VPS
```
scp bot/main.py admin@157.90.144.15:/opt/hameleon/bot/main.py
```

### 2. Пересобрать Docker-образ
```
ssh admin@157.90.144.15 "docker build -t hameleon-bot /opt/hameleon/bot"
```

### 3. Перезапустить контейнер
```
ssh admin@157.90.144.15 "docker stop hameleon-bot-1 && docker rm hameleon-bot-1 && docker run -d --name hameleon-bot-1 --network hameleonweb-network -v /opt/hameleon/data:/data --env-file /opt/hameleon/.env --restart always hameleon-bot"
```

### Optional: force Kyiv timezone inside the container
If you want container-local timestamps and logs to follow Kyiv time as well, add `-e TZ=Europe/Kyiv` to the `docker run` command.

### 4. Проверить логи
```
ssh admin@157.90.144.15 "docker logs hameleon-bot-1 --tail 20"
```

Бот запущен если в логах видно: `INFO:aiogram.dispatcher:Start polling`

---

## Деплой API на VPS

После изменения `api/main.py`:

### 1. Залить файл
```
scp api/main.py admin@157.90.144.15:/opt/hameleon/api/main.py
```

### 2. Пересобрать образ
```
ssh admin@157.90.144.15 "docker build -t hameleon-api /opt/hameleon/api"
```

### 3. Пересоздать контейнер
```
ssh admin@157.90.144.15 "docker stop hameleon-api-1 && docker rm hameleon-api-1 && docker run -d --name hameleon-api-1 --network hameleonweb-network --network-alias api -v /opt/hameleon/data:/app/data --env-file /opt/hameleon/.env --restart always -p 127.0.0.1:8000:8000 hameleon-api uvicorn main:app --host 0.0.0.0 --port 8000"
```

### Optional: force Kyiv timezone inside the container
If you want container-local timestamps and logs to follow Kyiv time as well, add `-e TZ=Europe/Kyiv` to the `docker run` command.

### 4. Проверить
```
ssh admin@157.90.144.15 "docker logs hameleon-api-1 --tail 10"
```

---

## Почему docker restart не обновляет код

И бот и API **встроены в Docker-образ** при сборке (`COPY . /app`).
`docker restart` только перезапускает контейнер из того же образа — файлы внутри не обновляются.

Для обоих обязательно: **scp → docker build → docker stop/rm → docker run**.
