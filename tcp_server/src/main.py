import argparse
import os
import sys
import threading
from os.path import join
from dotenv import load_dotenv


def _resolve_torch_root(pytorch_path: str) -> str | None:
    normalized_path = os.path.abspath(pytorch_path)
    if os.path.basename(normalized_path) == "torch" and os.path.isfile(
        os.path.join(normalized_path, "__init__.py")
    ):
        return normalized_path

    torch_candidate = os.path.join(normalized_path, "torch")
    if os.path.isfile(os.path.join(torch_candidate, "__init__.py")):
        return torch_candidate

    torch_nested_candidate = os.path.join(normalized_path, "torch", "torch")
    if os.path.isfile(os.path.join(torch_nested_candidate, "__init__.py")):
        return torch_nested_candidate

    return None


def _add_pytorch_path(pytorch_path: str | None) -> str | None:
    if not pytorch_path:
        return None

    torch_root = _resolve_torch_root(pytorch_path)
    if torch_root:
        sys.path.insert(0, os.path.dirname(torch_root))
        return torch_root

    sys.path.insert(0, os.path.abspath(pytorch_path))
    return None


def _set_library_paths(paths: list[str]) -> None:
    if not paths:
        return

    existing_path = ""

    if sys.platform.startswith("win"):
        add_dll_directory = getattr(os, "add_dll_directory", None)
        for path in paths:
            if os.path.isdir(path) and add_dll_directory:
                add_dll_directory(path)
        existing_path = os.environ.get("PATH", "")
        os.environ["PATH"] = (
            os.pathsep.join([*paths, existing_path])
            if existing_path
            else os.pathsep.join(paths)
        )
        return

    if sys.platform == "darwin":
        existing_path = os.environ.get("DYLD_LIBRARY_PATH", "")
        os.environ["DYLD_LIBRARY_PATH"] = (
            os.pathsep.join([*paths, existing_path])
            if existing_path
            else os.pathsep.join(paths)
        )
        return

    existing_path = os.environ.get("LD_LIBRARY_PATH", "")
    os.environ["LD_LIBRARY_PATH"] = (
        os.pathsep.join([*paths, existing_path])
        if existing_path
        else os.pathsep.join(paths)
    )


def _configure_external_libraries(
    pytorch_path: str | None, nvidia_path: str | None
) -> None:
    lib_paths = []
    torch_root = _add_pytorch_path(pytorch_path)

    if torch_root:
        torch_lib_path = os.path.join(torch_root, "lib")
        if os.path.isdir(torch_lib_path):
            lib_paths.append(torch_lib_path)

    if nvidia_path:
        nvidia_root = os.path.abspath(nvidia_path)
        for library in ["cublas", "cudnn", "cusparse", "nccl", "nvshmem"]:
            candidate = os.path.join(nvidia_root, library, "lib")
            if os.path.isdir(candidate):
                lib_paths.append(candidate)

    _set_library_paths(lib_paths)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Leon TCP server")
    parser.add_argument(
        "lang", nargs="?", default="en", help="Language code (e.g. en, fr)"
    )
    parser.add_argument("--pytorch-path", dest="pytorch_path", type=str, default=None)
    parser.add_argument("--nvidia-path", dest="nvidia_path", type=str, default=None)
    return parser.parse_args()


args = _parse_args()
os.environ["LEON_PY_TCP_SERVER_LANG"] = args.lang
_configure_external_libraries(args.pytorch_path, args.nvidia_path)

"""
os.getcwd() is the same as when we run it from npm run start:tcp-server en
and when we run it from the binary
"""
dotenv_path = join(os.getcwd(), ".env")
load_dotenv(dotenv_path)

import lib.nlp as nlp
from lib.tcp_server import TCPServer

nlp.load_spacy_model()

tcp_server_host = os.environ.get("LEON_PY_TCP_SERVER_HOST", "0.0.0.0")
tcp_server_port = os.environ.get("LEON_PY_TCP_SERVER_PORT", 1342)

tcp_server = TCPServer(tcp_server_host, tcp_server_port)

# Use thread as ASR starts recording audio and it blocks the main thread
asr_thread = threading.Thread(target=tcp_server.init_asr)
asr_thread.start()

tcp_server.init_tts()

tcp_server_thread = threading.Thread(target=tcp_server.init)
tcp_server_thread.start()
