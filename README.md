# HAMELEONWEB Backend

Полная инфраструктура для HAMELEONWEB: Telegram бот, API лицензий, сайт и база данных.

## 🏗️ Архитектура

```
hameleonweb-backend/
├── docker-compose.yml    # Запуск всех сервисов
├── api/                  # FastAPI (Python) - лицензии и оплата
├── bot/                  # Telegram Bot (Python aiogram)
├── web/                  # Статичный сайт (резерв)
├── nginx/                # Reverse proxy
├── data/                 # PostgreSQL + Redis volumes
└── ../сайт/              # Vite React сайт из Figma
```

### Сайт из Figma
Сайт собирается из исходников в `../whatsapp-manager-backup-2026-06-11_23-29-19/сайт/`:
- Vite + React + TypeScript
- Автоматическая сборка в Docker
- Статические файлы → nginx

## 🚀 Быстрый старт

### 1. Настройка окружения

```bash
cp .env.example .env
nano .env  # Заполните свои значения
```

### 2. Запуск

```bash
# Первый запуск
docker-compose up -d

# Проверка статуса
docker-compose ps

# Логи
docker-compose logs -f api
docker-compose logs -f bot
```

### 3. Остановка

```bash
docker-compose down
```

## 📋 Требования

- Docker 20.10+
- Docker Compose 2.0+
- Linux сервер (Ubuntu 20.04+ рекомендуется)
- Открытые порты: 80, 443 (для nginx)

## 🔧 Конфигурация (.env)

| Переменная | Описание | Пример |
|------------|----------|--------|
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_ADMIN_ID` | Telegram ID админа | `425601155` |
| `JWT_SECRET` | Секрет для JWT токенов | `random_string_32+` |
| `NOWPAYMENTS_API_KEY` | API ключ NOWPayments | `HQDZH...` |
| `NOWPAYMENTS_IPN_SECRET` | IPN секрет для webhooks | `secret...` |
| `POSTGRES_PASSWORD` | Пароль БД | `strong_pass` |

## 🌐 Доступ

| Сервис | URL | Описание |
|--------|-----|----------|
| Сайт | `http://localhost` | Главная страница |
| API | `http://localhost/api/` | REST API |
| Health | `http://localhost/health` | Проверка работы |

## 📁 Структура данных

### Пакеты (тарифы)

| Код | Название | Цена | Срок |
|-----|----------|------|------|
| `monthly_1` | Месячная (1 аккаунт) | $29 | 30 дней |
| `monthly_5` | Месячная (5 аккаунтов) | $79 | 30 дней |
| `yearly_1` | Годовая (1 аккаунт) | $199 | 365 дней |
| `yearly_unlimited` | Годовая безлимит | $499 | 365 дней |

### Поток покупки

```
Пользователь → Бот → Выбор пакета → Выбор количества 
→ Создание инвойса (NOWPayments) → Оплата криптой 
→ Webhook → Активация лицензии → Уведомление в бот
```

### Вход в приложение

```
Приложение → Ввод Telegram ID → API запрос кода
→ Бот отправляет 6-значный код → Ввод кода в приложение
→ JWT токен → Доступ к лицензии
```

## 🔒 SSL (HTTPS)

Для production раскомментируйте HTTPS сервер в `nginx/default.conf` и получите сертификаты:

```bash
docker-compose run --rm certbot certonly --webroot -w /var/www/certbot -d yourdomain.com
```

## 🛠️ Команды для разработки

```bash
# Пересборка после изменений
docker-compose up -d --build

# Вход в контейнер API
docker-compose exec api bash

# База данных
docker-compose exec postgres psql -U hameleon -d hameleonweb

# Redis
docker-compose exec redis redis-cli
```

## 📝 Логи

```bash
# Все сервисы
docker-compose logs -f

# Конкретный сервис
docker-compose logs -f bot
docker-compose logs -f api
```

## 🆘 Поддержка

- Telegram: @admin
- Email: support@hameleonweb.com
