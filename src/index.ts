import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  mediaTooLarge,
  selectMedia,
  sizeLimitText,
  type MediaCandidate,
} from "./media.js";
import {
  buildTelegramFileUrl,
  getEffectiveMessage,
  getTelegramFile,
  sendTelegramMessage,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram.js";
import { transcribeWithOpenAi } from "./transcribe.js";

interface AppConfig {
  port: number;
  host: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  openAiTranscribeModel?: string;
  transcribeLanguage?: string;
  transcribePrompt?: string;
  transcribeConcurrency: number;
}

interface TranscribeJob {
  chatId: number;
  messageId: number;
  messageThreadId?: number;
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}

class PermanentJobError extends Error {}

const PROCESSING_TEXT =
  "Принял файл. Начинаю распознавание, это может занять немного времени.";

const START_TEXT = [
  "Отправь голосовое, аудио, видео, кружок или документ с поддерживаемым аудио/видео контейнером.",
  "Бот ответит отдельным сообщением: сначала подтвердит старт распознавания, потом пришлёт транскрипцию.",
  "Поддерживаемые форматы для документа: flac, m4a, mp3, mp4, mpeg/mpga, ogg, wav, webm.",
  "Ограничение Telegram Bot API: облачный бот может скачать файл только до 20 МБ.",
].join("\n\n");

class JobQueue {
  private readonly pending: TranscribeJob[] = [];
  private active = 0;

  constructor(
    private readonly concurrency: number,
    private readonly worker: (job: TranscribeJob) => Promise<void>,
  ) {}

  enqueue(job: TranscribeJob): void {
    this.pending.push(job);
    this.pump();
  }

  stats(): { active: number; pending: number; concurrency: number } {
    return {
      active: this.active,
      pending: this.pending.length,
      concurrency: this.concurrency,
    };
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) {
        return;
      }
      this.active += 1;
      void this.run(job);
    }
  }

  private async run(job: TranscribeJob): Promise<void> {
    try {
      await this.worker(job);
    } catch (error) {
      console.error("Uncaught queue worker error:", error);
    } finally {
      this.active -= 1;
      this.pump();
    }
  }
}

const config = loadConfig(process.env);
const queue = new JobQueue(config.transcribeConcurrency, async (job) => {
  await processTranscribeJobWithRetry(job, config);
});

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response, config, queue);
  } catch (error) {
    console.error("Request handling failed:", error);
    sendJson(response, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Listening on http://${config.host}:${config.port}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => {
    process.exit(0);
  });
});

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  currentConfig: AppConfig,
  currentQueue: JobQueue,
): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    sendJson(response, 200, {
      ok: true,
      service: "audio-transcribe-telegram-railway-bot",
      queue: currentQueue.stats(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (currentConfig.telegramWebhookSecret && secret !== currentConfig.telegramWebhookSecret) {
      sendText(response, 401, "Unauthorized");
      return;
    }

    const update = await readJson<TelegramUpdate>(request);
    await handleWebhookUpdate(update, currentConfig, currentQueue);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendText(response, 404, "Not found");
}

async function handleWebhookUpdate(
  update: TelegramUpdate,
  currentConfig: AppConfig,
  currentQueue: JobQueue,
): Promise<void> {
  const message = getEffectiveMessage(update);
  if (!message) {
    return;
  }

  if (isStartCommand(message.text)) {
    await replyToOriginal(message, currentConfig, START_TEXT);
    return;
  }

  const selection = selectMedia(message);
  if (!selection.candidate) {
    if (selection.errorText) {
      await replyToOriginal(message, currentConfig, selection.errorText);
    }
    return;
  }

  if (mediaTooLarge(selection.candidate.fileSize)) {
    await replyToOriginal(message, currentConfig, sizeLimitText(selection.candidate.fileSize));
    return;
  }

  currentQueue.enqueue(toJobPayload(message, selection.candidate));

  try {
    await replyToOriginal(message, currentConfig, PROCESSING_TEXT);
  } catch (error) {
    console.error("Failed to send processing message:", error);
  }
}

async function processTranscribeJobWithRetry(job: TranscribeJob, currentConfig: AppConfig): Promise<void> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await processTranscribeJob(job, currentConfig);
      return;
    } catch (error) {
      if (error instanceof PermanentJobError) {
        console.error("Permanent transcription error:", error.message, job);
        return;
      }

      const isLastAttempt = attempt === maxAttempts;
      console.error(`Transcription attempt ${attempt}/${maxAttempts} failed:`, error);
      if (isLastAttempt) {
        await notifyJobFailure(
          job,
          currentConfig,
          "Не удалось распознать файл из-за временной ошибки. Попробуй отправить его ещё раз.",
        );
        return;
      }

      await delay(attempt * 1500);
    }
  }
}

async function processTranscribeJob(job: TranscribeJob, currentConfig: AppConfig): Promise<void> {
  const telegramFile = await getTelegramFile(currentConfig.telegramBotToken, job.fileId);
  if (!telegramFile.file_path) {
    await notifyJobFailure(job, currentConfig, "Telegram не вернул путь к файлу для скачивания.");
    throw new PermanentJobError("Telegram file_path is empty");
  }

  const effectiveFileSize = job.fileSize ?? telegramFile.file_size;
  if (mediaTooLarge(effectiveFileSize)) {
    await notifyJobFailure(job, currentConfig, sizeLimitText(effectiveFileSize));
    throw new PermanentJobError("File exceeds Telegram cloud download limit");
  }

  const downloadUrl = buildTelegramFileUrl(currentConfig.telegramBotToken, telegramFile.file_path);
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    throw new Error(`Telegram file download failed with ${fileResponse.status}`);
  }

  const fileBytes = await fileResponse.arrayBuffer();
  if (mediaTooLarge(fileBytes.byteLength)) {
    await notifyJobFailure(job, currentConfig, sizeLimitText(fileBytes.byteLength));
    throw new PermanentJobError("Downloaded file exceeds Telegram cloud limit");
  }

  const transcript = await transcribeWithOpenAi({
    apiKey: currentConfig.openAiApiKey,
    baseUrl: currentConfig.openAiBaseUrl,
    model: currentConfig.openAiTranscribeModel,
    language: currentConfig.transcribeLanguage,
    prompt: currentConfig.transcribePrompt,
    fileBytes,
    fileName: job.fileName,
    mimeType: job.mimeType,
  });

  if (!transcript) {
    await sendTranscript(job, currentConfig, "Не удалось получить текст из этого файла.");
    return;
  }

  await sendTranscript(job, currentConfig, transcript);
}

function toJobPayload(message: TelegramMessage, media: MediaCandidate): TranscribeJob {
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
    messageThreadId: message.message_thread_id,
    fileId: media.fileId,
    fileName: media.fileName,
    mimeType: media.mimeType,
    fileSize: media.fileSize,
  };
}

async function notifyJobFailure(job: TranscribeJob, currentConfig: AppConfig, text: string): Promise<void> {
  await sendTelegramMessage(currentConfig.telegramBotToken, {
    chat_id: job.chatId,
    text,
    reply_to_message_id: job.messageId,
    message_thread_id: job.messageThreadId,
    disable_web_page_preview: true,
  });
}

async function sendTranscript(job: TranscribeJob, currentConfig: AppConfig, transcript: string): Promise<void> {
  const chunks = splitTranscript(transcript, 3800);
  const total = chunks.length;

  for (const [index, chunk] of chunks.entries()) {
    const prefix = total > 1 ? `Транскрибация ${index + 1}/${total}\n\n` : "Транскрибация\n\n";
    await sendTelegramMessage(currentConfig.telegramBotToken, {
      chat_id: job.chatId,
      text: `${prefix}${chunk}`,
      reply_to_message_id: index === 0 ? job.messageId : undefined,
      message_thread_id: job.messageThreadId,
      disable_web_page_preview: true,
    });
  }
}

async function replyToOriginal(message: TelegramMessage, currentConfig: AppConfig, text: string): Promise<void> {
  await sendTelegramMessage(currentConfig.telegramBotToken, {
    chat_id: message.chat.id,
    text,
    reply_to_message_id: message.message_id,
    message_thread_id: message.message_thread_id,
    disable_web_page_preview: true,
  });
}

function isStartCommand(text?: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/start" || trimmed.startsWith("/start@") || trimmed === "/help" || trimmed.startsWith("/help@");
}

function splitTranscript(text: string, maxChunkLength: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return ["Пустой результат распознавания."];
  }

  const chunks: string[] = [];
  let rest = normalized;

  while (rest.length > maxChunkLength) {
    const splitAt = findSplitIndex(rest, maxChunkLength);
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks.filter(Boolean);
}

function findSplitIndex(text: string, maxChunkLength: number): number {
  const window = text.slice(0, maxChunkLength + 1);
  const candidates = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "];

  for (const marker of candidates) {
    const index = window.lastIndexOf(marker);
    if (index > maxChunkLength * 0.5) {
      return marker.trim() ? index + marker.length : index;
    }
  }

  return maxChunkLength;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(raw) as T;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    port: positiveInteger(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    telegramBotToken: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: required(env.TELEGRAM_WEBHOOK_SECRET, "TELEGRAM_WEBHOOK_SECRET"),
    openAiApiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    openAiBaseUrl: optional(env.OPENAI_BASE_URL),
    openAiTranscribeModel: optional(env.OPENAI_TRANSCRIBE_MODEL) || "gpt-4o-mini-transcribe",
    transcribeLanguage: optional(env.TRANSCRIBE_LANGUAGE),
    transcribePrompt: optional(env.TRANSCRIBE_PROMPT),
    transcribeConcurrency: positiveInteger(env.TRANSCRIBE_CONCURRENCY, 1),
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const normalized = Number.parseInt(value || "", 10);
  if (Number.isFinite(normalized) && normalized > 0) {
    return normalized;
  }
  return fallback;
}
