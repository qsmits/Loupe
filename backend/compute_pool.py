"""Bound the actual lifetime of CPU jobs, including disconnected SSE clients."""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from fastapi import HTTPException


class ComputePool:
    def __init__(self, capacity=3):
        self._slots = threading.BoundedSemaphore(capacity)
        self._executor = ThreadPoolExecutor(max_workers=capacity, thread_name_prefix='loupe-analysis')

    def submit(self, fn, *args, **kwargs):
        if not self._slots.acquire(blocking=False):
            raise HTTPException(503, detail='Analysis capacity is busy. Please try again shortly.')
        try:
            future = self._executor.submit(partial(fn, *args, **kwargs))
        except BaseException:
            self._slots.release()
            raise
        # An asyncio waiter may be cancelled while its native worker keeps
        # running. Only the concurrent future's completion releases the slot.
        future.add_done_callback(lambda _: self._slots.release())
        return future

    async def run(self, fn, *args, **kwargs):
        return await asyncio.wrap_future(self.submit(fn, *args, **kwargs))

    def shutdown(self):
        self._executor.shutdown(wait=True, cancel_futures=True)


fringe_compute = ComputePool()
