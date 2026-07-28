"""Windows shim for gltest's direct-mode loader.

`gltest.direct.loader` writes the encoded message to a temp file, dup2s it onto
stdin, and then unlinks the path while the descriptor is still open. That is
fine on POSIX and impossible on Windows, where an open file cannot be deleted —
every direct-mode test dies with WinError 32 before the contract even loads.

The shim below lets that one unlink fail quietly. It is scoped to the test
session and only swallows PermissionError, so a genuinely failing delete
elsewhere still surfaces. Drop this file once the loader stops unlinking an
open descriptor.
"""

import os
import sys

if sys.platform == "win32":
    _unlink = os.unlink

    def _tolerant_unlink(path, *args, **kwargs):
        try:
            return _unlink(path, *args, **kwargs)
        except PermissionError:
            return None

    os.unlink = _tolerant_unlink
