import os
import urllib.request
from abc import ABC, abstractmethod
from typing import Callable, Dict, Optional, Union
from .toolkit_config import ToolkitConfig
from .leon import leon
from .utils import is_windows, is_macos
from ..constants import TOOLKITS_PATH
import subprocess
import time
from typing import List, Any

# Progress callback type for reporting tool progress
ProgressCallback = Callable[[Dict[str, Optional[Union[str, int, float]]]], None]


# Command execution options
class ExecuteCommandOptions:
    def __init__(
        self,
        binary_name: str,
        args: List[str],
        options: Optional[Dict[str, Any]] = None,
        on_progress: Optional[ProgressCallback] = None,
        on_output: Optional[Callable[[str, bool], None]] = None
    ):
        self.binary_name = binary_name
        self.args = args
        self.options = options or {}
        self.on_progress = on_progress
        self.on_output = on_output


class BaseTool(ABC):
    """Base class for Python tools"""

    @property
    @abstractmethod
    def tool_name(self) -> str:
        """Tool name"""
        pass

    @property
    @abstractmethod
    def toolkit(self) -> str:
        """Toolkit name"""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Tool description"""
        pass

    def execute_command(self, options: ExecuteCommandOptions) -> str:
        """Execute a command with proper Leon messaging and progress tracking"""

        binary_name = options.binary_name
        args = options.args
        exec_options = options.options
        on_progress = options.on_progress
        on_output = options.on_output

        sync = exec_options.get('sync', True) if exec_options else True

        # Get binary path (auto-downloads if needed)
        binary_path = self.get_binary_path(binary_name)
        command_string = f'"{binary_path}" {" ".join(args)}'

        leon.answer({
            'key': 'bridges.tools.executing_command',
            'data': {
                'binary_name': binary_name,
                'command': command_string
            }
        })

        if sync:
            return self._execute_sync_command(binary_path, args, command_string, exec_options)
        else:
            return self._execute_async_command(binary_path, args, command_string, exec_options, on_progress, on_output)

    def _execute_sync_command(
        self,
        binary_path: str,
        args: List[str],
        command_string: str,
        exec_options: Optional[Dict[str, Any]] = None
    ) -> str:
        """Execute command synchronously"""

        try:
            start_time = time.time()

            result = subprocess.run(
                [binary_path] + args,
                capture_output=True,
                text=True,
                timeout=exec_options.get('timeout') if exec_options else None,
                cwd=exec_options.get('cwd') if exec_options else None
            )

            execution_time = int((time.time() - start_time) * 1000)

            if result.returncode == 0:
                leon.answer({
                    'key': 'bridges.tools.command_completed',
                    'data': {
                        'command': command_string,
                        'execution_time': f'{execution_time}ms'
                    }
                })
                return result.stdout
            else:
                leon.answer({
                    'key': 'bridges.tools.command_failed',
                    'data': {
                        'command': command_string,
                        'error': result.stderr or 'Unknown error',
                        'exit_code': str(result.returncode),
                        'execution_time': f'{execution_time}ms'
                    }
                })
                raise Exception(f"Command failed with exit code {result.returncode}: {result.stderr}")

        except subprocess.TimeoutExpired as e:
            leon.answer({
                'key': 'bridges.tools.command_timeout',
                'data': {
                    'command': command_string,
                    'timeout': f'{e.timeout}s' if e.timeout else 'unknown'
                }
            })
            raise Exception(f"Command timed out after {e.timeout}s")
        except Exception as e:
            leon.answer({
                'key': 'bridges.tools.command_error',
                'data': {
                    'command': command_string,
                    'error': str(e)
                }
            })
            raise

    def _execute_async_command(
        self,
        binary_path: str,
        args: List[str],
        command_string: str,
        exec_options: Optional[Dict[str, Any]] = None,
        on_progress: Optional[ProgressCallback] = None,
        on_output: Optional[Callable[[str, bool], None]] = None
    ) -> str:
        """Execute command asynchronously with progress tracking"""

        try:
            start_time = time.time()
            output_buffer = ''

            process = subprocess.Popen(
                [binary_path] + args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=exec_options.get('cwd') if exec_options else None
            )

            # Read output in real time
            while True:
                stdout_line = process.stdout.readline() if process.stdout else ''
                stderr_line = process.stderr.readline() if process.stderr else ''

                if stdout_line:
                    output_buffer += stdout_line
                    if on_output:
                        on_output(stdout_line, False)
                    if on_progress:
                        on_progress({'status': 'running'})

                if stderr_line:
                    output_buffer += stderr_line
                    if on_output:
                        on_output(stderr_line, True)

                if process.poll() is not None:
                    break

            execution_time = int((time.time() - start_time) * 1000)

            if process.returncode == 0:
                leon.answer({
                    'key': 'bridges.tools.command_completed',
                    'data': {
                        'command': command_string,
                        'execution_time': f'{execution_time}ms'
                    }
                })

                if on_progress:
                    on_progress({'status': 'completed', 'percentage': 100})

                return output_buffer
            else:
                leon.answer({
                    'key': 'bridges.tools.command_failed',
                    'data': {
                        'command': command_string,
                        'exit_code': str(process.returncode),
                        'execution_time': f'{execution_time}ms'
                    }
                })
                raise Exception(f"Command failed with exit code {process.returncode}: {output_buffer}")

        except Exception as e:
            leon.answer({
                'key': 'bridges.tools.command_error',
                'data': {
                    'command': command_string,
                    'error': str(e)
                }
            })
            raise

    def get_binary_path(self, binary_name: str) -> str:
        """Get binary path and ensure it's downloaded"""
        from urllib.parse import urlparse

        # Get tool name without "Tool" suffix for config lookup
        tool_config_name = self.tool_name.lower().replace('tool', '')
        config = ToolkitConfig.load(self.toolkit, tool_config_name)
        binary_url = ToolkitConfig.get_binary_url(config)

        leon.answer({
            'key': 'bridges.tools.checking_binary',
            'data': {
                'binary_name': binary_name
            }
        })

        if not binary_url:
            leon.answer({
                'key': 'bridges.tools.no_binary_url',
                'data': {
                    'binary_name': binary_name
                }
            })
            raise Exception(f"No download URL found for binary '{binary_name}'")

        # Extract the actual filename from the URL
        parsed_url = urlparse(binary_url)
        actual_filename = os.path.basename(parsed_url.path)
        executable = f"{actual_filename}.exe" if is_windows() and not actual_filename.endswith(
            '.exe') else actual_filename

        bins_path = os.path.join(TOOLKITS_PATH, self.toolkit, 'bins')

        # Ensure toolkit bins directory exists
        if not os.path.exists(bins_path):
            leon.answer({
                'key': 'bridges.tools.creating_bins_directory',
                'data': {
                    'toolkit': self.toolkit
                }
            })
            os.makedirs(bins_path, exist_ok=True)

        binary_path = os.path.join(bins_path, executable)

        # Ensure binary is available before returning path
        if not os.path.exists(binary_path):
            self._download_binary_on_demand(binary_name, binary_url, executable)
        else:
            leon.answer({
                'key': 'bridges.tools.binary_found',
                'data': {
                    'binary_name': binary_name
                }
            })

        # Force chmod again in case it has been downloaded but somehow failed
        # so it could not chmod correctly earlier
        if not is_windows():
            leon.answer({
                'key': 'bridges.tools.applying_permissions',
                'data': {
                    'binary_name': binary_name
                }
            })
            os.chmod(binary_path, 0o755)

        leon.answer({
            'key': 'bridges.tools.binary_ready',
            'data': {
                'binary_name': binary_name
            }
        })

        return binary_path

    def _download_binary_on_demand(self, binary_name: str, binary_url: str, executable: str) -> None:
        """Download binary on-demand if not found"""

        try:
            bins_path = os.path.join(TOOLKITS_PATH, self.toolkit, 'bins')
            binary_path = os.path.join(bins_path, executable)

            leon.answer({
                'key': 'bridges.tools.binary_not_found',
                'data': {
                    'binary_name': binary_name
                }
            })

            self._download_binary(binary_url, binary_path)

            leon.answer({
                'key': 'bridges.tools.binary_downloaded',
                'data': {
                    'binary_name': binary_name
                }
            })

            # Make binary executable (Unix systems)
            if not is_windows():
                leon.answer({
                    'key': 'bridges.tools.making_executable',
                    'data': {
                        'binary_name': binary_name
                    }
                })
                os.chmod(binary_path, 0o755)

            # Remove quarantine attribute on macOS to prevent Gatekeeper blocking
            if is_macos():
                leon.answer({
                    'key': 'bridges.tools.removing_quarantine',
                    'data': {
                        'binary_name': binary_name
                    }
                })
                self._remove_quarantine_attribute(binary_path)

        except Exception as e:
            leon.answer({
                'key': 'bridges.tools.download_failed',
                'data': {
                    'binary_name': binary_name,
                    'error': str(e)
                }
            })
            raise Exception(f"Failed to download binary '{binary_name}': {str(e)}")

    def _remove_quarantine_attribute(self, file_path: str) -> None:
        """Remove macOS quarantine attribute to prevent Gatekeeper blocking"""

        try:
            # Use xattr to remove the com.apple.quarantine extended attribute
            result = subprocess.run(['xattr', '-d', 'com.apple.quarantine', file_path],
                                    capture_output=True, check=False)
            if result.returncode == 0:
                leon.answer({
                    'key': 'bridges.tools.quarantine_removed',
                    'data': {
                        'file_name': os.path.basename(file_path)
                    }
                })
            else:
                leon.answer({
                    'key': 'bridges.tools.quarantine_warning',
                    'data': {
                        'file_name': os.path.basename(file_path),
                        'exit_code': str(result.returncode)
                    }
                })
        except Exception as e:
            # Don't fail the entire process if quarantine removal fails
            leon.answer({
                'key': 'bridges.tools.quarantine_exception',
                'data': {
                    'file_name': os.path.basename(file_path),
                    'error': str(e)
                }
            })

    def _download_binary(self, url: str, output_path: str) -> None:
        """Download binary from URL using urllib (matches Python urllib pattern)"""

        try:
            leon.answer({
                'key': 'bridges.tools.downloading_from_url'
            })

            with urllib.request.urlopen(url) as response:
                with open(output_path, 'wb') as f:
                    f.write(response.read())
        except Exception as e:
            leon.answer({
                'key': 'bridges.tools.download_url_failed',
                'data': {
                    'error': str(e)
                }
            })
            raise Exception(f"Failed to download binary: {str(e)}")
