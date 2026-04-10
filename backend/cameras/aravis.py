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
            try:
                self._cam.stop_acquisition()
            except Exception:
                pass  # best-effort; camera may already be in an error state

            # Drain any remaining buffers from the stream — holding references
            # to buffers prevents the Aravis stream from releasing the USB/GigE handle.
            if self._stream is not None:
                while True:
                    buf = self._stream.try_pop_buffer()
                    if buf is None:
                        break
                del self._stream
                self._stream = None

            del self._cam
            self._cam = None

            # Force garbage collection to ensure GObject C resources are released.
            # Without this, Python may not finalize the Aravis objects before
            # the process exits, leaving the USB/GigE device locked.
            import gc
            gc.collect()

            # Brief pause to let the USB/GigE stack finish releasing the device.
            import time
            time.sleep(0.2)

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
        model = device.get_string_feature_value("DeviceModelName")
        serial = device.get_string_feature_value("DeviceSerialNumber")
        pixel_format = str(device.get_string_feature_value("PixelFormat"))
        try:
            wb = self.get_white_balance()
            wb_manual = True
        except Exception:
            wb = {"red": 1.0, "green": 1.0, "blue": 1.0}
            wb_manual = False

        def _has_feature(name):
            try:
                return device.get_feature(name) is not None
            except Exception:
                return False

        def _is_available(method_name):
            m = getattr(self._cam, method_name, None)
            if m is None:
                return False
            try:
                return bool(m())
            except Exception:
                return False

        supports = {
            "wb_manual": wb_manual,
            "wb_auto": _has_feature("BalanceWhiteAuto"),
            # Hardware auto-exposure: only advertise if the Aravis Camera API
            # confirms the feature is both present and currently usable. We fall
            # back to a client-side histogram-based auto-exposure in the frontend
            # for cameras that return False here.
            "auto_exposure": _is_available("is_exposure_auto_available"),
            "gamma": _has_feature("Gamma"),
            "roi": _has_feature("OffsetX"),
        }

        # Gain bounds — gain units are camera-specific (dB on some models,
        # linear multiplier on Baumer VCXU). Always pass the native range to
        # the frontend so the slider can span the full usable range.
        try:
            gain = float(self._cam.get_gain())
        except Exception:
            gain = 0.0
        try:
            gain_min, gain_max = self._cam.get_gain_bounds()
            gain_min, gain_max = float(gain_min), float(gain_max)
        except Exception:
            gain_min, gain_max = 0.0, 24.0

        # Exposure bounds — µs. Same reasoning as gain.
        try:
            exposure_min, exposure_max = self._cam.get_exposure_time_bounds()
            exposure_min, exposure_max = float(exposure_min), float(exposure_max)
        except Exception:
            exposure_min, exposure_max = 100.0, 100000.0

        # Gamma info
        gamma = self.get_gamma()
        try:
            gamma_min, gamma_max = device.get_float_feature_bounds("Gamma")
        except Exception:
            gamma_min, gamma_max = 0.5, 2.0

        # ROI / sensor info
        try:
            sensor_width = int(device.get_integer_feature_value("SensorWidth"))
        except Exception:
            sensor_width = width
        try:
            sensor_height = int(device.get_integer_feature_value("SensorHeight"))
        except Exception:
            sensor_height = height
        try:
            offset_x = int(device.get_integer_feature_value("OffsetX"))
        except Exception:
            offset_x = 0
        try:
            offset_y = int(device.get_integer_feature_value("OffsetY"))
        except Exception:
            offset_y = 0
        try:
            roi_width_inc = int(device.get_integer_feature_value("WidthIncrement"))
        except Exception:
            try:
                _, _, roi_width_inc = device.get_integer_feature_bounds("Width")
            except Exception:
                roi_width_inc = 4
        try:
            roi_height_inc = int(device.get_integer_feature_value("HeightIncrement"))
        except Exception:
            try:
                _, _, roi_height_inc = device.get_integer_feature_bounds("Height")
            except Exception:
                roi_height_inc = 4

        return {
            "model": model,
            "serial": serial,
            "width": int(width),
            "height": int(height),
            "exposure": float(exposure),
            "exposure_min": exposure_min,
            "exposure_max": exposure_max,
            "gain": float(gain),
            "gain_min": gain_min,
            "gain_max": gain_max,
            "pixel_format": pixel_format,
            "device_id": self._device_id,
            "wb_red": wb["red"],
            "wb_green": wb["green"],
            "wb_blue": wb["blue"],
            "wb_manual_supported": wb_manual,
            "supports": supports,
            "gamma": float(gamma),
            "gamma_min": float(gamma_min),
            "gamma_max": float(gamma_max),
            "roi": {"offset_x": offset_x, "offset_y": offset_y, "width": width, "height": height},
            "sensor_width": sensor_width,
            "sensor_height": sensor_height,
            "roi_width_inc": int(roi_width_inc),
            "roi_height_inc": int(roi_height_inc),
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

    def set_gamma(self, value: float) -> None:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        self._cam.get_device().set_float_feature_value("Gamma", value)

    def get_gamma(self) -> float:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        try:
            return float(self._cam.get_device().get_float_feature_value("Gamma"))
        except Exception:
            return 1.0

    def set_auto_exposure(self) -> float:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        import logging
        device = self._cam.get_device()
        device.set_string_feature_value("ExposureAuto", "Once")
        prev_exposure = 0.0
        for _ in range(40):  # up to 2s at 50ms intervals
            time.sleep(0.05)
            mode = device.get_string_feature_value("ExposureAuto")
            cur_exposure = self._cam.get_exposure_time()
            if mode == "Off":
                break
            if cur_exposure == prev_exposure and prev_exposure != 0.0:
                break
            prev_exposure = cur_exposure
        else:
            logging.getLogger(__name__).warning(
                "ExposureAuto did not converge within 2 s"
            )
        return float(self._cam.get_exposure_time())

    def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
        """Set camera ROI. Destroys and recreates the stream to ensure buffers
        match the new payload size — simply reallocating buffers on the existing
        stream does not work reliably on all cameras."""
        if self._cam is None:
            raise RuntimeError("Camera not open")
        import logging, gc
        _log = logging.getLogger(__name__)
        device = self._cam.get_device()

        # 1. Stop acquisition and destroy existing stream
        self._cam.stop_acquisition()
        while self._stream.try_pop_buffer() is not None:
            pass
        del self._stream
        self._stream = None
        gc.collect()
        time.sleep(0.2)

        # 2. Set ROI dimensions
        device.set_integer_feature_value("OffsetX", 0)
        device.set_integer_feature_value("OffsetY", 0)
        device.set_integer_feature_value("Width", width)
        device.set_integer_feature_value("Height", height)
        device.set_integer_feature_value("OffsetX", offset_x)
        device.set_integer_feature_value("OffsetY", offset_y)

        # Verify
        actual_w = int(device.get_integer_feature_value("Width"))
        actual_h = int(device.get_integer_feature_value("Height"))
        _log.info("ROI set: requested %dx%d+%d+%d, actual %dx%d+%d+%d",
                   width, height, offset_x, offset_y,
                   actual_w, actual_h,
                   int(device.get_integer_feature_value("OffsetX")),
                   int(device.get_integer_feature_value("OffsetY")))
        if actual_w != width or actual_h != height:
            _log.warning("Camera did not accept ROI (requested %dx%d, got %dx%d)",
                         width, height, actual_w, actual_h)

        # 3. Create fresh stream with correctly-sized buffers
        self._stream = self._cam.create_stream(None, None)
        payload = self._cam.get_payload()
        for _ in range(10):
            self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
        self._cam.start_acquisition()
        time.sleep(0.3)  # let camera produce first frames

    def reset_roi(self) -> None:
        if self._cam is None:
            raise RuntimeError("Camera not open")
        device = self._cam.get_device()
        sw = int(device.get_integer_feature_value("SensorWidth"))
        sh = int(device.get_integer_feature_value("SensorHeight"))
        self.set_roi(0, 0, sw, sh)


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
