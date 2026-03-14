# Audio Transcribe Telegram Railway Bot

Отдельный Railway-совместимый Telegram-бот для транскрибации голосовых, аудио, видео, кружков и поддерживаемых документов с аудио.

## Что умеет

- принимает `voice`, `audio`, `video`, `video_note`;
- принимает `document`, если контейнер поддерживается STT API;
- сразу отвечает сообщением о старте распознавания;
- потом присылает транскрипцию текстом;
- работает как обычный Node webhook-сервис, поэтому подходит для Railway без Cloudflare-специфики.

## Ограничения

- по Telegram Bot API облачный бот может скачать файл только до 20 МБ;
- для `document` поддерживаются контейнеры `flac`, `m4a`, `mp3`, `mp4`, `mpeg/mpga`, `ogg`, `wav`, `webm`;
- текущая очередь задач in-memory, поэтому при рестарте инстанса незавершённые распознавания могут потеряться.

## Переменные окружения

Смотри шаблон в [.env.example](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/.env.example).

Обязательные:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

Полезные опциональные:

- `OPENAI_TRANSCRIBE_MODEL`
- `OPENAI_BASE_URL`
- `TRANSCRIBE_LANGUAGE`
- `TRANSCRIBE_PROMPT`
- `TRANSCRIBE_CONCURRENCY`

## Локальный запуск

```bash
cd "/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot"
npm install
cp .env.example .env
npm run dev
```

## Railway

1. Создай отдельный GitHub-репозиторий и запушь туда этот проект.
2. В Railway выбери `Deploy from GitHub repo`.
3. Добавь переменные окружения из `.env.example`.
4. Build/start/healthcheck уже описаны в [railway.toml](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/railway.toml).
5. После первого деплоя получишь публичный URL вида `https://...up.railway.app`.
6. Поставь Telegram webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=YOUR_RAILWAY_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Проверка:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Как устроен код

- [src/index.ts](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/src/index.ts) поднимает HTTP-сервер, принимает webhook и гоняет задания через in-memory очередь;
- [src/media.ts](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/src/media.ts) фильтрует типы медиа и лимиты;
- [src/transcribe.ts](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/src/transcribe.ts) отправляет файл в STT API;
- [src/telegram.ts](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Projects/audio-transcribe-telegram-railway-bot/src/telegram.ts) инкапсулирует Telegram Bot API.
