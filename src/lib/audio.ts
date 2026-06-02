import { Mp3Encoder } from '@breezystack/lamejs';

const TARGET_SAMPLE_RATE = 16000;
const MP3_BITRATE = 64;

export interface CompressResult {
  blob: Blob;
  filename: string;
  compressed: boolean;
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

export async function compressAudioFile(file: File, signal?: AbortSignal): Promise<CompressResult> {
  assertNotAborted(signal);
  const arrayBuffer = await file.arrayBuffer();
  assertNotAborted(signal);
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    assertNotAborted(signal);
    const mono = resampleToMono16kHz(audioBuffer);
    const pcm = floatTo16BitPCM(mono);
    const mp3Data = encodeMp3(pcm, signal);
    const blob = new Blob([Uint8Array.from(mp3Data)], { type: 'audio/mpeg' });

    return {
      blob,
      filename: replaceExtension(file.name, '.mp3'),
      compressed: true,
    };
  } finally {
    await audioContext.close();
  }
}

export async function prepareAudioForUpload(
  file: File,
  signal?: AbortSignal,
): Promise<CompressResult> {
  try {
    return await compressAudioFile(file, signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }

    if (file.size > 25 * 1024 * 1024) {
      throw new Error(
        '音声ファイルを圧縮できず、サイズが25MBを超えています。別の形式で録音するか、短い録音をお試しください。',
      );
    }

    return {
      blob: file,
      filename: file.name,
      compressed: false,
    };
  }
}
