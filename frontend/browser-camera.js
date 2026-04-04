import { state } from './state.js';
import { apiFetch } from './api.js';
import { setImageSize } from './viewport.js';
import { img, showStatus, resizeCanvas } from './render.js';

const videoEl = document.getElementById("browser-cam-video");

export function isBrowserCameraActive() {
  return state.browserCamera?.active === true;
}

export async function startBrowserCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // Stop any previous stream
    state.browserCamera?.stream?.getTracks().forEach(t => t.stop());
    state.browserCamera = { active: true, stream };
    videoEl.srcObject = stream;
    await new Promise(resolve => { videoEl.onloadedmetadata = resolve; });
    videoEl.play();
    videoEl.hidden = false;
    img.style.display = "none";
    document.body.classList.remove("no-camera");
    setImageSize(videoEl.videoWidth, videoEl.videoHeight);
    resizeCanvas();
    showStatus("Browser camera active");
  } catch (err) {
    showStatus("Camera access denied: " + err.message);
    state.browserCamera = { active: false, stream: null };
  }
}

export function stopBrowserCamera() {
  state.browserCamera?.stream?.getTracks().forEach(t => t.stop());
  state.browserCamera = { active: false, stream: null };
  videoEl.hidden = true;
  videoEl.srcObject = null;
  img.style.display = "";
}

export async function captureBrowserFrame() {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  offscreen.getContext("2d").drawImage(videoEl, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    offscreen.toBlob(async blob => {
      if (!blob) { reject(new Error("Failed to capture frame")); return; }
      try {
        const fd = new FormData();
        fd.append("file", blob, "frame.jpg");
        const r = await apiFetch("/load-image", { method: "POST", body: fd });
        if (!r.ok) throw new Error(await r.text());
        const { width, height } = await r.json();
        const url = URL.createObjectURL(blob);
        const bmpImg = new Image();
        bmpImg.onload = () => { URL.revokeObjectURL(url); resolve({ image: bmpImg, width, height }); };
        bmpImg.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Frame decode failed")); };
        bmpImg.src = url;
      } catch (err) {
        reject(err);
      }
    }, "image/jpeg", 0.95);
  });
}
