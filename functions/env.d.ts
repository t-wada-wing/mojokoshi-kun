/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  OPENAI_API_KEY: string;
  DOWNLOAD_PASSCODE: string;
  TRANSCRIBE_MODEL?: string;
  UPLOAD_MAX_PER_IP_HOUR?: string;
  UPLOAD_MAX_PER_IP_DAY?: string;
  UPLOAD_MAX_GLOBAL_DAY?: string;
  UPLOAD_MAX_FILE_MB?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
  APP_BASE_URL?: string;
}

type PagesFunction<E = Env> = (context: {
  request: Request;
  env: E;
  params: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  next: () => Promise<Response>;
  data: Record<string, unknown>;
  functionPath: string;
}) => Response | Promise<Response>;
