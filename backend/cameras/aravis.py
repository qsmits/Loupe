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


def _is_access_denied(exc: BaseException) -> bool:
    # GigE Vision GVCP returns this status when the camera will not accept the
    # write because some other session holds Control Access. Aravis surfaces
    # it as a GLib GError with these tokens in the message.
    msg = str(exc).lower()
    return "access-denied" in msg or "access denied" in msg


def _is_transient_open_error(exc: BaseException) -> bool:
    # Errors that typically clear within a few seconds: control still held by
    # a dying prior session, or stale discovery cache after the device went
    # offline briefly (link bounce, switch reconfig, USB re-enumeration).
    if _is_access_denied(exc):
        return True
    msg = str(exc).lower()
    return "not found" in msg or "timeout" in msg


class AravisCamera(BaseCamera):
    def __init__(self, device_id: str | None = None):
        if not ARAVIS_AVAILABLE:
            raise ImportError(
                "Aravis GI not available. Install aravis and set GST_PLUGIN_PATH."
            )
        self._device_id = device_id  # None → first available
        self._cam = None
        self._stream = None
        self._transient_failures = 0  # buffer status != SUCCESS or pop timeouts
        self._last_error: str | None = None

    def open(self) -> None:
        # First-open after a crashed/killed previous session is a known weak
        # spot for GigE Vision: the camera may still hold GVCP "Control Access"
        # (heartbeat hasn't expired → register writes get access-denied), or
        # discovery may briefly miss the device (stale device list → "not
        # found"). Both clear within a few seconds. Retry rather than making
        # the user "wiggle" the camera switcher to recover.
        import logging
        log = logging.getLogger(__name__)
        max_attempts = 4
        last_err: Exception | None = None
        for attempt in range(max_attempts):
            # Re-run discovery each attempt — needed for the "not found" case
            # where a previous session left the device cache stale.
            try:
                Aravis.update_device_list()
            except Exception:
                pass
            try:
                self._open_once()
                if attempt > 0:
                    log.info("Camera opened after %d retries", attempt)
                return
            except Exception as e:
                last_err = e
                self._teardown_partial()
                if not _is_transient_open_error(e):
                    raise
                if attempt + 1 < max_attempts:
                    log.warning(
                        "Camera open attempt %d/%d failed transiently (%s); retrying after heartbeat window",
                        attempt + 1, max_attempts, e,
                    )
                    time.sleep(2.0)
        assert last_err is not None
        raise last_err

    def _open_once(self) -> None:
        self._cam = Aravis.Camera.new(self._device_id)  # None → first available
        try:
            if self._device_id is None:
                try:
                    self._device_id = self._cam.get_device().get_id()
                except Exception:
                    pass  # best-effort; get_info() will return device_id: null
            self._configure_gige_packet_size()
            self._cam.set_acquisition_mode(Aravis.AcquisitionMode.CONTINUOUS)
            # Force TriggerMode=Off so the camera streams continuously regardless
            # of what trigger configuration a previous session left behind. With
            # TriggerMode=On and AcquisitionFrameCount=1 (the Manta's idle state)
            # the camera only emits one frame per software trigger, even with
            # AcquisitionMode=Continuous.
            self._disable_external_trigger()
            self._stream = self._cam.create_stream(None, None)
            self._configure_gige_socket_buffer()
            payload = self._cam.get_payload()
            # 30 buffers gives the reader headroom when the consumer is slow
            # (MJPEG encode + frontend keepup) without using too much memory
            # (≈85 MB at 1936×1458 mono).
            for _ in range(30):
                self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
            self._cam.start_acquisition()
        except Exception:
            self._teardown_partial()
            raise

    def _disable_external_trigger(self) -> None:
        # The TriggerSelector enum varies by camera model (FrameStart,
        # AcquisitionStart, …). Try each SFNC-standard name and set
        # TriggerMode=Off for the ones the camera accepts. Safe no-op on
        # cameras without Trigger features.
        if self._cam is None:
            return
        device = self._cam.get_device()
        any_set = False
        for sel in ("FrameStart", "AcquisitionStart", "FrameBurstStart"):
            try:
                device.set_string_feature_value("TriggerSelector", sel)
                device.set_string_feature_value("TriggerMode", "Off")
                any_set = True
            except Exception:
                continue
        if not any_set:
            try:
                device.set_string_feature_value("TriggerMode", "Off")
            except Exception:
                pass

    def _teardown_partial(self) -> None:
        # Drop our own GObject references so the C-level Camera/Stream get
        # finalized before we retry. Without this, the previous attempt's
        # control session would still be live when we call Aravis.Camera.new
        # again, and we'd race against ourselves.
        if self._stream is not None:
            try:
                while self._stream.try_pop_buffer() is not None:
                    pass
            except Exception:
                pass
            del self._stream
            self._stream = None
        if self._cam is not None:
            try:
                self._cam.stop_acquisition()
            except Exception:
                pass
            del self._cam
            self._cam = None
        import gc
        gc.collect()

    def _configure_gige_socket_buffer(self) -> None:
        # Default macOS UDP receive buffer is ~786 KB (net.inet.udp.recvspace).
        # At ~85 MB/s GVSP that overflows in ~9 ms, dropping packets and
        # triggering resend storms. AUTO mode in aravis may compute a value
        # past macOS's kern.ipc.maxsockbuf (8 MB by default), which the kernel
        # silently rejects — falling back to the tiny default. Use a fixed
        # 4 MB instead: large enough to absorb scheduling jitter, well below
        # the 8 MB ceiling. GigE only.
        if self._stream is None:
            return
        try:
            if not self._cam.is_gv_device():
                return
        except Exception:
            return
        SIZE = 4 * 1024 * 1024
        try:
            self._stream.set_property("socket-buffer", Aravis.GvStreamSocketBuffer.FIXED)
            self._stream.set_property("socket-buffer-size", SIZE)
            return
        except Exception:
            pass
        try:
            self._stream.set_option_socket_buffer(
                Aravis.GvStreamSocketBuffer.FIXED, SIZE
            )
        except Exception:
            pass  # default OS buffer; expect packet loss under load

    def _configure_gige_packet_size(self) -> None:
        # GigE Vision cameras default GevSCPSPacketSize to a value the firmware
        # picks (often >1500), which silently breaks streaming on hosts with a
        # 1500-byte MTU — packets never reach the kernel. Negotiate a working
        # size before creating the stream. USB3 Vision has no equivalent; this
        # is a no-op for non-GigE cameras.
        import logging
        log = logging.getLogger(__name__)
        try:
            if not self._cam.is_gv_device():
                return
        except Exception:
            return
        try:
            self._cam.gv_set_packet_size_adjustment(
                Aravis.GvPacketSizeAdjustment.ON_FAILURE
            )
        except Exception:
            pass  # older bindings: aravis falls back to the size we set below
        # gv_auto_packet_size() probes via GevSCPSFireTestPacket when supported.
        # When that feature is absent (Allied Vision Manta firmware doesn't
        # expose it) the call returns the camera's existing size unchanged —
        # which on Manta defaults to ~8000 and never reaches a 1500-MTU host.
        # Always explicitly set a known-safe size afterward so the camera does
        # not silently keep its broken default.
        try:
            self._cam.gv_auto_packet_size()
        except Exception as e:
            log.debug("gv_auto_packet_size() failed: %s", e)
        try:
            self._cam.gv_set_packet_size(1400)
        except Exception as e:
            log.warning("Could not set packet size to 1400: %s", e)
        try:
            actual = int(self._cam.gv_get_packet_size())
            log.info("GigE packet size for %s: %d", self._device_id, actual)
        except Exception:
            pass

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

    def get_frame(self) -> np.ndarray | None:
        # Returns None on transient acquisition failures (timeout, partial frame,
        # missing packets). The CameraReader treats None as "keep last frame"
        # rather than logging — transient drops are normal on GigE Vision under
        # load and the get_stats() endpoint exposes the running counters.
        buf = self._stream.timeout_pop_buffer(2_000_000)  # 2 s timeout in µs
        if buf is None:
            self._transient_failures += 1
            self._last_error = "timeout waiting for frame"
            return None
        status = buf.get_status()
        if status != Aravis.BufferStatus.SUCCESS:
            self._transient_failures += 1
            self._last_error = f"buffer status {int(status)}"
            self._stream.push_buffer(buf)
            return None

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

        # Bayer-pattern 8-bit. Note: GenICam and OpenCV name the Bayer mosaic
        # from opposite corners — GenICam labels by the top-left pixel, OpenCV
        # by the second-row-second-column pixel. So GenICam "BayerRG" (red at
        # [0,0]) is OpenCV's "BayerBG" conversion code, etc. Mixing the names
        # up swaps the red and blue channels.
        bayer_code = None
        if pixel_format == Aravis.PIXEL_FORMAT_BAYER_RG_8:
            bayer_code = "BG"
        elif pixel_format == Aravis.PIXEL_FORMAT_BAYER_GR_8:
            bayer_code = "GB"
        elif pixel_format == Aravis.PIXEL_FORMAT_BAYER_GB_8:
            bayer_code = "GR"
        elif pixel_format == Aravis.PIXEL_FORMAT_BAYER_BG_8:
            bayer_code = "RG"
        if bayer_code is not None:
            import cv2
            cv_codes = {
                "BG": cv2.COLOR_BayerBG2BGR,
                "GB": cv2.COLOR_BayerGB2BGR,
                "GR": cv2.COLOR_BayerGR2BGR,
                "RG": cv2.COLOR_BayerRG2BGR,
            }
            data = raw[:height * width]
            return cv2.cvtColor(data.reshape((height, width)), cv_codes[bayer_code])

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
        # Allied Vision and other GigE Vision firmware sometimes return
        # access-denied transiently — typically when the write coincides with a
        # frame integration boundary. Retry once after a short delay before
        # surfacing the error.
        try:
            self._cam.set_exposure_time(microseconds)
            return
        except Exception:
            pass
        time.sleep(0.05)
        self._cam.set_exposure_time(microseconds)

    def get_stats(self) -> dict[str, object]:
        if self._cam is None or self._stream is None:
            return {"open": False}
        out: dict[str, object] = {
            "open": True,
            "transient_failures": int(self._transient_failures),
            "last_error": self._last_error,
        }
        # Enumerate stream info entries by index. Aravis exposes 3 universal
        # counters (n_completed_buffers, n_failures, n_underruns) followed by
        # GigE-specific ones on a GvStream. Using indexed access avoids the
        # naming-quirks of get_statistics() (which in 0.8.35 only returns the
        # GV-specific resent/missing packet pair) and the glib-CRITICAL fallout
        # of by-name lookups against USB3 streams.
        try:
            n = int(self._stream.get_n_infos())
        except Exception:
            n = 0
        for i in range(n):
            try:
                name = self._stream.get_info_name(i)
                value = int(self._stream.get_info_uint64(i))
            except Exception:
                continue
            out[name] = value
        try:
            if self._cam.is_gv_device():
                out["packet_size"] = int(self._cam.gv_get_packet_size())
        except Exception:
            pass
        return out

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
        # DeviceSerialNumber is the GenICam-standard name but Allied Vision
        # (and other GigE Vision firmware) only exposes serial via DeviceID.
        serial = None
        for feature in ("DeviceSerialNumber", "DeviceID"):
            try:
                serial = device.get_string_feature_value(feature)
                if serial:
                    break
            except Exception:
                continue
        if not serial:
            serial = self._device_id or ""
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


def list_aravis_cameras(refresh_attempts: int = 1, refresh_delay_s: float = 0.25) -> list[dict]:
    """
    Return list of available Aravis cameras as
    [{"id": str, "vendor": str, "label": str}, ...].
    Returns [] if Aravis is not available.
    'label' is a human-readable display string for the UI dropdown.
    """
    if not ARAVIS_AVAILABLE:
        return []
    # Aravis Viewer's refresh button is effectively an explicit device-list
    # update. Do the same here, with optional repeated refreshes because GigE
    # discovery can miss a device during link/control handoff.
    attempts = max(1, int(refresh_attempts))
    for i in range(attempts):
        Aravis.update_device_list()
        if i + 1 < attempts:
            time.sleep(refresh_delay_s)
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
