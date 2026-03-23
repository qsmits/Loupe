import time
import numpy as np
from .base import BaseCamera

try:
    import gi
    gi.require_version('Aravis', '0.8')
    from gi.repository import Aravis
    ARAVIS_AVAILABLE = True
except (ImportError, ValueError):
    ARAVIS_AVAILABLE = False


class AravisCamera(BaseCamera):
    def __init__(self, device_id: str | None = None):
        if not ARAVIS_AVAILABLE:
            raise ImportError(
                "Aravis GI not available. Install aravis and set GST_PLUGIN_PATH."
            )
        self._device_id = device_id  # None → first available
        self._cam = None
        self._stream = None

    def open(self) -> None:
        Aravis.update_device_list()
        self._cam = Aravis.Camera.new(self._device_id)  # None → first available
        try:
            if self._device_id is None:
                try:
                    self._device_id = self._cam.get_device().get_id()
                except Exception:
                    pass  # best-effort; get_info() will return device_id: null
            self._cam.set_acquisition_mode(Aravis.AcquisitionMode.CONTINUOUS)
            self._stream = self._cam.create_stream(None, None)
            payload = self._cam.get_payload()
            for _ in range(10):
                self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
            self._cam.start_acquisition()
        except Exception:
            self._stream = None
            self._cam = None  # release libusb handle immediately on partial-open failure
            raise

    def close(self) -> None:
        if self._cam is not None:
            self._cam.stop_acquisition()
            self._stream = None
            self._cam = None

    def get_frame(self) -> np.ndarray:
        buf = self._stream.timeout_pop_buffer(2_000_000)  # 2 s timeout in µs
        if buf is None or buf.get_status() != Aravis.BufferStatus.SUCCESS:
            if buf is not None:
                self._stream.push_buffer(buf)
            raise RuntimeError("Failed to acquire frame from camera")

        width = buf.get_image_width()
        height = buf.get_image_height()
        pixel_format = buf.get_image_pixel_format()
        # Slice to exact pixel data — Aravis buffers may include padding bytes
        # beyond the image payload (e.g. GigE/USB3 Vision alignment bytes).
        raw = np.frombuffer(buf.get_data(), dtype=np.uint8)
        self._stream.push_buffer(buf)

        # Mono8
        if pixel_format == Aravis.PIXEL_FORMAT_MONO_8:
            data = raw[:height * width]
            import cv2
            return cv2.cvtColor(data.reshape((height, width)), cv2.COLOR_GRAY2BGR)

        # BayerRG8 (common Bayer pattern on GigE Vision / USB3 Vision cameras)
        if pixel_format == Aravis.PIXEL_FORMAT_BAYER_RG_8:
            data = raw[:height * width]
            import cv2
            return cv2.cvtColor(data.reshape((height, width)), cv2.COLOR_BayerRG2BGR)

        # BGR8 / RGB8
        if pixel_format == Aravis.PIXEL_FORMAT_BGR_8_PACKED:
            data = raw[:height * width * 3]
            return data.reshape((height, width, 3))

        if pixel_format == Aravis.PIXEL_FORMAT_RGB_8_PACKED:
            data = raw[:height * width * 3]
            import cv2
            return cv2.cvtColor(data.reshape((height, width, 3)), cv2.COLOR_RGB2BGR)

        raise RuntimeError(f"Unsupported pixel format: {pixel_format:#010x}")

    def set_exposure(self, microseconds: float) -> None:
        self._cam.set_exposure_time(microseconds)

    def set_gain(self, db: float) -> None:
        self._cam.set_gain(db)

    def set_pixel_format(self, fmt: str) -> None:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        self._cam.stop_acquisition()
        try:
            self._cam.get_device().set_string_feature_value("PixelFormat", fmt)
            # Re-push stream buffers — payload size may have changed
            payload = self._cam.get_payload()
            while self._stream.try_pop_buffer() is not None:
                pass  # drain old buffers
            for _ in range(10):
                self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
        finally:
            self._cam.start_acquisition()

    def get_info(self) -> dict[str, object]:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        device = self._cam.get_device()
        width = int(device.get_integer_feature_value("Width"))
        height = int(device.get_integer_feature_value("Height"))
        exposure = self._cam.get_exposure_time()
        gain = self._cam.get_gain()
        model = device.get_string_feature_value("DeviceModelName")
        serial = device.get_string_feature_value("DeviceSerialNumber")
        pixel_format = str(device.get_string_feature_value("PixelFormat"))
        try:
            wb = self.get_white_balance()
            wb_manual = True
        except Exception:
            wb = {"red": 1.0, "green": 1.0, "blue": 1.0}
            wb_manual = False
        return {
            "model": model,
            "serial": serial,
            "width": int(width),
            "height": int(height),
            "exposure": float(exposure),
            "gain": float(gain),
            "pixel_format": pixel_format,
            "device_id": self._device_id,
            "wb_red": wb["red"],
            "wb_green": wb["green"],
            "wb_blue": wb["blue"],
            "wb_manual_supported": wb_manual,
        }

    def get_white_balance(self) -> dict[str, float]:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        device = self._cam.get_device()
        result = {}
        for ch in ("Red", "Green", "Blue"):
            device.set_string_feature_value("BalanceRatioSelector", ch)
            result[ch.lower()] = float(device.get_float_feature_value("BalanceRatio"))
        return result

    def set_white_balance_auto(self) -> dict[str, float]:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        import logging
        device = self._cam.get_device()
        device.set_string_feature_value("BalanceWhiteAuto", "Once")
        for _ in range(20):
            time.sleep(0.05)
            if device.get_string_feature_value("BalanceWhiteAuto") == "Off":
                break
        else:
            logging.getLogger(__name__).warning(
                "BalanceWhiteAuto did not return to 'Off' within 1 s"
            )
        try:
            return self.get_white_balance()
        except Exception:
            return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        device = self._cam.get_device()
        device.set_string_feature_value("BalanceRatioSelector", channel)
        device.set_float_feature_value("BalanceRatio", value)


def list_aravis_cameras() -> list[dict]:
    """
    Return list of available Aravis cameras as
    [{"id": str, "vendor": str, "label": str}, ...].
    Returns [] if Aravis is not available.
    'label' is a human-readable display string for the UI dropdown.
    """
    if not ARAVIS_AVAILABLE:
        return []
    Aravis.update_device_list()
    cameras = []
    for i in range(Aravis.get_n_devices()):
        device_id = Aravis.get_device_id(i)
        vendor = Aravis.get_device_vendor(i) or "Unknown"
        cameras.append({
            "id": device_id,
            "vendor": vendor,
            "label": f"{vendor} — {device_id}",
        })
    return cameras
