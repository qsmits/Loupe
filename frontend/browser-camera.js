import { state } from './state.js';
import { apiFetch } from './api.js';
import { setImageSize } from './viewport.js';
import { img, showStatus, resizeCanvas } from './render.js';
import { updateDropOverlay } from './sidebar.js';

const videoEl = document.getElementById("browser-cam-video");

export function isBrowserCameraActive() {
  return state.browserCamera?.active === true;
}

// Enumerate video input devices and store in state.browserCameraDevices.
// Labels are only populated after permission has been granted.
async function _enumerateAndRefresh() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.browserCameraDevices = devices
      .filter(d => d.kind === "videoinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));
    // Refresh dropdown so individual entries appear
    const { loadCameraList } = await import('./sidebar.js');
    await loadCameraList();
  } catch { /* permission denied or API unavailable */ }
}

export async function startBrowserCamera(deviceId = null) {
  const constraints = deviceId
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } }
    : { video: { width: { ideal: 1920 }, height: { ideal: 1080 } } };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Stop any previous stream
    state.browserCamera?.stream?.getTracks().forEach(t => t.stop());
    const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
    state.browserCamera = { active: true, stream, deviceId: activeDeviceId };
    videoEl.srcObject = stream;
    await new Promise(resolve => {
      if (videoEl.readyState >= 1) { resolve(); return; }
      videoEl.addEventListener("loadedmetadata", resolve, { once: true });
    });
    await videoEl.play();
    videoEl.hidden = false;
    img.style.display = "none";
    document.body.classList.remove("no-camera");
    setImageSize(videoEl.videoWidth, videoEl.videoHeight);
    resizeCanvas();
    const label = stream.getVideoTracks()[0]?.label || "Browser camera";
    showStatus(`${label} active`);
    updateDropOverlay();
    // Enumerate after permission granted so labels are available
    await _enumerateAndRefresh();
  } catch (err) {
    showStatus("Camera access denied: " + err.message);
    state.browserCamera = { active: false, stream: null, deviceId: null };
  }
}

export function stopBrowserCamera() {
  state.browserCamera?.stream?.getTracks().forEach(t => t.stop());
  state.browserCamera = { active: false, stream: null, deviceId: null };
  videoEl.hidden = true;
  videoEl.srcObject = null;
  img.style.display = "";
  updateDropOverlay();
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
