export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramFileLike {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramAudio extends TelegramFileLike {
  performer?: string;
  title?: string;
}

export interface TelegramDocument extends TelegramFileLike {}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  voice?: TelegramFileLike;
  audio?: TelegramAudio;
  video?: TelegramFileLike;
  video_note?: TelegramFileLike;
  document?: TelegramDocument;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramOkResponse<T> {
  ok: true;
  result: T;
}

interface TelegramErrorResponse {
  ok: false;
  error_code: number;
  description: string;
}

type TelegramResponse<T> = TelegramOkResponse<T> | TelegramErrorResponse;

export interface TelegramSendMessageParams {
  chat_id: number;
  text: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
  disable_web_page_preview?: boolean;
}

export function getEffectiveMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

export async function telegramApi<T>(
  token: string,
  method: string,
  payload: unknown,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !data.ok) {
    const description = data.ok ? response.statusText : data.description;
    throw new Error(`Telegram API ${method} failed: ${description}`);
  }

  return data.result;
}

export async function sendTelegramMessage(
  token: string,
  params: TelegramSendMessageParams,
): Promise<void> {
  await telegramApi(token, "sendMessage", params);
}

export async function getTelegramFile(token: string, fileId: string): Promise<TelegramFile> {
  return telegramApi<TelegramFile>(token, "getFile", { file_id: fileId });
}

export function buildTelegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}
