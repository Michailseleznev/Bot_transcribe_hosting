# Bot Transcribe Hosting

Railway-совместимый Telegram-бот, который распознаёт голосовые, аудио, видео, кружки и поддерживаемые документы через локальную модель `Whisper large-v3`.

## Что изменилось

- внешний STT API убран полностью;
- распознавание идёт локально через `faster-whisper`;
- по умолчанию используется `large-v3` c `compute_type=int8`, чтобы запуск на CPU Railway был реалистичнее;
- деплой идёт через `Dockerfile`, а не через Node buildpack.

## Что умеет

- принимает `voice`, `audio`, `video`, `video_note`;
- принимает `document`, если контейнер поддерживается моделью;
- сразу отвечает, что распознавание началось;
- потом присылает транскрипцию текстом;
- держит локальную in-memory очередь задач;
- лениво загружает модель при первом распознавании, чтобы сервис не падал на первом старте из-за долгой загрузки.

## Ограничения

- Telegram Bot API позволяет облачному боту скачать только файлы до 20 МБ;
- поддерживаемые контейнеры для `document`: `flac`, `m4a`, `mp3`, `mp4`, `mpeg/mpga`, `ogg`, `wav`, `webm`;
- `Whisper large-v3` тяжёлый: для Railway желательно достаточно RAM и CPU;
- без volume модель будет скачиваться заново после пересоздания контейнера;
- при рестарте сервиса незавершённые задачи из in-memory очереди теряются.

## Переменные окружения

Шаблон лежит в [.env.example](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/.env.example).

Обязательные:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

Основные настройки модели:

- `WHISPER_MODEL_SIZE=large-v3`
- `WHISPER_DEVICE=cpu`
- `WHISPER_COMPUTE_TYPE=int8`
- `WHISPER_CACHE_DIR=/tmp/whisper-cache`
- `WHISPER_PRELOAD=0`

Опциональные:

- `TRANSCRIBE_LANGUAGE=ru`
- `TRANSCRIBE_PROMPT`
- `TRANSCRIBE_CONCURRENCY=1`

## Локальный запуск

```bash
cd "/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting"
docker build -t bot-transcribe-hosting .
docker run --rm -p 3000:3000 \
  -e TELEGRAM_BOT_TOKEN=123456:replace-me \
  -e TELEGRAM_WEBHOOK_SECRET=replace-me \
  bot-transcribe-hosting
```

## Railway

1. Подключи репозиторий `Bot_transcribe_hosting` в Railway.
2. Railway должен использовать [Dockerfile](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/Dockerfile).
3. Добавь env-переменные из `.env.example`.
4. Очень желательно подключить volume и выставить `WHISPER_CACHE_DIR` в путь внутри volume, например `/data/whisper-cache`.
5. После первого деплоя получишь URL вида `https://...up.railway.app`.
6. Поставь Telegram webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=YOUR_RAILWAY_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Проверка webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Проверка health:

```bash
curl "YOUR_RAILWAY_URL/health"
```

## Файлы проекта

- [app.py](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/app.py) поднимает HTTP-сервис, очередь, Telegram webhook и локальную транскрибацию;
- [requirements.txt](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/requirements.txt) содержит Python-зависимости;
- [Dockerfile](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/Dockerfile) описывает образ для Railway;
- [railway.toml](/Users/misha/Library/Mobile Documents/com~apple~CloudDocs/2. Области/Проги/Transcribe bot hosting/railway.toml) задаёт healthcheck и policy рестарта.
