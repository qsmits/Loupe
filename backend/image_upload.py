"""Validate compressed uploads before allocating decoded pixel buffers."""
from io import BytesIO

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

HOSTED_UPLOAD_BYTES = 20 * 1024 * 1024
HOSTED_IMAGE_PIXELS = 16 * 1024 * 1024
HOSTED_IMAGE_SIDE = 8192


def validate_image_upload(data: bytes, hosted: bool) -> None:
    if not hosted:
        return
    if len(data) > HOSTED_UPLOAD_BYTES:
        raise HTTPException(413, 'Image too large (max 20 MB)')
    try:
        # Opening reads headers only; do not call load() before these checks.
        with Image.open(BytesIO(data)) as image:
            w, h = image.size
            if w * h > HOSTED_IMAGE_PIXELS or max(w, h) > HOSTED_IMAGE_SIDE:
                raise HTTPException(413, 'Decoded image too large (max 16 megapixels and 8192 pixels per side)')
    except Image.DecompressionBombError:
        raise HTTPException(413, 'Decoded image too large') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, 'Cannot decode image') from None
