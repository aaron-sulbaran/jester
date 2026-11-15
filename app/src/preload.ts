// Downloads the tracking models into the browser's Cache Storage while the player is still on the start screen, and
// warms the MediaPipe runtime files. Every later load (the camera tracker, clip analysis) then reads the models from
// Cache Storage instead of the network, even in a new session. Nothing is created here.
import { MP_BUNDLE, MP_WASM, MODEL_URLS, HAND_MODEL_URL, cachedModelOptions } from "../../spikes/pose-match/webcam.mjs";

const OBJECT_MODEL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";
let started = false;

export function preloadModels() {
  if (started) return;
  started = true;
  const warm = (url: string) => fetch(url, { cache: "force-cache", priority: "low" } as RequestInit).catch(() => {});
  void (async () => {
    // The runtime first (small), then the body and hand models together, then the object detector.
    await Promise.all([MP_BUNDLE, `${MP_WASM}/vision_wasm_internal.js`, `${MP_WASM}/vision_wasm_internal.wasm`].map(warm));
    await Promise.all([cachedModelOptions(MODEL_URLS.full), cachedModelOptions(HAND_MODEL_URL)]);
    await cachedModelOptions(OBJECT_MODEL);
  })();
}
