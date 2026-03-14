import type { TelegramFileLike, TelegramMessage } from "./telegram.js";

export type MediaSourceType = "voice" | "audio" | "video" | "video_note" | "document";

export interface MediaCandidate {
  sourceType: MediaSourceType;
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}

export interface MediaSelectionResult {
  candidate?: MediaCandidate;
  errorText?: string;
}

const SUPPORTED_EXTENSIONS = new Set([
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
]);

const SUPPORTED_MIME_TYPES = new Set([
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
]);

const MIME_TO_EXTENSION: Record<string, string> = {
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
};

const OPENAI_FORMATS_LABEL = "flac, m4a, mp3, mp4, mpeg/mpga, ogg, wav, webm";

export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export function selectMedia(message: TelegramMessage): MediaSelectionResult {
  if (message.voice) {
    return {
      candidate: buildCandidate("voice", message.voice, `voice-${message.message_id}.ogg`, "audio/ogg"),
    };
  }

  if (message.audio) {
    const candidate = buildCandidate("audio", message.audio, `audio-${message.message_id}.mp3`, message.audio.mime_type);
    return ensureSupported(candidate);
  }

  if (message.video) {
    const candidate = buildCandidate("video", message.video, `video-${message.message_id}.mp4`, "video/mp4");
    return ensureSupported(candidate);
  }

  if (message.video_note) {
    return {
      candidate: buildCandidate("video_note", message.video_note, `video-note-${message.message_id}.mp4`, "video/mp4"),
    };
  }

  if (message.document) {
    const candidate = buildCandidate(
      "document",
      message.document,
      message.document.file_name || `document-${message.message_id}`,
      message.document.mime_type,
    );
    return ensureSupported(candidate);
  }

  return { errorText: undefined };
}

export function mediaTooLarge(size?: number): boolean {
  return typeof size === "number" && size > TELEGRAM_DOWNLOAD_LIMIT_BYTES;
}

export function sizeLimitText(size?: number): string {
  const human = typeof size === "number" ? ` Сейчас пришёл файл на ${formatMegabytes(size)} МБ.` : "";
  return (
    "Этот файл слишком большой для облачного Telegram-бота: через Bot API можно скачать только файлы до 20 МБ." +
    human
  );
}

function ensureSupported(candidate: MediaCandidate): MediaSelectionResult {
  const ext = extensionOf(candidate.fileName);
  const mime = normalizeMime(candidate.mimeType);

  if (ext && SUPPORTED_EXTENSIONS.has(ext)) {
    return { candidate };
  }

  if (mime && SUPPORTED_MIME_TYPES.has(mime)) {
    const normalizedName = ensureExtension(candidate.fileName, MIME_TO_EXTENSION[mime]);
    return {
      candidate: {
        ...candidate,
        fileName: normalizedName,
        mimeType: mime,
      },
    };
  }

  return {
    errorText:
      "Не удалось распознать формат файла. Для этой версии бота поддерживаются контейнеры: " +
      OPENAI_FORMATS_LABEL +
      ".",
  };
}

function buildCandidate(
  sourceType: MediaSourceType,
  file: TelegramFileLike,
  fallbackName: string,
  fallbackMime?: string,
): MediaCandidate {
  const rawName = file.file_name || fallbackName;
  const mime = normalizeMime(file.mime_type || fallbackMime);
  const fileName = ensureExtension(rawName, mime ? MIME_TO_EXTENSION[mime] : undefined);

  return {
    sourceType,
    fileId: file.file_id,
    fileName,
    mimeType: mime,
    fileSize: file.file_size,
  };
}

function ensureExtension(fileName: string, preferredExtension?: string): string {
  const trimmed = sanitizeFileName(fileName);
  if (extensionOf(trimmed)) {
    return trimmed;
  }
  return preferredExtension ? `${trimmed}${preferredExtension}` : trimmed;
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/[\\/:*?"<>|]+/g, "_");
  return normalized || "media";
}

function normalizeMime(mimeType?: string): string | undefined {
  return mimeType?.trim().toLowerCase() || undefined;
}

function extensionOf(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return undefined;
  }

  return fileName.slice(lastDot).toLowerCase();
}

function formatMegabytes(size: number): string {
  return (size / (1024 * 1024)).toFixed(1);
}
