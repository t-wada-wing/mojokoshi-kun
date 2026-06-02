import { Mp3Encoder } from '@breezystack/lamejs';
import { MAX_TRANSCRIBE_CHUNK_SECONDS } from '../constants';

const TARGET_SAMPLE_RATE = 16000;
const MP3_BITRATE = 64;

export interface CompressResult {
  blob: Blob;
  filename: string;
  compressed: boolean;
}

export interface PrepareAudioResult {
  items: CompressResult[];
  durationSeconds: number;
  chunked: boolean;
}

export interface PrepareAudioOptions {
  signal?: AbortSignal;
  onCompressProgress?: (message: string, percent: number) => void;
}

function resampleToMono16kHz(audioBuffer: AudioBuffer): Float32Array {
  const inputRate = audioBuffer.sampleRate;
  const inputLength = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;

  const mono = new Float32Array(inputLength);
  for (let ch = 0; ch < channelCount; ch += 1) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < inputLength; i += 1) {
      mono[i] += channelData[i] / channelCount;
    }
  }

  if (inputRate === TARGET_SAMPLE_RATE) {
    return mono;
  }

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(inputLength / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const index = Math.floor(sourceIndex);
    const fraction = sourceIndex - index;
    const sampleA = mono[index] ?? 0;
    const sampleB = mono[index + 1] ?? sampleA;
    output[i] = sampleA + (sampleB - sampleA) * fraction;
  }

  return output;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function encodeMp3(samples: Int16Array, signal?: AbortSignal): Uint8Array {
  const encoder = new Mp3Encoder(1, TARGET_SAMPLE_RATE, MP3_BITRATE);
  const blockSize = 1152;
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < samples.length; i += blockSize) {
    assertNotAborted(signal);
    const chunk = samples.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
  }

  const flush = encoder.flush();
  if (flush.length > 0) chunks.push(new Uint8Array(flush));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function replaceExtension(filename: string, ext: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return `${filename}${ext}`;
  return `${filename.slice(0, dotIndex)}${ext}`;
}

function chunkFilename(baseMp3Name: string, index: number, total: number): string {
  if (total <= 1) return baseMp3Name;
  const dotIndex = baseMp3Name.lastIndexOf('.');
  const base = dotIndex === -1 ? baseMp3Name : baseMp3Name.slice(0, dotIndex);
  const ext = dotIndex === -1 ? '.mp3' : baseMp3Name.slice(dotIndex);
  return `${base}_part${index + 1}${ext}`;
}

function sliceAudioBuffer(source: AudioBuffer, startSample: number, lengthSamples: number): AudioBuffer {
  const channels = source.numberOfChannels;
  const rate = source.sampleRate;
  const slice = new AudioBuffer({
    length: lengthSamples,
    numberOfChannels: channels,
    sampleRate: rate,
  });

  for (let ch = 0; ch < channels; ch += 1) {
    slice.getChannelData(ch).set(source.getChannelData(ch).subarray(startSample, startSample + lengthSamples));
  }

  return slice;
}

function encodeBufferToMp3(audioBuffer: AudioBuffer, signal?: AbortSignal): Blob {
  const mono = resampleToMono16kHz(audioBuffer);
  const pcm = floatTo16BitPCM(mono);
  const mp3Data = encodeMp3(pcm, signal);
  return new Blob([Uint8Array.from(mp3Data)], { type: 'audio/mpeg' });
}

export async function compressAudioFile(
  file: File,
  options?: PrepareAudioOptions,
): Promise<PrepareAudioResult> {
  const signal = options?.signal;
  const onProgress = options?.onCompressProgress;

  assertNotAborted(signal);
  const arrayBuffer = await file.arrayBuffer();
  assertNotAborted(signal);
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    assertNotAborted(signal);

    const durationSeconds = audioBuffer.duration;
    const baseName = replaceExtension(file.name, '.mp3');
    const maxChunkSeconds = MAX_TRANSCRIBE_CHUNK_SECONDS;
    const chunkCount = Math.max(1, Math.ceil(durationSeconds / maxChunkSeconds));
    const chunked = chunkCount > 1;

    if (chunked) {
      onProgress?.('25分を超える音声を分割・圧縮しています…（完了までお待ちください）', 8);
    } else {
      onProgress?.('音声を圧縮しています...', 5);
    }

    const items: CompressResult[] = [];
    const samplesPerChunk = Math.floor(maxChunkSeconds * audioBuffer.sampleRate);

    for (let i = 0; i < chunkCount; i += 1) {
      assertNotAborted(signal);
      const startSample = i * samplesPerChunk;
      const remaining = audioBuffer.length - startSample;
      const lengthSamples = Math.min(samplesPerChunk, remaining);
      if (lengthSamples <= 0) break;

      if (chunked) {
        const splitPercent = 8 + Math.round(((i + 0.5) / chunkCount) * 7);
        onProgress?.(
          `25分を超える音声を分割・圧縮しています…（${i + 1}/${chunkCount}）`,
          splitPercent,
        );
      }

      const slice = sliceAudioBuffer(audioBuffer, startSample, lengthSamples);
      const blob = encodeBufferToMp3(slice, signal);
      items.push({
        blob,
        filename: chunkFilename(baseName, i, chunkCount),
        compressed: true,
      });
    }

    return {
      items,
      durationSeconds,
      chunked,
    };
  } finally {
    await audioContext.close();
  }
}

export async function prepareAudioForUpload(
  file: File,
  options?: PrepareAudioOptions,
): Promise<PrepareAudioResult> {
  try {
    return await compressAudioFile(file, options);
  } catch (error) {
    if (options?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }

    if (file.size > 25 * 1024 * 1024) {
      throw new Error(
        '音声ファイルを圧縮できず、サイズが25MBを超えています。別の形式で録音するか、短い録音をお試しください。',
      );
    }

    return {
      items: [
        {
          blob: file,
          filename: file.name,
          compressed: false,
        },
      ],
      durationSeconds: 0,
      chunked: false,
    };
  }
}
