from __future__ import annotations

import asyncio
import os
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from aiohttp import ClientResponseError, ClientSession, ClientTimeout, web
from faster_whisper import WhisperModel


SUPPORTED_EXTENSIONS = {
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpga",
    ".oga",
    ".ogg",
    ".wav",
    ".webm",
}

SUPPORTED_MIME_TYPES = {
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/mpga",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-flac",
    "audio/x-m4a",
    "audio/x-wav",
    "audio/vnd.wave",
    "application/ogg",
    "video/mp4",
    "video/mpeg",
    "video/webm",
}

MIME_TO_EXTENSION = {
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/mpga": ".mpga",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/x-flac": ".flac",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
    "audio/vnd.wave": ".wav",
    "application/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/mpeg": ".mpeg",
    "video/webm": ".webm",
}

OPENAI_FORMATS_LABEL = "flac, m4a, mp3, mp4, mpeg/mpga, ogg, wav, webm"
TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
PROCESSING_TEXT = "Принял файл. Начинаю распознавание, это может занять немного времени."
START_TEXT = "\n\n".join(
    [
        "Отправь голосовое, аудио, видео, кружок или документ с поддерживаемым аудио/видео контейнером.",
        "Бот использует локальную модель Whisper large-v3 на сервере, а не внешний API.",
        "Поддерживаемые форматы для документа: flac, m4a, mp3, mp4, mpeg/mpga, ogg, wav, webm.",
        "Ограничение Telegram Bot API: облачный бот может скачать файл только до 20 МБ.",
        "После рестарта первый запрос может идти дольше, потому что large-v3 загружается локально.",
    ]
)


class PermanentJobError(RuntimeError):
    pass


@dataclass(slots=True)
class AppConfig:
    port: int
    host: str
    telegram_bot_token: str
    telegram_webhook_secret: str
    transcribe_language: str | None
    transcribe_prompt: str | None
    transcribe_concurrency: int
    whisper_model_size: str
    whisper_device: str
    whisper_compute_type: str
    whisper_cache_dir: str
    whisper_preload: bool


@dataclass(slots=True)
class MediaCandidate:
    file_id: str
    file_name: str
    mime_type: str | None
    file_size: int | None


@dataclass(slots=True)
class TranscribeJob:
    chat_id: int
    message_id: int
    message_thread_id: int | None
    file_id: str
    file_name: str
    mime_type: str | None
    file_size: int | None


class WhisperService:
    def __init__(self, config: AppConfig):
        self._config = config
        self._model: WhisperModel | None = None
        self._model_lock = asyncio.Lock()
        self._transcribe_lock = asyncio.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    async def get_model(self) -> WhisperModel:
        if self._model is not None:
            return self._model

        async with self._model_lock:
            if self._model is None:
                print(
                    "Loading Whisper model:",
                    self._config.whisper_model_size,
                    self._config.whisper_device,
                    self._config.whisper_compute_type,
                    flush=True,
                )
                self._model = await asyncio.to_thread(
                    WhisperModel,
                    self._config.whisper_model_size,
                    device=self._config.whisper_device,
                    compute_type=self._config.whisper_compute_type,
                    download_root=self._config.whisper_cache_dir,
                )
                print("Whisper model loaded.", flush=True)

        return self._model

    async def transcribe_file(self, file_path: str) -> str:
        model = await self.get_model()

        async with self._transcribe_lock:
            return await asyncio.to_thread(self._transcribe_sync, model, file_path)

    def _transcribe_sync(self, model: WhisperModel, file_path: str) -> str:
        segments, _info = model.transcribe(
            file_path,
            language=self._config.transcribe_language,
            initial_prompt=self._config.transcribe_prompt,
            vad_filter=True,
            beam_size=5,
        )
        parts = [segment.text.strip() for segment in segments if segment.text and segment.text.strip()]
        return " ".join(parts).strip()


def create_app(config: AppConfig) -> web.Application:
    app = web.Application()
    app["config"] = config
    app["http"] = None
    app["jobs"] = asyncio.Queue()
    app["workers"] = []
    app["preload_task"] = None
    app["whisper"] = WhisperService(config)

    app.router.add_get("/", health_handler)
    app.router.add_get("/health", health_handler)
    app.router.add_post("/telegram/webhook", webhook_handler)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def on_startup(app: web.Application) -> None:
    timeout = ClientTimeout(total=300)
    app["http"] = ClientSession(timeout=timeout)

    worker_count = max(1, app["config"].transcribe_concurrency)
    app["workers"] = [asyncio.create_task(worker_loop(app, idx)) for idx in range(worker_count)]

    if app["config"].whisper_preload:
        app["preload_task"] = asyncio.create_task(preload_model(app))


async def on_cleanup(app: web.Application) -> None:
    preload_task = app.get("preload_task")
    if preload_task is not None:
        preload_task.cancel()
        with suppress(asyncio.CancelledError):
            await preload_task

    for task in app.get("workers", []):
        task.cancel()

    for task in app.get("workers", []):
        with suppress(asyncio.CancelledError):
            await task

    session: ClientSession | None = app.get("http")
    if session is not None:
        await session.close()


async def preload_model(app: web.Application) -> None:
    try:
        await app["whisper"].get_model()
    except Exception as exc:  # noqa: BLE001
        print(f"Whisper preload failed: {exc}", flush=True)


async def health_handler(request: web.Request) -> web.Response:
    jobs: asyncio.Queue[TranscribeJob] = request.app["jobs"]
    config: AppConfig = request.app["config"]
    whisper: WhisperService = request.app["whisper"]
    return web.json_response(
        {
            "ok": True,
            "service": "telegram-whisper-local-bot",
            "queue_pending": jobs.qsize(),
            "model_loaded": whisper.loaded,
            "whisper_model_size": config.whisper_model_size,
            "whisper_device": config.whisper_device,
            "whisper_compute_type": config.whisper_compute_type,
        }
    )


async def webhook_handler(request: web.Request) -> web.Response:
    config: AppConfig = request.app["config"]
    secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if config.telegram_webhook_secret and secret != config.telegram_webhook_secret:
        return web.Response(status=401, text="Unauthorized")

    update = await request.json()
    message = get_effective_message(update)
    if message is None:
        return web.json_response({"ok": True})

    if is_start_command(message.get("text")):
        await reply_to_original(request.app, message, START_TEXT)
        return web.json_response({"ok": True})

    selection = select_media(message)
    if selection is None:
        return web.json_response({"ok": True})

    if isinstance(selection, str):
        await reply_to_original(request.app, message, selection)
        return web.json_response({"ok": True})

    if media_too_large(selection.file_size):
        await reply_to_original(request.app, message, size_limit_text(selection.file_size))
        return web.json_response({"ok": True})

    job = TranscribeJob(
        chat_id=message["chat"]["id"],
        message_id=message["message_id"],
        message_thread_id=message.get("message_thread_id"),
        file_id=selection.file_id,
        file_name=selection.file_name,
        mime_type=selection.mime_type,
        file_size=selection.file_size,
    )
    await request.app["jobs"].put(job)

    try:
        await reply_to_original(request.app, message, PROCESSING_TEXT)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to send processing message: {exc}", flush=True)

    return web.json_response({"ok": True})


async def worker_loop(app: web.Application, worker_id: int) -> None:
    jobs: asyncio.Queue[TranscribeJob] = app["jobs"]
    while True:
        job = await jobs.get()
        try:
            await process_transcribe_job_with_retry(app, job)
        except Exception as exc:  # noqa: BLE001
            print(f"Worker {worker_id} unexpected error: {exc}", flush=True)
        finally:
            jobs.task_done()


async def process_transcribe_job_with_retry(app: web.Application, job: TranscribeJob) -> None:
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            await process_transcribe_job(app, job)
            return
        except PermanentJobError as exc:
            print(f"Permanent transcription error: {exc}", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            is_last_attempt = attempt == max_attempts
            print(f"Transcription attempt {attempt}/{max_attempts} failed: {exc}", flush=True)
            if is_last_attempt:
                await notify_job_failure(
                    app,
                    job,
                    "Не удалось распознать файл из-за временной ошибки. Попробуй отправить его ещё раз.",
                )
                return
            await asyncio.sleep(attempt * 1.5)


async def process_transcribe_job(app: web.Application, job: TranscribeJob) -> None:
    telegram_file = await get_telegram_file(app, job.file_id)
    file_path = telegram_file.get("file_path")
    if not file_path:
        await notify_job_failure(app, job, "Telegram не вернул путь к файлу для скачивания.")
        raise PermanentJobError("Telegram file_path is empty")

    effective_file_size = job.file_size or telegram_file.get("file_size")
    if media_too_large(effective_file_size):
        await notify_job_failure(app, job, size_limit_text(effective_file_size))
        raise PermanentJobError("File exceeds Telegram cloud download limit")

    payload = await download_telegram_file(app, file_path)
    if media_too_large(len(payload)):
        await notify_job_failure(app, job, size_limit_text(len(payload)))
        raise PermanentJobError("Downloaded file exceeds Telegram cloud download limit")

    suffix = file_suffix(job.file_name, job.mime_type)
    temp_path = write_temp_file(payload, suffix)

    try:
        transcript = await app["whisper"].transcribe_file(temp_path)
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temp_path)

    if not transcript:
        await send_transcript(app, job, "Не удалось получить текст из этого файла.")
        return

    await send_transcript(app, job, transcript)


async def telegram_api(
    app: web.Application,
    method: str,
    payload: dict[str, Any],
) -> Any:
    config: AppConfig = app["config"]
    session: ClientSession = app["http"]
    url = f"https://api.telegram.org/bot{config.telegram_bot_token}/{method}"

    async with session.post(url, json=payload) as response:
        data = await response.json()
        if not response.ok or not data.get("ok"):
            description = data.get("description") or response.reason
            raise ClientResponseError(
                response.request_info,
                response.history,
                status=response.status,
                message=f"Telegram API {method} failed: {description}",
                headers=response.headers,
            )
        return data["result"]


async def get_telegram_file(app: web.Application, file_id: str) -> dict[str, Any]:
    return await telegram_api(app, "getFile", {"file_id": file_id})


async def send_telegram_message(
    app: web.Application,
    *,
    chat_id: int,
    text: str,
    reply_to_message_id: int | None,
    message_thread_id: int | None,
) -> None:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id
    if message_thread_id is not None:
        payload["message_thread_id"] = message_thread_id
    await telegram_api(app, "sendMessage", payload)


async def download_telegram_file(app: web.Application, telegram_file_path: str) -> bytes:
    config: AppConfig = app["config"]
    session: ClientSession = app["http"]
    url = f"https://api.telegram.org/file/bot{config.telegram_bot_token}/{telegram_file_path}"

    async with session.get(url) as response:
        response.raise_for_status()
        return await response.read()


async def reply_to_original(app: web.Application, message: dict[str, Any], text: str) -> None:
    await send_telegram_message(
        app,
        chat_id=message["chat"]["id"],
        text=text,
        reply_to_message_id=message["message_id"],
        message_thread_id=message.get("message_thread_id"),
    )


async def notify_job_failure(app: web.Application, job: TranscribeJob, text: str) -> None:
    await send_telegram_message(
        app,
        chat_id=job.chat_id,
        text=text,
        reply_to_message_id=job.message_id,
        message_thread_id=job.message_thread_id,
    )


async def send_transcript(app: web.Application, job: TranscribeJob, transcript: str) -> None:
    chunks = split_transcript(transcript, 3800)
    total = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        prefix = f"Транскрибация {index}/{total}\n\n" if total > 1 else "Транскрибация\n\n"
        await send_telegram_message(
            app,
            chat_id=job.chat_id,
            text=f"{prefix}{chunk}",
            reply_to_message_id=job.message_id if index == 1 else None,
            message_thread_id=job.message_thread_id,
        )


def get_effective_message(update: dict[str, Any]) -> dict[str, Any] | None:
    return update.get("message") or update.get("channel_post")


def is_start_command(text: str | None) -> bool:
    if not text:
        return False
    normalized = text.strip().lower()
    return normalized == "/start" or normalized.startswith("/start@") or normalized == "/help" or normalized.startswith("/help@")


def select_media(message: dict[str, Any]) -> MediaCandidate | str | None:
    message_id = message["message_id"]

    if message.get("voice"):
        file_data = message["voice"]
        return build_candidate(file_data, f"voice-{message_id}.ogg", "audio/ogg")

    if message.get("audio"):
        file_data = message["audio"]
        candidate = build_candidate(file_data, f"audio-{message_id}.mp3", file_data.get("mime_type"))
        return ensure_supported(candidate)

    if message.get("video"):
        file_data = message["video"]
        candidate = build_candidate(file_data, f"video-{message_id}.mp4", "video/mp4")
        return ensure_supported(candidate)

    if message.get("video_note"):
        file_data = message["video_note"]
        return build_candidate(file_data, f"video-note-{message_id}.mp4", "video/mp4")

    if message.get("document"):
        file_data = message["document"]
        fallback_name = file_data.get("file_name") or f"document-{message_id}"
        candidate = build_candidate(file_data, fallback_name, file_data.get("mime_type"))
        return ensure_supported(candidate)

    return None


def build_candidate(file_data: dict[str, Any], fallback_name: str, fallback_mime: str | None) -> MediaCandidate:
    raw_name = str(file_data.get("file_name") or fallback_name)
    mime_type = normalize_mime(file_data.get("mime_type") or fallback_mime)
    file_name = ensure_extension(raw_name, MIME_TO_EXTENSION.get(mime_type or ""))
    file_size = file_data.get("file_size")

    return MediaCandidate(
        file_id=str(file_data["file_id"]),
        file_name=file_name,
        mime_type=mime_type,
        file_size=int(file_size) if isinstance(file_size, int) else None,
    )


def ensure_supported(candidate: MediaCandidate) -> MediaCandidate | str:
    extension = file_extension(candidate.file_name)
    mime_type = normalize_mime(candidate.mime_type)

    if extension and extension in SUPPORTED_EXTENSIONS:
        return candidate

    if mime_type and mime_type in SUPPORTED_MIME_TYPES:
        normalized_name = ensure_extension(candidate.file_name, MIME_TO_EXTENSION[mime_type])
        return MediaCandidate(
            file_id=candidate.file_id,
            file_name=normalized_name,
            mime_type=mime_type,
            file_size=candidate.file_size,
        )

    return (
        "Не удалось распознать формат файла. Для этой версии бота поддерживаются контейнеры: "
        f"{OPENAI_FORMATS_LABEL}."
    )


def media_too_large(size: int | None) -> bool:
    return isinstance(size, int) and size > TELEGRAM_DOWNLOAD_LIMIT_BYTES


def size_limit_text(size: int | None) -> str:
    suffix = f" Сейчас пришёл файл на {size / (1024 * 1024):.1f} МБ." if isinstance(size, int) else ""
    return (
        "Этот файл слишком большой для облачного Telegram-бота: через Bot API можно скачать только файлы до 20 МБ."
        + suffix
    )


def normalize_mime(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized or None


def ensure_extension(file_name: str, preferred_extension: str | None) -> str:
    sanitized = sanitize_file_name(file_name)
    if file_extension(sanitized):
        return sanitized
    return f"{sanitized}{preferred_extension}" if preferred_extension else sanitized


def sanitize_file_name(file_name: str) -> str:
    translation = str.maketrans({char: "_" for char in '\\/:*?"<>|'})
    cleaned = file_name.strip().translate(translation)
    return cleaned or "media"


def file_extension(file_name: str) -> str | None:
    return Path(file_name).suffix.lower() or None


def file_suffix(file_name: str, mime_type: str | None) -> str:
    extension = file_extension(file_name)
    if extension:
        return extension
    return MIME_TO_EXTENSION.get(normalize_mime(mime_type) or "", ".bin")


def write_temp_file(payload: bytes, suffix: str) -> str:
    with NamedTemporaryFile(prefix="tg-transcribe-", suffix=suffix, delete=False) as temp_file:
        temp_file.write(payload)
        return temp_file.name


def split_transcript(text: str, max_chunk_length: int) -> list[str]:
    normalized = text.strip()
    if not normalized:
        return ["Пустой результат распознавания."]

    chunks: list[str] = []
    remainder = normalized
    while len(remainder) > max_chunk_length:
        split_at = find_split_index(remainder, max_chunk_length)
        chunks.append(remainder[:split_at].strip())
        remainder = remainder[split_at:].strip()
    if remainder:
        chunks.append(remainder)
    return [chunk for chunk in chunks if chunk]


def find_split_index(text: str, max_chunk_length: int) -> int:
    window = text[: max_chunk_length + 1]
    for marker in ("\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "):
        index = window.rfind(marker)
        if index > max_chunk_length * 0.5:
            return index + len(marker) if marker.strip() else index
    return max_chunk_length


def load_config() -> AppConfig:
    return AppConfig(
        port=positive_int(os.getenv("PORT"), 3000),
        host=os.getenv("HOST", "0.0.0.0"),
        telegram_bot_token=required("TELEGRAM_BOT_TOKEN"),
        telegram_webhook_secret=required("TELEGRAM_WEBHOOK_SECRET"),
        transcribe_language=optional("TRANSCRIBE_LANGUAGE"),
        transcribe_prompt=optional("TRANSCRIBE_PROMPT"),
        transcribe_concurrency=positive_int(os.getenv("TRANSCRIBE_CONCURRENCY"), 1),
        whisper_model_size=optional("WHISPER_MODEL_SIZE") or "large-v3",
        whisper_device=optional("WHISPER_DEVICE") or "cpu",
        whisper_compute_type=optional("WHISPER_COMPUTE_TYPE") or "int8",
        whisper_cache_dir=optional("WHISPER_CACHE_DIR") or "/tmp/whisper-cache",
        whisper_preload=truthy(os.getenv("WHISPER_PRELOAD", "0")),
    )


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def optional(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    config = load_config()
    Path(config.whisper_cache_dir).mkdir(parents=True, exist_ok=True)
    app = create_app(config)
    web.run_app(app, host=config.host, port=config.port)


if __name__ == "__main__":
    main()
