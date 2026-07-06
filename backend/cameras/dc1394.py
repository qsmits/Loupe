"""
Dc1394Camera — libdc1394 (ctypes) backend for legacy Point Grey USB3 cameras.

Tested against: Grasshopper3 GS3-U3-41C6M (monochrome)
Requires: custom-patched libdc1394 at DC1394_LIB_PATH (see env var below).
Requires: server running as root (sudo) — macOS IOKit blocks userspace
          USB interface claims for vendor-specific class devices.

Continuous streaming is implemented via multi-shot (255 frames) re-armed
from a background thread, because the standard iso_enable register does
not engage continuous streaming on this firmware. The re-arm cadence
adapts to the measured frame rate (see compute_rearm_interval) so the
255-frame batch never runs dry at high fps / reduced ROI.
"""

import atexit
import collections
import ctypes
import ctypes.util
import logging
import math
import os
import threading
import time

import cv2
import numpy as np

from .base import BaseCamera

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Library path — override with env var for portability
# ---------------------------------------------------------------------------
_DEFAULT_LIB_PATH = "/Users/qsmits/.local/libdc1394-usb/lib/libdc1394.dylib"
_LIB_PATH = os.environ.get("DC1394_LIB_PATH", _DEFAULT_LIB_PATH)

# ---------------------------------------------------------------------------
# IIDC enum constants (from headers; confirmed against types.h / video.h /
# control.h / capture.h / format7.h)
# ---------------------------------------------------------------------------
DC1394_OFF = 0
DC1394_ON  = 1
DC1394_TRUE = 1
DC1394_FALSE = 0

# dc1394speed_t: DC1394_ISO_SPEED_100=0 … _3200=5
DC1394_ISO_SPEED_100  = 0
DC1394_ISO_SPEED_200  = 1
DC1394_ISO_SPEED_400  = 2
DC1394_ISO_SPEED_800  = 3
DC1394_ISO_SPEED_1600 = 4
DC1394_ISO_SPEED_3200 = 5

# dc1394video_mode_t: FORMAT7_0 = 88 (64 + 24; the enum starts at 64 and
# FORMAT7_0 is the 25th entry: 64+24=88)
DC1394_VIDEO_MODE_FORMAT7_0 = 88

# dc1394color_coding_t: MONO8 = 352
DC1394_COLOR_CODING_MONO8 = 352

# dc1394_format7_set_roi special packet_size values (from format7.h)
DC1394_USE_MAX_AVAIL   = -2
DC1394_QUERY_FROM_CAMERA = -1

# capture flags (capture.h)
DC1394_CAPTURE_FLAGS_DEFAULT = 0x00000004  # bandwidth + channel alloc

# capture policy (capture.h)
DC1394_CAPTURE_POLICY_WAIT = 672
DC1394_CAPTURE_POLICY_POLL = 673

# dc1394feature_t (control.h, starts at 416)
DC1394_FEATURE_BRIGHTNESS   = 416
DC1394_FEATURE_EXPOSURE     = 417
DC1394_FEATURE_SHARPNESS    = 418
DC1394_FEATURE_WHITE_BALANCE = 419
DC1394_FEATURE_HUE          = 420
DC1394_FEATURE_SATURATION   = 421
DC1394_FEATURE_GAMMA        = 422
DC1394_FEATURE_SHUTTER      = 423
DC1394_FEATURE_GAIN         = 424

# dc1394feature_mode_t (control.h, starts at 736)
DC1394_FEATURE_MODE_MANUAL       = 736
DC1394_FEATURE_MODE_AUTO         = 737
DC1394_FEATURE_MODE_ONE_PUSH_AUTO = 738

# dc1394error_t success value
DC1394_SUCCESS = 0

# ---------------------------------------------------------------------------
# Streaming tunables
# ---------------------------------------------------------------------------

# Frames per multi-shot batch (the "continuous streaming" trick).
MULTI_SHOT_FRAMES = 255
# Historical fixed re-arm cadence; used as fallback and ceiling.
REARM_FALLBACK_INTERVAL_S = 5.0
# Floor so extreme frame rates don't hammer the control endpoint.
REARM_MIN_INTERVAL_S = 0.25
# get_frame() bounded-wait dequeue: total timeout matches the ~2 s contract
# the rest of the code assumes (Aravis pop timeout, CameraReader join
# headroom); the poll interval keeps latency negligible at any frame rate.
_DEQUEUE_TIMEOUT_S = 2.0
_DEQUEUE_POLL_INTERVAL_S = 0.005


def compute_rearm_interval(fps_estimate: float | None) -> float:
    """Pure function: seconds to wait between multi-shot re-arms.

    The camera is armed in MULTI_SHOT_FRAMES-frame batches, so a batch lasts
    MULTI_SHOT_FRAMES / fps seconds (4.25 s at 60 fps, ~2.55 s at 100 fps
    with a reduced ROI). Re-arm when roughly half the batch could have been
    consumed so acquisition never runs dry, clamped to:

      floor REARM_MIN_INTERVAL_S (0.25 s) — don't hammer the control endpoint
      ceil  REARM_FALLBACK_INTERVAL_S (5.0 s) — the historical cadence, which
            is already conservative at <= ~25 fps

    Unknown / invalid fps (None, <= 0, NaN, inf) falls back to the historical
    5.0 s cadence. Re-arming early is always safe: the firmware silently
    accepts re-arms before the previous batch is exhausted.
    """
    if fps_estimate is None:
        return REARM_FALLBACK_INTERVAL_S
    try:
        fps = float(fps_estimate)
    except (TypeError, ValueError):
        return REARM_FALLBACK_INTERVAL_S
    if not math.isfinite(fps) or fps <= 0.0:
        return REARM_FALLBACK_INTERVAL_S
    interval = 0.5 * MULTI_SHOT_FRAMES / max(fps, 1.0)
    return min(REARM_FALLBACK_INTERVAL_S, max(REARM_MIN_INTERVAL_S, interval))

# ---------------------------------------------------------------------------
# ctypes structures mirroring dc1394video_frame_t from video.h
# ---------------------------------------------------------------------------

class _Dc1394VideoFrame(ctypes.Structure):
    """
    Mirrors dc1394video_frame_t from video.h.
    Fields are in declaration order. Offsets must match the compiled struct —
    keep the order identical to the C definition.
    """
    _fields_ = [
        ("image",               ctypes.c_void_p),      # unsigned char *
        ("size",                ctypes.c_uint32 * 2),  # [width, height]
        ("position",            ctypes.c_uint32 * 2),  # [x, y]
        ("color_coding",        ctypes.c_uint32),      # dc1394color_coding_t
        ("color_filter",        ctypes.c_uint32),      # dc1394color_filter_t
        ("yuv_byte_order",      ctypes.c_uint32),
        ("data_depth",          ctypes.c_uint32),
        ("stride",              ctypes.c_uint32),
        ("video_mode",          ctypes.c_uint32),      # dc1394video_mode_t
        ("total_bytes",         ctypes.c_uint64),
        ("image_bytes",         ctypes.c_uint32),
        ("padding_bytes",       ctypes.c_uint32),
        ("packet_size",         ctypes.c_uint32),
        ("packets_per_frame",   ctypes.c_uint32),
        ("timestamp",           ctypes.c_uint64),
        ("frames_behind",       ctypes.c_uint32),
        ("camera",              ctypes.c_void_p),      # dc1394camera_t *
        ("id",                  ctypes.c_uint32),
        ("allocated_image_bytes", ctypes.c_uint64),
        ("little_endian",       ctypes.c_uint32),      # dc1394bool_t
        ("data_in_padding",     ctypes.c_uint32),      # dc1394bool_t
    ]

# ---------------------------------------------------------------------------
# Module-level singleton: library + dc1394 context
# ---------------------------------------------------------------------------

_lib_lock = threading.Lock()
_lib: ctypes.CDLL | None = None   # the ctypes handle to libdc1394
_ctx: ctypes.c_void_p | None = None  # dc1394_t* from dc1394_new()
_lib_load_attempted = False


def _load_library() -> ctypes.CDLL | None:
    """
    Load libdc1394.dylib from _LIB_PATH.
    Returns None if the file is absent or cannot be loaded.
    """
    global _lib, _lib_load_attempted
    if _lib_load_attempted:
        return _lib
    _lib_load_attempted = True
    if not os.path.exists(_LIB_PATH):
        log.debug("libdc1394 not found at %s — dc1394 backend disabled", _LIB_PATH)
        return None
    try:
        lib = ctypes.CDLL(_LIB_PATH)
        # Verify at least one known symbol is present
        _ = lib.dc1394_new
        _lib = lib
        _setup_argtypes(lib)
        log.info("Loaded libdc1394 from %s", _LIB_PATH)
        return lib
    except (OSError, AttributeError) as e:
        log.warning("Failed to load libdc1394 from %s: %s", _LIB_PATH, e)
        return None


def _setup_argtypes(lib: ctypes.CDLL) -> None:
    """Configure ctypes argtypes/restypes for all functions we call."""
    # dc1394_new() -> dc1394_t*
    lib.dc1394_new.restype = ctypes.c_void_p
    lib.dc1394_new.argtypes = []

    # dc1394_free(dc1394_t*)
    lib.dc1394_free.restype = None
    lib.dc1394_free.argtypes = [ctypes.c_void_p]

    # dc1394_camera_enumerate(dc1394_t*, dc1394camera_list_t**) -> dc1394error_t
    lib.dc1394_camera_enumerate.restype = ctypes.c_int
    lib.dc1394_camera_enumerate.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

    # dc1394_camera_free_list(dc1394camera_list_t*)
    lib.dc1394_camera_free_list.restype = None
    lib.dc1394_camera_free_list.argtypes = [ctypes.c_void_p]

    # dc1394_camera_new(dc1394_t*, uint64_t guid) -> dc1394camera_t*
    lib.dc1394_camera_new.restype = ctypes.c_void_p
    lib.dc1394_camera_new.argtypes = [ctypes.c_void_p, ctypes.c_uint64]

    # dc1394_camera_free(dc1394camera_t*)
    lib.dc1394_camera_free.restype = None
    lib.dc1394_camera_free.argtypes = [ctypes.c_void_p]

    # dc1394_camera_reset(dc1394camera_t*) -> dc1394error_t
    lib.dc1394_camera_reset.restype = ctypes.c_int
    lib.dc1394_camera_reset.argtypes = [ctypes.c_void_p]

    # dc1394_external_trigger_set_power(camera, dc1394switch_t) -> dc1394error_t
    lib.dc1394_external_trigger_set_power.restype = ctypes.c_int
    lib.dc1394_external_trigger_set_power.argtypes = [ctypes.c_void_p, ctypes.c_int]

    # dc1394_software_trigger_set_power(camera, dc1394switch_t) -> dc1394error_t
    lib.dc1394_software_trigger_set_power.restype = ctypes.c_int
    lib.dc1394_software_trigger_set_power.argtypes = [ctypes.c_void_p, ctypes.c_int]

    # dc1394_video_set_iso_speed(camera, dc1394speed_t) -> dc1394error_t
    lib.dc1394_video_set_iso_speed.restype = ctypes.c_int
    lib.dc1394_video_set_iso_speed.argtypes = [ctypes.c_void_p, ctypes.c_int]

    # dc1394_video_set_mode(camera, dc1394video_mode_t) -> dc1394error_t
    lib.dc1394_video_set_mode.restype = ctypes.c_int
    lib.dc1394_video_set_mode.argtypes = [ctypes.c_void_p, ctypes.c_int]

    # dc1394_format7_set_roi(camera, mode, coding, packet_size, left, top, w, h) -> dc1394error_t
    lib.dc1394_format7_set_roi.restype = ctypes.c_int
    lib.dc1394_format7_set_roi.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ctypes.c_int32, ctypes.c_int32, ctypes.c_int32,
        ctypes.c_int32, ctypes.c_int32,
    ]

    # dc1394_format7_get_max_image_size(camera, mode, *h_size, *v_size) -> dc1394error_t
    lib.dc1394_format7_get_max_image_size.restype = ctypes.c_int
    lib.dc1394_format7_get_max_image_size.argtypes = [
        ctypes.c_void_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32),
    ]

    # dc1394_format7_get_image_size(camera, mode, *width, *height) -> dc1394error_t
    lib.dc1394_format7_get_image_size.restype = ctypes.c_int
    lib.dc1394_format7_get_image_size.argtypes = [
        ctypes.c_void_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32),
    ]

    # dc1394_format7_get_unit_size(camera, mode, *h_unit, *v_unit) -> dc1394error_t
    lib.dc1394_format7_get_unit_size.restype = ctypes.c_int
    lib.dc1394_format7_get_unit_size.argtypes = [
        ctypes.c_void_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32),
    ]

    # dc1394_capture_setup(camera, num_buffers, flags) -> dc1394error_t
    lib.dc1394_capture_setup.restype = ctypes.c_int
    lib.dc1394_capture_setup.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
    ]

    # dc1394_capture_stop(camera) -> dc1394error_t
    lib.dc1394_capture_stop.restype = ctypes.c_int
    lib.dc1394_capture_stop.argtypes = [ctypes.c_void_p]

    # dc1394_capture_dequeue(camera, policy, **frame) -> dc1394error_t
    lib.dc1394_capture_dequeue.restype = ctypes.c_int
    lib.dc1394_capture_dequeue.argtypes = [
        ctypes.c_void_p, ctypes.c_int,
        ctypes.POINTER(ctypes.POINTER(_Dc1394VideoFrame)),
    ]

    # dc1394_capture_enqueue(camera, *frame) -> dc1394error_t
    lib.dc1394_capture_enqueue.restype = ctypes.c_int
    lib.dc1394_capture_enqueue.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(_Dc1394VideoFrame),
    ]

    # dc1394_video_set_multi_shot(camera, numFrames, pwr) -> dc1394error_t
    lib.dc1394_video_set_multi_shot.restype = ctypes.c_int
    lib.dc1394_video_set_multi_shot.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
    ]

    # dc1394_video_set_transmission(camera, pwr) -> dc1394error_t
    lib.dc1394_video_set_transmission.restype = ctypes.c_int
    lib.dc1394_video_set_transmission.argtypes = [ctypes.c_void_p, ctypes.c_int]

    # --- Feature / absolute control ---

    # dc1394_feature_set_absolute_control(camera, feature, pwr) -> dc1394error_t
    lib.dc1394_feature_set_absolute_control.restype = ctypes.c_int
    lib.dc1394_feature_set_absolute_control.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ]

    # dc1394_feature_get_absolute_value(camera, feature, *value) -> dc1394error_t
    lib.dc1394_feature_get_absolute_value.restype = ctypes.c_int
    lib.dc1394_feature_get_absolute_value.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_float),
    ]

    # dc1394_feature_set_absolute_value(camera, feature, value) -> dc1394error_t
    lib.dc1394_feature_set_absolute_value.restype = ctypes.c_int
    lib.dc1394_feature_set_absolute_value.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_float,
    ]

    # dc1394_feature_get_absolute_boundaries(camera, feature, *min, *max)
    lib.dc1394_feature_get_absolute_boundaries.restype = ctypes.c_int
    lib.dc1394_feature_get_absolute_boundaries.argtypes = [
        ctypes.c_void_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float),
    ]

    # dc1394_feature_set_mode(camera, feature, mode) -> dc1394error_t
    lib.dc1394_feature_set_mode.restype = ctypes.c_int
    lib.dc1394_feature_set_mode.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ]

    # dc1394_feature_get_mode(camera, feature, *mode) -> dc1394error_t
    lib.dc1394_feature_get_mode.restype = ctypes.c_int
    lib.dc1394_feature_get_mode.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int),
    ]


def _get_context() -> ctypes.c_void_p | None:
    """
    Lazy-init the module-level dc1394_t* context.
    Returns None if the library is not available.
    Thread-safe.
    """
    global _ctx
    with _lib_lock:
        lib = _load_library()
        if lib is None:
            return None
        if _ctx is None:
            ctx = lib.dc1394_new()
            if not ctx:
                log.error("dc1394_new() returned NULL — cannot create dc1394 context")
                return None
            _ctx = ctx
            log.debug("dc1394 context created: %s", hex(_ctx))
        return _ctx


def _free_context() -> None:
    """Called at Python shutdown via atexit."""
    global _ctx
    with _lib_lock:
        if _ctx is not None and _lib is not None:
            try:
                _lib.dc1394_free(_ctx)
            except Exception:
                pass
            _ctx = None


atexit.register(_free_context)

# ---------------------------------------------------------------------------
# Camera enumeration helper
# ---------------------------------------------------------------------------

class _CameraListStruct(ctypes.Structure):
    """
    Mirrors dc1394camera_list_t from camera.h.
    { uint32_t num; dc1394camera_id_t *ids; }
    dc1394camera_id_t = { uint16_t unit; uint64_t guid }
    """
    _fields_ = [
        ("num",  ctypes.c_uint32),
        ("ids",  ctypes.c_void_p),
    ]


class _CameraIdStruct(ctypes.Structure):
    """Mirrors dc1394camera_id_t: { uint16_t unit; uint64_t guid }"""
    # Struct packing: uint16 + 6 bytes pad + uint64 on typical 64-bit ABI
    _fields_ = [
        ("unit", ctypes.c_uint16),
        ("_pad", ctypes.c_uint8 * 6),
        ("guid", ctypes.c_uint64),
    ]


def list_dc1394_cameras() -> list[dict]:
    """
    Return a list of available dc1394/IIDC cameras:
    [{"id": "dc1394-<hex_guid>", "vendor": str, "label": str}, ...]

    Returns [] if the library is not installed or no cameras are found.
    """
    ctx = _get_context()
    if ctx is None:
        return []
    lib = _lib
    if lib is None:
        return []

    list_ptr = ctypes.c_void_p(0)
    err = lib.dc1394_camera_enumerate(ctx, ctypes.byref(list_ptr))
    if err != DC1394_SUCCESS or not list_ptr:
        log.debug("dc1394_camera_enumerate returned err=%d or null list", err)
        return []

    cameras = []
    try:
        cam_list = ctypes.cast(list_ptr, ctypes.POINTER(_CameraListStruct)).contents
        n = int(cam_list.num)
        if n == 0 or not cam_list.ids:
            return []

        # Cast the ids pointer to an array of _CameraIdStruct
        ids_arr = ctypes.cast(
            cam_list.ids,
            ctypes.POINTER(_CameraIdStruct * n),
        ).contents

        for i in range(n):
            entry = ids_arr[i]
            guid = int(entry.guid)
            guid_hex = f"{guid:016x}"
            cam_handle = lib.dc1394_camera_new(ctx, guid)
            vendor = "Point Grey"
            model  = f"dc1394 camera {guid_hex}"
            if cam_handle:
                # Read vendor/model strings from the camera struct.
                # dc1394camera_t has char* vendor and char* model as fields
                # at known offsets. Rather than re-declare the full struct,
                # we open a temp camera, grab the strings, then free it.
                try:
                    # Use a pointer overlay to read the struct field offsets.
                    # Struct layout (from camera.h), fields before vendor:
                    #   guid (u64), unit (int), unit_spec_ID (u32),
                    #   unit_sw_version (u32), unit_sub_sw_version (u32),
                    #   command_registers_base (u32), unit_directory (u32),
                    #   unit_dependent_directory (u32),
                    #   advanced_features_csr (u64), PIO_control_csr (u64),
                    #   SIO_control_csr (u64), strobe_control_csr (u64),
                    #   format7_csr[8] (u64 × 8),
                    #   iidc_version (int, enum)
                    # Then: char* vendor, char* model
                    # On 64-bit: 8+4+4+4+4+4+4+4 = 36 bytes, pad to 40,
                    # +8*3=24 for three u64s after int+3u32 gap... this is
                    # fragile. Use libdc1394's own camera_print_info or
                    # just enumerate with a temporary camera and trust the
                    # struct offsets baked in by ctypes._CameraStruct below.
                    cam_s = _TempCameraStruct.from_address(cam_handle)
                    v = cam_s.vendor
                    m = cam_s.model
                    if v:
                        vendor = v.decode("utf-8", errors="replace")
                    if m:
                        model = m.decode("utf-8", errors="replace")
                except Exception:
                    pass
                finally:
                    lib.dc1394_camera_free(cam_handle)

            cameras.append({
                "id": f"dc1394-{guid_hex}",
                "vendor": vendor,
                "label": f"{vendor} {model} — dc1394-{guid_hex}",
            })
    finally:
        lib.dc1394_camera_free_list(list_ptr)

    return cameras


class _TempCameraStruct(ctypes.Structure):
    """
    Mirrors dc1394camera_t from camera.h, enough to read vendor/model strings.
    Fields must be in exact declaration order; sizes verified against camera.h.

    dc1394video_mode_format7_num = DC1394_VIDEO_MODE_FORMAT7_MAX
                                 - DC1394_VIDEO_MODE_FORMAT7_MIN + 1
                                 = (64+31) - (64+24) + 1 = 8
    """
    _fields_ = [
        ("guid",                        ctypes.c_uint64),
        ("unit",                        ctypes.c_int),
        ("unit_spec_ID",                ctypes.c_uint32),
        ("unit_sw_version",             ctypes.c_uint32),
        ("unit_sub_sw_version",         ctypes.c_uint32),
        ("command_registers_base",      ctypes.c_uint32),
        ("unit_directory",              ctypes.c_uint32),
        ("unit_dependent_directory",    ctypes.c_uint32),
        ("advanced_features_csr",       ctypes.c_uint64),
        ("PIO_control_csr",             ctypes.c_uint64),
        ("SIO_control_csr",             ctypes.c_uint64),
        ("strobe_control_csr",          ctypes.c_uint64),
        ("format7_csr",                 ctypes.c_uint64 * 8),   # 8 entries
        ("iidc_version",                ctypes.c_int),
        ("vendor",                      ctypes.c_char_p),
        ("model",                       ctypes.c_char_p),
        # remaining fields not needed
    ]


# ---------------------------------------------------------------------------
# Dc1394Camera
# ---------------------------------------------------------------------------

class Dc1394Camera(BaseCamera):
    """
    BaseCamera implementation backed by libdc1394 (ctypes).

    Streaming uses the multi-shot-255 trick — see module docstring.
    All camera handle accesses are serialized with self._lock.
    """

    def __init__(self, guid: int | None = None):
        """
        guid: 64-bit camera GUID. None → open first available camera.
        open() must be called separately; __init__ is non-destructive.
        """
        self._guid = guid
        self._cam_handle: int | None = None   # dc1394camera_t* as int
        self._opened = False
        # Reentrant so high-level methods (get_info) can call other locked
        # methods (get_gamma, _get_abs_feature) without self-deadlocking.
        self._lock = threading.RLock()
        self._stop_rearm = threading.Event()
        # Set at the very top of close(): aborts any in-flight get_frame()
        # poll loop immediately so shutdown never waits on a stalled dequeue.
        self._closing = threading.Event()
        self._rearm_thread: threading.Thread | None = None
        # Timestamps of successful dequeues (guarded by self._lock) — used
        # to estimate fps for the adaptive multi-shot re-arm cadence.
        self._dequeue_times: collections.deque[float] = collections.deque(maxlen=64)
        self._width = 0
        self._height = 0
        self._sensor_width = 0
        self._sensor_height = 0
        self._roi_w_unit = 1
        self._roi_h_unit = 1

    # ------------------------------------------------------------------
    # Open / close
    # ------------------------------------------------------------------

    def open(self) -> None:
        """
        Open the camera, run the full IIDC setup sequence, and start streaming.
        Raises RuntimeError if the library is unavailable or camera not found.
        Raises PermissionError if capture_setup fails due to missing root.
        """
        lib = _load_library()
        if lib is None:
            raise ImportError(
                f"libdc1394 not found at {_LIB_PATH}. "
                "Set DC1394_LIB_PATH env var or install the library."
            )
        ctx = _get_context()
        if ctx is None:
            raise RuntimeError("Failed to create dc1394 context (dc1394_new returned NULL)")

        guid = self._guid
        if guid is None:
            guid = self._find_first_guid(lib, ctx)
            if guid is None:
                raise RuntimeError("No dc1394 cameras found")
            self._guid = guid

        log.info("Opening dc1394 camera guid=%016x", guid)
        cam = lib.dc1394_camera_new(ctx, ctypes.c_uint64(guid))
        if not cam:
            raise RuntimeError(f"dc1394_camera_new() failed for guid={guid:016x}")

        try:
            self._full_setup(lib, cam)

            # Everything below runs AFTER dc1394_capture_setup succeeded,
            # i.e. the USB interface is claimed and transmission is armed.
            # Any failure from here on must tear the capture down, or the
            # device is leaked half-open and locked until power-cycle.
            self._cam_handle = cam
            # Read current image size
            self._refresh_size(lib, cam)
            # Read sensor max size
            mw = ctypes.c_uint32(0)
            mh = ctypes.c_uint32(0)
            lib.dc1394_format7_get_max_image_size(
                cam, DC1394_VIDEO_MODE_FORMAT7_0,
                ctypes.byref(mw), ctypes.byref(mh),
            )
            self._sensor_width  = int(mw.value) or self._width
            self._sensor_height = int(mh.value) or self._height
            # ROI unit sizes
            uw = ctypes.c_uint32(0)
            uh = ctypes.c_uint32(0)
            lib.dc1394_format7_get_unit_size(
                cam, DC1394_VIDEO_MODE_FORMAT7_0,
                ctypes.byref(uw), ctypes.byref(uh),
            )
            self._roi_w_unit = max(1, int(uw.value))
            self._roi_h_unit = max(1, int(uh.value))

            with self._lock:
                self._dequeue_times.clear()
            self._closing.clear()
            self._opened = True
            self._stop_rearm.clear()
            self._rearm_thread = threading.Thread(
                target=self._rearm_loop, daemon=True, name="dc1394-rearm"
            )
            self._rearm_thread.start()
        except Exception:
            # Best-effort teardown mirroring close(). capture_stop /
            # set_transmission are harmless no-ops (error returns, not
            # exceptions) if capture_setup never succeeded.
            self._opened = False
            self._cam_handle = None
            self._rearm_thread = None
            for teardown, args in (
                (lib.dc1394_video_set_transmission, (cam, DC1394_OFF)),
                (lib.dc1394_capture_stop, (cam,)),
                (lib.dc1394_camera_free, (cam,)),
            ):
                try:
                    teardown(*args)
                except Exception:
                    pass
            raise

        log.info(
            "dc1394 camera opened: guid=%016x size=%dx%d",
            guid, self._width, self._height,
        )

    def _full_setup(self, lib: ctypes.CDLL, cam: int) -> None:
        """Run the verified IIDC setup sequence."""
        _check(lib.dc1394_camera_reset(cam), "camera_reset")
        time.sleep(0.5)
        # Disable triggers so the camera free-runs
        lib.dc1394_external_trigger_set_power(cam, DC1394_OFF)   # best-effort
        lib.dc1394_software_trigger_set_power(cam, DC1394_OFF)   # best-effort

        _check(lib.dc1394_video_set_iso_speed(cam, DC1394_ISO_SPEED_400), "set_iso_speed")
        _check(lib.dc1394_video_set_mode(cam, DC1394_VIDEO_MODE_FORMAT7_0), "set_mode")
        _check(
            lib.dc1394_format7_set_roi(
                cam, DC1394_VIDEO_MODE_FORMAT7_0,
                DC1394_COLOR_CODING_MONO8,
                DC1394_USE_MAX_AVAIL,   # packet_size: use maximum available
                0, 0,                   # left, top
                DC1394_USE_MAX_AVAIL,   # width: full sensor
                DC1394_USE_MAX_AVAIL,   # height: full sensor
            ),
            "format7_set_roi",
        )

        err = lib.dc1394_capture_setup(cam, 4, DC1394_CAPTURE_FLAGS_DEFAULT)
        if err != DC1394_SUCCESS:
            # Distinguish access errors from other failures
            msg = f"dc1394_capture_setup failed (err={err})"
            if err in (-22, -13, 22, 13) or _looks_like_access_error(err):
                msg = (
                    "Dc1394Camera requires root privileges "
                    "(run server with sudo — macOS IOKit blocks USB interface claim)"
                )
            raise PermissionError(msg) if _looks_like_access_error(err) else RuntimeError(msg)

        # Arm multi-shot: 255 frames. This is our "continuous" mode — see docstring.
        _check(
            lib.dc1394_video_set_multi_shot(cam, MULTI_SHOT_FRAMES, DC1394_ON),
            "set_multi_shot initial arm",
        )

    def _find_first_guid(self, lib: ctypes.CDLL, ctx: int) -> int | None:
        """Enumerate cameras and return the GUID of the first one found."""
        list_ptr = ctypes.c_void_p(0)
        err = lib.dc1394_camera_enumerate(ctx, ctypes.byref(list_ptr))
        if err != DC1394_SUCCESS or not list_ptr:
            return None
        try:
            cam_list = ctypes.cast(list_ptr, ctypes.POINTER(_CameraListStruct)).contents
            n = int(cam_list.num)
            if n == 0 or not cam_list.ids:
                return None
            ids_arr = ctypes.cast(
                cam_list.ids,
                ctypes.POINTER(_CameraIdStruct * n),
            ).contents
            return int(ids_arr[0].guid)
        finally:
            lib.dc1394_camera_free_list(list_ptr)

    def _refresh_size(self, lib: ctypes.CDLL, cam: int) -> None:
        w = ctypes.c_uint32(0)
        h = ctypes.c_uint32(0)
        err = lib.dc1394_format7_get_image_size(
            cam, DC1394_VIDEO_MODE_FORMAT7_0,
            ctypes.byref(w), ctypes.byref(h),
        )
        if err == DC1394_SUCCESS:
            self._width  = int(w.value)
            self._height = int(h.value)

    def close(self) -> None:
        """Stop streaming, kill the re-arm thread, and free the camera."""
        # FIRST: abort any in-flight get_frame() poll loop. It checks this
        # flag between POLL attempts, so it bails out within one poll
        # interval instead of waiting for its full dequeue timeout.
        self._closing.set()
        # Signal and wait for the re-arm thread (no lock needed for the event)
        self._stop_rearm.set()
        if self._rearm_thread is not None:
            self._rearm_thread.join(timeout=8.0)
            self._rearm_thread = None

        with self._lock:
            self._opened = False
            if self._cam_handle is None:
                return
            lib = _lib
            cam = self._cam_handle
            self._cam_handle = None

            if lib is None:
                return
            # Best-effort teardown — any of these may fail on a crashed camera
            try:
                lib.dc1394_video_set_transmission(cam, DC1394_OFF)
            except Exception:
                pass
            try:
                lib.dc1394_capture_stop(cam)
            except Exception:
                pass
            try:
                lib.dc1394_camera_free(cam)
            except Exception:
                pass
        log.info("dc1394 camera closed")

    # ------------------------------------------------------------------
    # Re-arm thread — keeps multi-shot continuous
    # ------------------------------------------------------------------

    def _rearm_loop(self) -> None:
        """
        Keep the multi-shot "continuous" trick alive by periodically
        re-arming a fresh 255-frame batch. The camera silently accepts
        re-arms before the previous batch is exhausted.

        The cadence adapts to the measured dequeue rate: a batch lasts
        255/fps seconds (4.25 s at 60 fps, ~2.55 s at ~100 fps with a
        reduced ROI), so the historical fixed 5 s wait let acquisition run
        dry between batches at high frame rates. See compute_rearm_interval.

        The loop ticks every REARM_MIN_INTERVAL_S and re-evaluates the due
        interval each tick, so a frame-rate jump (e.g. right after an ROI
        shrink) shortens the *current* period instead of only the next one.
        This also makes close() reap this thread within one tick.
        """
        last_arm = time.monotonic()
        while not self._stop_rearm.wait(timeout=REARM_MIN_INTERVAL_S):
            due = compute_rearm_interval(self._estimate_fps())
            if time.monotonic() - last_arm < due:
                continue
            with self._lock:
                if not self._opened or self._cam_handle is None or _lib is None:
                    break
                try:
                    _lib.dc1394_video_set_multi_shot(
                        self._cam_handle, MULTI_SHOT_FRAMES, DC1394_ON,
                    )
                except Exception as e:
                    log.warning("dc1394 re-arm failed: %s", e)
                last_arm = time.monotonic()

    def _estimate_fps(self) -> float | None:
        """Estimate the current dequeue rate from recent frame timestamps.

        Returns None when there is not enough fresh data (startup, stall) —
        compute_rearm_interval treats that as "unknown" and uses the safe
        5 s fallback cadence.
        """
        with self._lock:
            times = list(self._dequeue_times)
        if len(times) < 2:
            return None
        now = time.monotonic()
        recent = [t for t in times if now - t <= 3.0]
        if len(recent) < 2:
            return None
        span = recent[-1] - recent[0]
        if span <= 0.0:
            return None
        return (len(recent) - 1) / span

    # ------------------------------------------------------------------
    # Frame capture
    # ------------------------------------------------------------------

    def get_frame(self) -> np.ndarray | None:
        """
        Dequeue one frame, copy the image bytes, re-enqueue the transport buffer,
        then convert MONO8 → BGR.

        Uses POLICY_POLL in a bounded wait loop instead of POLICY_WAIT:
        POLICY_WAIT blocks indefinitely when frames stop (stall, unplug,
        exhausted multi-shot batch), which wedges the CameraReader thread and
        turns every teardown path into a native use-after-free. The loop is
        bounded by _DEQUEUE_TIMEOUT_S (matching the ~2 s contract the rest of
        the code assumes) and aborts immediately when close() starts.

        Returns None on timeout / while closing — CameraReader counts that as
        a transient dropped frame, same as AravisCamera pop timeouts.

        The copy MUST happen before enqueue — the image pointer is invalidated
        as soon as the buffer is returned to the ring.
        """
        if not self._opened or self._cam_handle is None or _lib is None:
            raise RuntimeError("Camera not open")

        deadline = time.monotonic() + _DEQUEUE_TIMEOUT_S
        raw_bytes: bytes | None = None
        width = height = 0
        while True:
            if self._closing.is_set():
                return None
            frame_pp = ctypes.POINTER(_Dc1394VideoFrame)()
            # Each POLL attempt holds the lock (it never blocks), so close()
            # can never free the handle under a dequeue/copy/enqueue. Re-arms
            # interleave between poll iterations.
            with self._lock:
                if (
                    self._closing.is_set()
                    or not self._opened
                    or self._cam_handle is None
                    or _lib is None
                ):
                    return None
                err = _lib.dc1394_capture_dequeue(
                    self._cam_handle,
                    DC1394_CAPTURE_POLICY_POLL,
                    ctypes.byref(frame_pp),
                )
                if err == DC1394_SUCCESS and frame_pp:
                    f = frame_pp.contents
                    width       = int(f.size[0])
                    height      = int(f.size[1])
                    image_bytes = int(f.image_bytes)
                    try:
                        if f.image and image_bytes > 0:
                            # CRITICAL: copy BEFORE enqueue — the pointer is
                            # invalidated when the buffer returns to the ring.
                            raw_bytes = ctypes.string_at(f.image, image_bytes)
                    finally:
                        _lib.dc1394_capture_enqueue(self._cam_handle, frame_pp)
                    if raw_bytes is None:
                        raise RuntimeError("dc1394 frame has null image or zero bytes")
                    self._dequeue_times.append(time.monotonic())
                    break
            if err != DC1394_SUCCESS:
                raise RuntimeError(f"dc1394_capture_dequeue failed: err={err}")
            if time.monotonic() >= deadline:
                # Acquisition stalled (batch exhausted, cable pulled, …).
                return None
            time.sleep(_DEQUEUE_POLL_INTERVAL_S)

        # Convert MONO8 to numpy then to BGR (outside the lock)
        raw = np.frombuffer(raw_bytes, dtype=np.uint8).copy()
        expected = width * height
        if len(raw) < expected:
            raise RuntimeError(
                f"dc1394 frame underflow: got {len(raw)} bytes, expected {expected}"
            )
        mono = raw[:expected].reshape((height, width))
        return cv2.cvtColor(mono, cv2.COLOR_GRAY2BGR)

    # ------------------------------------------------------------------
    # Exposure
    # ------------------------------------------------------------------

    def set_exposure(self, microseconds: float) -> None:
        """
        Set exposure via IIDC absolute SHUTTER feature (units: seconds).
        Enables absolute control mode first.
        """
        self._require_open()
        seconds = microseconds / 1_000_000.0
        with self._lock:
            self._set_abs_feature(DC1394_FEATURE_SHUTTER, seconds)

    # ------------------------------------------------------------------
    # Gain
    # ------------------------------------------------------------------

    def set_gain(self, db: float) -> None:
        """
        Set gain via IIDC absolute GAIN feature.
        Note: IIDC GAIN absolute units are camera-vendor-specific. For Point Grey
        cameras, absolute GAIN is typically in dB.
        """
        self._require_open()
        with self._lock:
            self._set_abs_feature(DC1394_FEATURE_GAIN, float(db))

    # ------------------------------------------------------------------
    # Gamma
    # ------------------------------------------------------------------

    def set_gamma(self, value: float) -> None:
        self._require_open()
        with self._lock:
            self._set_abs_feature(DC1394_FEATURE_GAMMA, float(value))

    def get_gamma(self) -> float:
        if not self._opened or self._cam_handle is None or _lib is None:
            return 1.0
        with self._lock:
            try:
                return self._get_abs_feature(DC1394_FEATURE_GAMMA)
            except Exception:
                return 1.0

    # ------------------------------------------------------------------
    # Auto-exposure (one-push)
    # ------------------------------------------------------------------

    def set_auto_exposure(self) -> float:
        """
        Trigger IIDC one-push auto-exposure on SHUTTER feature.
        Polls until the mode returns to MANUAL, then reads back the new value.
        Returns the new exposure in microseconds.
        """
        self._require_open()
        with self._lock:
            if self._cam_handle is None or _lib is None:
                return 0.0
            cam = self._cam_handle
            err = _lib.dc1394_feature_set_mode(
                cam, DC1394_FEATURE_SHUTTER, DC1394_FEATURE_MODE_ONE_PUSH_AUTO,
            )
            if err != DC1394_SUCCESS:
                log.warning("set_auto_exposure: set_mode ONE_PUSH_AUTO failed err=%d", err)
                return 0.0

        # Poll outside the lock (auto-exposure can take several frames)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            time.sleep(0.1)
            with self._lock:
                if self._cam_handle is None or _lib is None:
                    return 0.0
                mode_out = ctypes.c_int(DC1394_FEATURE_MODE_ONE_PUSH_AUTO)
                _lib.dc1394_feature_get_mode(
                    self._cam_handle, DC1394_FEATURE_SHUTTER, ctypes.byref(mode_out),
                )
                if mode_out.value == DC1394_FEATURE_MODE_MANUAL:
                    break
        else:
            log.warning("set_auto_exposure: ONE_PUSH_AUTO did not converge within 5 s")

        # Read back the new exposure value (in seconds → µs)
        with self._lock:
            try:
                seconds = self._get_abs_feature(DC1394_FEATURE_SHUTTER)
                return seconds * 1_000_000.0
            except Exception as e:
                log.warning("set_auto_exposure: could not read back shutter: %s", e)
                return 0.0

    # ------------------------------------------------------------------
    # ROI
    # ------------------------------------------------------------------

    def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
        """
        Stop transmission, set FORMAT7_0 ROI, restart multi-shot.
        Note: changes packet buffer size — capture_stop + capture_setup
        must be called to resize ring buffers.
        """
        self._require_open()
        with self._lock:
            if self._cam_handle is None or _lib is None:
                return
            cam = self._cam_handle
            lib = _lib
            try:
                lib.dc1394_video_set_transmission(cam, DC1394_OFF)
            except Exception:
                pass
            try:
                lib.dc1394_capture_stop(cam)
            except Exception:
                pass

            _check(
                lib.dc1394_format7_set_roi(
                    cam, DC1394_VIDEO_MODE_FORMAT7_0,
                    DC1394_COLOR_CODING_MONO8,
                    DC1394_USE_MAX_AVAIL,
                    offset_x, offset_y,
                    width, height,
                ),
                "format7_set_roi (ROI)",
            )
            _check(
                lib.dc1394_capture_setup(cam, 4, DC1394_CAPTURE_FLAGS_DEFAULT),
                "capture_setup (after ROI)",
            )
            _check(
                lib.dc1394_video_set_multi_shot(cam, MULTI_SHOT_FRAMES, DC1394_ON),
                "set_multi_shot (after ROI)",
            )
            self._refresh_size(lib, cam)

        log.info("dc1394 ROI set to %dx%d+%d+%d", width, height, offset_x, offset_y)

    def reset_roi(self) -> None:
        """Reset ROI to full sensor dimensions."""
        self._require_open()
        with self._lock:
            if self._cam_handle is None or _lib is None:
                return
            cam = self._cam_handle
            lib = _lib
            mw = ctypes.c_uint32(0)
            mh = ctypes.c_uint32(0)
            lib.dc1394_format7_get_max_image_size(
                cam, DC1394_VIDEO_MODE_FORMAT7_0,
                ctypes.byref(mw), ctypes.byref(mh),
            )
            sw = int(mw.value) or self._sensor_width
            sh = int(mh.value) or self._sensor_height

        self.set_roi(0, 0, sw, sh)

    # ------------------------------------------------------------------
    # White balance (mono camera — no-ops)
    # ------------------------------------------------------------------

    def get_white_balance(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_auto(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        pass  # mono camera — WB not applicable

    # ------------------------------------------------------------------
    # Pixel format (hard-pinned to MONO8)
    # ------------------------------------------------------------------

    def set_pixel_format(self, fmt: str) -> None:
        pass  # MONO8 is fixed; would need to call format7_set_color_coding to change

    # ------------------------------------------------------------------
    # Camera info
    # ------------------------------------------------------------------

    def get_info(self) -> dict[str, object]:
        self._require_open()
        with self._lock:
            if self._cam_handle is None or _lib is None:
                raise RuntimeError("Camera not open")
            cam = self._cam_handle
            lib = _lib
            w = self._width
            h = self._height
            guid_hex = f"{self._guid:016x}" if self._guid is not None else "unknown"

            # Read model/vendor from dc1394camera_t struct
            try:
                cam_s = _TempCameraStruct.from_address(cam)
                vendor_b = cam_s.vendor
                model_b  = cam_s.model
                vendor = vendor_b.decode("utf-8", errors="replace") if vendor_b else "Point Grey"
                model  = model_b.decode("utf-8", errors="replace")  if model_b  else f"dc1394-{guid_hex}"
            except Exception:
                vendor = "Point Grey"
                model  = f"dc1394-{guid_hex}"

            # Exposure bounds and current value (absolute, in seconds → µs)
            exposure = 0.0
            exposure_min = 10.0
            exposure_max = 1_000_000.0
            try:
                exposure = self._get_abs_feature(DC1394_FEATURE_SHUTTER) * 1_000_000.0
                fmin = ctypes.c_float(0.0)
                fmax = ctypes.c_float(0.0)
                lib.dc1394_feature_get_absolute_boundaries(
                    cam, DC1394_FEATURE_SHUTTER,
                    ctypes.byref(fmin), ctypes.byref(fmax),
                )
                exposure_min = float(fmin.value) * 1_000_000.0
                exposure_max = float(fmax.value) * 1_000_000.0
            except Exception:
                pass

            # Gain bounds and current value
            gain = 0.0
            gain_min = 0.0
            gain_max = 24.0
            try:
                gain = self._get_abs_feature(DC1394_FEATURE_GAIN)
                fmin = ctypes.c_float(0.0)
                fmax = ctypes.c_float(0.0)
                lib.dc1394_feature_get_absolute_boundaries(
                    cam, DC1394_FEATURE_GAIN,
                    ctypes.byref(fmin), ctypes.byref(fmax),
                )
                gain_min = float(fmin.value)
                gain_max = float(fmax.value)
            except Exception:
                pass

            gamma = self.get_gamma()
            gamma_min = 0.5
            gamma_max = 4.0
            try:
                fmin = ctypes.c_float(0.0)
                fmax = ctypes.c_float(0.0)
                lib.dc1394_feature_get_absolute_boundaries(
                    cam, DC1394_FEATURE_GAMMA,
                    ctypes.byref(fmin), ctypes.byref(fmax),
                )
                gamma_min = float(fmin.value)
                gamma_max = float(fmax.value)
            except Exception:
                pass

        return {
            "model":            model,
            "serial":           guid_hex,
            "width":            w,
            "height":           h,
            "exposure":         exposure,
            "exposure_min":     exposure_min,
            "exposure_max":     exposure_max,
            "gain":             gain,
            "gain_min":         gain_min,
            "gain_max":         gain_max,
            "pixel_format":     "Mono8",
            "device_id":        f"dc1394-{guid_hex}",
            "wb_red":           1.0,
            "wb_green":         1.0,
            "wb_blue":          1.0,
            "wb_manual_supported": False,
            "supports": {
                "wb_manual":    False,
                "wb_auto":      False,
                "auto_exposure": True,
                "gamma":        True,
                "roi":          True,
            },
            "gamma":            float(gamma),
            "gamma_min":        float(gamma_min),
            "gamma_max":        float(gamma_max),
            "roi": {
                "offset_x": 0,
                "offset_y": 0,
                "width":    w,
                "height":   h,
            },
            "sensor_width":     self._sensor_width,
            "sensor_height":    self._sensor_height,
            "roi_width_inc":    self._roi_w_unit,
            "roi_height_inc":   self._roi_h_unit,
        }

    # ------------------------------------------------------------------
    # is_null
    # ------------------------------------------------------------------

    @property
    def is_null(self) -> bool:
        return False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _require_open(self) -> None:
        if not self._opened or self._cam_handle is None:
            raise RuntimeError("Camera not open")

    def _set_abs_feature(self, feature: int, value: float) -> None:
        """Enable absolute control for a feature and set its absolute value."""
        cam = self._cam_handle
        lib = _lib
        if cam is None or lib is None:
            raise RuntimeError("Camera not open")
        _check(
            lib.dc1394_feature_set_absolute_control(cam, feature, DC1394_ON),
            f"feature_set_absolute_control feature={feature}",
        )
        _check(
            lib.dc1394_feature_set_absolute_value(cam, feature, ctypes.c_float(value)),
            f"feature_set_absolute_value feature={feature} value={value}",
        )

    def _get_abs_feature(self, feature: int) -> float:
        """Read the absolute value of an IIDC feature."""
        cam = self._cam_handle
        lib = _lib
        if cam is None or lib is None:
            raise RuntimeError("Camera not open")
        val = ctypes.c_float(0.0)
        _check(
            lib.dc1394_feature_get_absolute_value(cam, feature, ctypes.byref(val)),
            f"feature_get_absolute_value feature={feature}",
        )
        return float(val.value)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _check(err: int, context: str = "") -> None:
    """Raise RuntimeError if err != DC1394_SUCCESS."""
    if err != DC1394_SUCCESS:
        raise RuntimeError(
            f"dc1394 error {err}" + (f" in {context}" if context else "")
        )


def _looks_like_access_error(err: int) -> bool:
    """Heuristic: libusb LIBUSB_ERROR_ACCESS is typically -3."""
    return err in (-3,)
