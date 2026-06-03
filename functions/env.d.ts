/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  OPENAI_API_KEY: string;
  DOWNLOAD_PASSCODE: string;
  TRANSCRIBE_MODEL?: string;
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
