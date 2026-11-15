// Tab capture: the browser's screen sharing API gives live frames of a tab while a clip plays in it.
// Frames are only read to find people; none is kept, saved or sent anywhere.
// Desktop Chrome and Edge: getDisplayMedia, MediaStreamTrackProcessor (frames keep coming while this
// page is hidden) and, for this tab, Region Capture (CropTarget) to keep only the player.

export const CAPTURE_REFUSED = "Jester needs to see the tab to read the moves. Press the button again and choose Allow.";
export const NO_TAB_CAPTURE = "This browser cannot grab from a tab. Upload a file instead.";
export const PICK_THIS_TAB = "Pick This tab so Jester can see the player, then try again.";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// Not in TypeScript's DOM library yet.
interface TrackProcessor { readable: ReadableStream<VideoFrame> }
type TrackProcessorClass = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor;
type CropTarget = object;
interface CropTargetClass { fromElement(element: Element): Promise<CropTarget> }
interface CroppableTrack extends MediaStreamTrack { cropTo(target: CropTarget | null): Promise<void> }
interface FocusController { setFocusBehavior(behavior: "focus-captured-surface" | "no-focus-change"): void }
type FocusControllerClass = new () => FocusController;

const env = globalThis as unknown as {
  MediaStreamTrackProcessor?: TrackProcessorClass;
  CropTarget?: CropTargetClass;
  CaptureController?: FocusControllerClass;
};

function isPhone(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** True on a desktop browser that can capture a tab and read its frames. */
export function canCaptureTab(): boolean {
  if (isPhone()) return false;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  return typeof env.MediaStreamTrackProcessor === "function";
}

export function canCropToElement(): boolean {
  return typeof env.CropTarget?.fromElement === "function";
}

/** One frame of the tab. `ageMs` is about how long ago it was captured; use it to correct time stamps. */
export interface TabFrame { frame: VideoFrame; arrivedAt: number; ageMs: number }

export interface TabCapture {
  track: MediaStreamTrack;
  /** True when the frames hold only the element asked for (this tab with Region Capture). */
  cropped: boolean;
  /**
   * Reads frames until `stop()` or the user ends sharing. `onFrame` gets at most one frame every
   * `everyMs` and is waited for; frames in between are dropped. The frame is closed after `onFrame`.
   */
  read(everyMs: number, onFrame: (tab: TabFrame) => void | Promise<void>): Promise<void>;
  /** Ends sharing. Safe to call twice. */
  stop(): void;
  /** Called once when sharing ends, by `stop()` or from the browser's own Stop sharing button. */
  onEnded(callback: () => void): void;
}

type DisplayOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  controller?: FocusController;
};

function captureError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "InvalidStateError" || name === "AbortError") return CAPTURE_REFUSED;
  return NO_TAB_CAPTURE;
}

/**
 * Asks to capture a tab. Must run inside a click handler.
 * "this": offers this tab, then crops to `cropTo` when Region Capture is there.
 * "other": the browser's tab picker without this tab; this page keeps focus.
 */
export async function captureTab(which: "this" | "other", cropTo?: Element): Promise<Result<TabCapture>> {
  if (!canCaptureTab()) return { data: null, error: NO_TAB_CAPTURE };
  const Controller = env.CaptureController;
  const controller = which === "other" && Controller ? new Controller() : undefined;
  const options: DisplayOptions = which === "this"
    ? { video: { frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" }
    : {
      video: { displaySurface: "browser", frameRate: 30 }, audio: false, preferCurrentTab: false,
      selfBrowserSurface: "exclude", surfaceSwitching: "include", monitorTypeSurfaces: "exclude",
      ...(controller ? { controller } : {}),
    };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (error) {
    return { data: null, error: captureError(error) };
  }
  // Must be set right after the picker closes, before anything else waits.
  try { controller?.setFocusBehavior("no-focus-change"); } catch { /* the browser switched focus; that is fine */ }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    return { data: null, error: NO_TAB_CAPTURE };
  }

  let cropped = false;
  if (which === "this" && cropTo && canCropToElement()) {
    try {
      const target = await env.CropTarget!.fromElement(cropTo);
      await (track as CroppableTrack).cropTo(target);
      cropped = true;
    } catch {
      // Cropping only works when this very tab was picked.
      track.stop();
      return { data: null, error: PICK_THIS_TAB };
    }
  }

  const Processor = env.MediaStreamTrackProcessor!;
  const reader = new Processor({ track, maxBufferSize: 2 }).readable.getReader();
  let reading = false;

  let stopped = false;
  const endedCallbacks: (() => void)[] = [];
  const end = () => {
    if (stopped) return;
    stopped = true;
    track.stop();
    // A read waiting for the next frame resolves as done instead of hanging.
    reader.cancel().catch(() => {});
    for (const callback of endedCallbacks.splice(0)) callback();
  };
  track.addEventListener("ended", end);

  return {
    error: null,
    data: {
      track,
      cropped,
      async read(everyMs, onFrame) {
        if (reading) throw new Error("Frames are already being read.");
        reading = true;
        // Frame time stamps (microseconds) run on the capture clock. The smallest gap between
        // arrival and time stamp is the latency of a fresh frame; anything above it is the frame's age.
        let offset = Infinity;
        let lastStamp = -Infinity;
        let lastUsed = -Infinity;
        try {
          while (!stopped) {
            const { value: frame, done } = await reader.read();
            if (done || !frame) break;
            const arrivedAt = performance.now();
            const stampMs = frame.timestamp / 1000;
            let ageMs = 0;
            if (stampMs > lastStamp) {
              offset = Math.min(offset, arrivedAt - stampMs);
              ageMs = Math.min(250, Math.max(0, arrivedAt - (stampMs + offset)));
              lastStamp = stampMs;
            }
            try {
              if (arrivedAt - ageMs - lastUsed >= everyMs - 5) {
                lastUsed = arrivedAt - ageMs;
                await onFrame({ frame, arrivedAt, ageMs });
              }
            } finally {
              frame.close();
            }
          }
        } finally {
          reading = false;
        }
      },
      stop: end,
      onEnded(callback) {
        if (stopped) callback();
        else endedCallbacks.push(callback);
      },
    },
  };
}

/** Draws the frame onto `canvas`, its long side at most `maxSide` pixels. */
export function drawTabFrame(frame: VideoFrame, canvas: HTMLCanvasElement, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(frame.displayWidth, frame.displayHeight));
  const width = Math.max(1, Math.round(frame.displayWidth * scale));
  const height = Math.max(1, Math.round(frame.displayHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.getContext("2d", { willReadFrequently: true })!.drawImage(frame, 0, 0, width, height);
}
