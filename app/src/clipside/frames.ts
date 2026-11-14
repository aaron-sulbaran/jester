// Reads a video file as frames at fixed times, in order. Mediabunny (WebCodecs) first; when it
// cannot decode the file, the <video> element is stepped with seeks instead.


export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Decoder = "webcodecs" | "video-element";

export interface FrameOptions { sampleHz: number; maxMs: number; maxSide: number }
export interface Frame { tMs: number; canvas: FrameCanvas; index: number; count: number }
export interface VideoInfo {
  /** Display size after rotation, in pixels, before the size limit. */
  width: number;
  height: number;
  /** The whole file's duration, which may be longer than what is read. */
  durationMs: number;
  decoder: Decoder;
  /** Number of frames read. */
  count: number;
}

export const CANNOT_READ = "This browser cannot read that video. Save it as an H.264 MP4 and try again.";

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The sample times, in ms: i * 1000 / sampleHz, below both the clip's end and maxMs. */
function sampleTimes(durationMs: number, options: FrameOptions): number[] {
  const end = Math.min(durationMs, options.maxMs);
  const times: number[] = [];
  for (let i = 0; i * 1000 / options.sampleHz < end; i++) times.push(i * 1000 / options.sampleHz);
  return times;
}

function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Thrown when Mediabunny cannot start decoding, so the fallback may take over. */
class CannotStart extends Error {}

async function readWithMediabunny(
  file: File,
  options: FrameOptions,
  onFrame: (frame: Frame) => Promise<void>,
): Promise<VideoInfo> {
  // Loaded on first use, so the main page does not carry the decoder until a video is picked.
  let mediabunny: typeof import("mediabunny");
  try {
    mediabunny = await import("mediabunny");
  } catch {
    throw new CannotStart();
  }
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = mediabunny;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let started = false;
  try {
    let track;
    try {
      track = await input.getPrimaryVideoTrack();
    } catch {
      throw new CannotStart();
    }
    if (!track || !(await track.canDecode())) throw new CannotStart();
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const first = await track.getFirstTimestamp();
    const durationMs = (await track.computeDuration()) * 1000;
    const times = sampleTimes(durationMs, options);
    const size = fitWithin(width, height, options.maxSide);
    // Rotation defaults to the file's rotation flag; the output size is after rotation.
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: "fill" });
    // A frame is "the last one starting at or before t", so a track that starts a little after 0 gets its first frame at 0.
    const wanted = times.map((tMs) => Math.max(first, tMs / 1000));
    let index = 0;
    let previous: FrameCanvas | null = null;
    for await (const wrapped of sink.canvasesAtTimestamps(wanted)) {
      const canvas: FrameCanvas | null = wrapped?.canvas ?? previous;
      if (!canvas) throw new CannotStart();
      started = true;
      previous = canvas;
      await onFrame({ tMs: times[index]!, canvas, index, count: times.length });
      index++;
      await nextTask();
    }
    if (index === 0) throw new CannotStart();
    return { width, height, durationMs, decoder: "webcodecs", count: index };
  } catch (error) {
    if (!started) throw new CannotStart();
    throw error;
  } finally {
    input.dispose();
  }
}

function waitFor(el: HTMLVideoElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      el.removeEventListener("error", onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    el.addEventListener(event, onEvent);
    el.addEventListener("error", onError);
  });
}

async function readWithVideoElement(
  video: HTMLVideoElement,
  options: FrameOptions,
  onFrame: (frame: Frame) => Promise<void>,
): Promise<VideoInfo | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && !(await waitFor(video, "loadeddata", 10000))) return null;
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) return null;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const durationMs = video.duration * 1000;
  const times = sampleTimes(durationMs, options);
  const size = fitWithin(width, height, options.maxSide);
  for (const [index, tMs] of times.entries()) {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    video.currentTime = tMs / 1000;
    await waitFor(video, "seeked", 3000);
    canvas.getContext("2d")!.drawImage(video, 0, 0, size.width, size.height);
    await onFrame({ tMs, canvas, index, count: times.length });
    await nextTask();
  }
  video.currentTime = 0;
  return { width, height, durationMs, decoder: "video-element", count: times.length };
}

/**
 * Reads the file at fixed times `i * 1000 / sampleHz`, calling `onFrame` for each and waiting for it.
 * `video` must already have the file as its source; it is only used when Mediabunny cannot decode.
 */
export async function readFrames(
  file: File,
  video: HTMLVideoElement,
  options: FrameOptions,
  onFrame: (frame: Frame) => Promise<void>,
): Promise<{ data: VideoInfo; error: null } | { data: null; error: string }> {
  try {
    return { data: await readWithMediabunny(file, options, onFrame), error: null };
  } catch (error) {
    if (!(error instanceof CannotStart)) return { data: null, error: CANNOT_READ };
  }
  try {
    const info = await readWithVideoElement(video, options, onFrame);
    return info ? { data: info, error: null } : { data: null, error: CANNOT_READ };
  } catch {
    return { data: null, error: CANNOT_READ };
  }
}
