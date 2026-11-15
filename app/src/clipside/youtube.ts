// The YouTube IFrame Player API, loaded once from youtube.com. Only the official embedded player
// is used; the video is never fetched by this page.

export const EMBED_OFF = "This video cannot be shown here. Open it in another tab and use Grab from another tab.";
const NOT_FOUND = "That video was not found. It may be private or removed.";
const PLAYER_FAILED = "The YouTube player could not play this video. Try another link.";
const API_FAILED = "The YouTube player did not load. Check the connection and try again.";

export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
}

interface YtEvent { data: number; target: YtPlayer }
interface YtNamespace {
  Player: new (element: HTMLElement | string, options: {
    width?: number | string; height?: number | string; videoId: string;
    playerVars?: Record<string, string | number>;
    events?: { onReady?: (e: YtEvent) => void; onStateChange?: (e: YtEvent) => void; onError?: (e: YtEvent) => void };
  }) => YtPlayer;
}

const env = window as unknown as { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };

let apiPromise: Promise<YtNamespace> | null = null;

function loadApi(): Promise<YtNamespace> {
  apiPromise ??= new Promise<YtNamespace>((resolve, reject) => {
    if (env.YT?.Player) return resolve(env.YT);
    const previous = env.onYouTubeIframeAPIReady;
    env.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (env.YT) resolve(env.YT);
      else reject(new Error("no YT"));
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("script failed"));
    document.head.append(script);
  });
  apiPromise.catch(() => { apiPromise = null; });
  return apiPromise;
}

export function errorSentence(code: number): string {
  if (code === 101 || code === 150) return EMBED_OFF;
  if (code === 100) return NOT_FOUND;
  return PLAYER_FAILED;
}

export interface PlayerHandlers {
  onState?: (state: number) => void;
  onError?: (sentence: string, code: number) => void;
}

/** Puts a player for `videoId` into `host` (replacing what is there) and waits until it takes calls. */
export async function createPlayer(
  host: HTMLElement,
  videoId: string,
  startSeconds: number,
  handlers: PlayerHandlers = {},
): Promise<{ data: YtPlayer; error: null } | { data: null; error: string }> {
  let YT: YtNamespace;
  try {
    YT = await loadApi();
  } catch {
    return { data: null, error: API_FAILED };
  }
  const slot = document.createElement("div");
  host.replaceChildren(slot);
  return new Promise((resolve) => {
    let ready = false;
    const player = new YT.Player(slot, {
      width: "100%", height: "100%", videoId,
      playerVars: {
        playsinline: 1, rel: 0, controls: 1, iv_load_policy: 3, start: Math.floor(startSeconds),
        origin: location.origin,
      },
      events: {
        onReady: () => { ready = true; resolve({ data: player, error: null }); },
        onStateChange: (e) => handlers.onState?.(e.data),
        onError: (e) => {
          const sentence = errorSentence(e.data);
          if (!ready) resolve({ data: null, error: sentence });
          handlers.onError?.(sentence, e.data);
        },
      },
    });
  });
}
