interface TranscribeInput {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  prompt?: string;
  fileBytes: ArrayBuffer;
  fileName: string;
  mimeType?: string;
}

interface OpenAiTranscriptionResponse {
  text?: string;
}

export async function transcribeWithOpenAi(input: TranscribeInput): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new File([input.fileBytes], input.fileName, {
      type: input.mimeType || guessMimeType(input.fileName) || "application/octet-stream",
    }),
  );
  form.set("model", input.model || "gpt-4o-mini-transcribe");

  if (input.language) {
    form.set("language", input.language);
  }

  if (input.prompt) {
    form.set("prompt", input.prompt);
  }

  const endpoint = buildTranscriptionUrl(input.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const excerpt = await readResponseExcerpt(response);
    throw new Error(`STT provider returned ${response.status}: ${excerpt || response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as OpenAiTranscriptionResponse;
    return (payload.text || "").trim();
  }

  return (await response.text()).trim();
}

function buildTranscriptionUrl(baseUrl = "https://api.openai.com/v1"): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/audio/transcriptions")) {
    return trimmed;
  }
  return `${trimmed}/audio/transcriptions`;
}

function guessMimeType(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".flac")) {
    return "audio/flac";
  }
  if (lower.endsWith(".m4a")) {
    return "audio/mp4";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".mpeg") || lower.endsWith(".mpga")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".oga") || lower.endsWith(".ogg")) {
    return "audio/ogg";
  }
  if (lower.endsWith(".wav")) {
    return "audio/wav";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  return undefined;
}

async function readResponseExcerpt(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as { error?: { message?: string }; message?: string };
    return json.error?.message || json.message || "";
  }
  return (await response.text()).slice(0, 300);
}
