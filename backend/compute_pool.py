"""Bound the actual lifetime of CPU jobs, including disconnected SSE clients."""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import partial, wraps

from fastapi import HTTPException


class ComputePool:
    def __init__(self, capacity=3):
        self._slots = threading.BoundedSemaphore(capacity)
        self._capacity = capacity
        self._executor = None
        self._executor_lock = threading.Lock()

    def _get_executor(self):
        # Created lazily and re-created after shutdown(): the pools are
        # module singletons shared by every create_app() in one process.
        with self._executor_lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=self._capacity, thread_name_prefix='loupe-analysis')
            return self._executor

    def submit(self, fn, *args, **kwargs):
        if not self._slots.acquire(blocking=False):
            raise HTTPException(503, detail='Analysis capacity is busy. Please try again shortly.')
        try:
            future = self._get_executor().submit(partial(fn, *args, **kwargs))
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
        with self._executor_lock:
            executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)


fringe_compute = ComputePool()
# Detection / inspection routes: separate pool so a long fringe job cannot
# starve them (and vice versa). Each 12 MP inspection holds ~300 MB.
vision_compute = ComputePool(capacity=3)


def pooled(fn):
    """Turn a plain sync route body into an async route run via vision_compute.

    The original signature is preserved (functools.wraps) so FastAPI still
    validates the request before the pool is touched; exceptions raised in the
    worker (HTTPException included) propagate unchanged through the future.
    ``vision_compute.run`` is looked up at call time so tests can patch it.
    """
    @wraps(fn)
    async def wrapper(*args, **kwargs):
        return await vision_compute.run(fn, *args, **kwargs)
    return wrapper
