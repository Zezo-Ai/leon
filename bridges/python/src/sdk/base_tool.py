import os
import urllib.request
import re
from abc import ABC, abstractmethod
from typing import Callable, Dict, Optional, Union, List, Any
from urllib.parse import urlparse
from .toolkit_config import ToolkitConfig
from .leon import leon
from .utils import is_windows, is_macos
from ..constants import TOOLKITS_PATH
import subprocess
import time

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
        on_output: Optional[Callable[[str, bool], None]] = None,
        skip_binary_download: bool = False
    ):
        self.binary_name = binary_name
        self.args = args
        self.options = options or {}
        self.on_progress = on_progress
        self.on_output = on_output
        self.skip_binary_download = skip_binary_download


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

    def _escape_shell_arg(self, arg: str) -> str:
        """
        Escape shell argument by escaping special characters with backslashes
        This follows the Unix/Linux shell escaping convention
        """
        # Don't escape URLs - they have their own structure
        try:
            parsed = urlparse(arg)
            # If urlparse succeeds and has a scheme, it's likely a valid URL
            if parsed.scheme:
                return arg
        except Exception:
            # Not a valid URL, continue with normal escaping
            pass

        if is_windows():
            # Windows: wrap in double quotes and escape internal quotes
            if ' ' in arg or '"' in arg or '&' in arg or '|' in arg:
                return f'"{arg.replace(chr(34), chr(92) + chr(34))}"'  # Replace " with \"
            return arg
        else:
            # Unix/Linux: escape special characters with backslashes
            return re.sub(r'(["\s\'$`\\(){}[\]|&;<>*?!])', r'\\\1', arg)

    def execute_command(self, options: ExecuteCommandOptions) -> str:
        """Execute a command with proper Leon messaging and progress tracking"""

        binary_name = options.binary_name
        args = options.args
        exec_options = options.options
        on_progress = options.on_progress
        on_output = options.on_output
        skip_binary_download = options.skip_binary_download

        sync = exec_options.get('sync', True) if exec_options else True

        # Get binary path (auto-downloads if needed)
        binary_path = self.get_binary_path(binary_name, skip_binary_download)
        command_string = f'"{binary_path}" {" ".join([self._escape_shell_arg(arg) for arg in args])}'

        # Generate a unique group ID for this command execution
        tool_group_id = f"{self.toolkit}_{self.tool_name}_{int(time.time() * 1000)}"

        self.report('bridges.tools.executing_command', {
            'binary_name': binary_name,
            'command': command_string
        }, tool_group_id)

        if sync:
            return self._execute_sync_command(binary_path, args, command_string, exec_options, tool_group_id)
        else:
            return self._execute_async_command(binary_path, args, command_string, exec_options, tool_group_id,
                                               on_progress, on_output)

    def _execute_sync_command(
        self,
        binary_path: str,
        args: List[str],
        command_string: str,
        exec_options: Optional[Dict[str, Any]] = None,
        tool_group_id: Optional[str] = None
    ) -> str:
        """Execute command synchronously"""

        try:
            start_time = time.time()

            result = subprocess.run(
                command_string,
                capture_output=True,
                text=True,
                shell=True,
                timeout=exec_options.get('timeout') if exec_options else None,
                cwd=exec_options.get('cwd') if exec_options else None
            )

            execution_time = int((time.time() - start_time) * 1000)

            if result.returncode == 0:
                self.report('bridges.tools.command_completed', {
                    'command': command_string,
                    'execution_time': f'{execution_time}ms'
                }, tool_group_id)
                return result.stdout
            else:
                self.report('bridges.tools.command_failed', {
                    'command': command_string,
                    'error': result.stderr or 'Unknown error',
                    'exit_code': str(result.returncode),
                    'execution_time': f'{execution_time}ms'
                }, tool_group_id)
                raise Exception(f"Command failed with exit code {result.returncode}: {result.stderr}")

        except subprocess.TimeoutExpired as e:
            self.report('bridges.tools.command_timeout', {
                'command': command_string,
                'timeout': f'{e.timeout}s' if e.timeout else 'unknown'
            }, tool_group_id)
            raise Exception(f"Command timed out after {e.timeout}s")
        except Exception as e:
            self.report('bridges.tools.command_error', {
                'command': command_string,
                'error': str(e)
            }, tool_group_id)
            raise

    def _execute_async_command(
        self,
        binary_path: str,
        args: List[str],
        command_string: str,
        exec_options: Optional[Dict[str, Any]] = None,
        tool_group_id: Optional[str] = None,
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
                self.report('bridges.tools.command_completed', {
                    'command': command_string,
                    'execution_time': f'{execution_time}ms'
                }, tool_group_id)
                if on_progress:
                    on_progress({'status': 'completed', 'percentage': 100})
                return output_buffer
            else:
                self.report('bridges.tools.command_failed', {
                    'command': command_string,
                    'exit_code': str(process.returncode),
                    'execution_time': f'{execution_time}ms'
                }, tool_group_id)
                raise Exception(f"Command failed with exit code {process.returncode}: {output_buffer}")

        except Exception as e:
            self.report('bridges.tools.command_error', {
                'command': command_string,
                'error': str(e)
            }, tool_group_id)
            raise

    def get_binary_path(self, binary_name: str, skip_binary_download: bool = False) -> str:
        """Get binary path and ensure it's downloaded"""
        from urllib.parse import urlparse

        # For built-in commands like bash, just return the binary name
        if skip_binary_download:
            return binary_name

        # Get tool name without "Tool" suffix for config lookup
        tool_config_name = self.tool_name.lower().replace('tool', '')
        config = ToolkitConfig.load(self.toolkit, tool_config_name)
        binary_url = ToolkitConfig.get_binary_url(config)

        self.report('bridges.tools.checking_binary', {
            'binary_name': binary_name
        })
        if not binary_url:
            self.report('bridges.tools.no_binary_url', {
                'binary_name': binary_name
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
            self.report('bridges.tools.creating_bins_directory', {
                'toolkit': self.toolkit
            })
            os.makedirs(bins_path, exist_ok=True)

        binary_path = os.path.join(bins_path, executable)

        # Ensure binary is available before returning path
        if not os.path.exists(binary_path):
            self._download_binary_on_demand(binary_name, binary_url, executable)

        # Force chmod again in case it has been downloaded but somehow failed
        # so it could not chmod correctly earlier
        if not is_windows():
            self.report('bridges.tools.applying_permissions', {
                'binary_name': binary_name
            })
            os.chmod(binary_path, 0o755)

        self.report('bridges.tools.binary_ready', {
            'binary_name': binary_name
        })

        return binary_path

    def _download_binary_on_demand(self, binary_name: str, binary_url: str, executable: str) -> None:
        """Download binary on-demand if not found"""

        try:
            bins_path = os.path.join(TOOLKITS_PATH, self.toolkit, 'bins')
            binary_path = os.path.join(bins_path, executable)

            self.report('bridges.tools.binary_not_found', {
                'binary_name': binary_name
            })

            self._download_binary(binary_url, binary_path)

            self.report('bridges.tools.binary_downloaded', {
                'binary_name': binary_name
            })

            # Make binary executable (Unix systems)
            if not is_windows():
                self.report('bridges.tools.making_executable', {
                    'binary_name': binary_name
                })
                os.chmod(binary_path, 0o755)

            # Remove quarantine attribute on macOS to prevent Gatekeeper blocking
            if is_macos():
                self.report('bridges.tools.removing_quarantine', {
                    'binary_name': binary_name
                })
                self._remove_quarantine_attribute(binary_path)

        except Exception as e:
            self.report('bridges.tools.download_failed', {
                'binary_name': binary_name,
                'error': str(e)
            })
            raise Exception(f"Failed to download binary '{binary_name}': {str(e)}")

    def _remove_quarantine_attribute(self, file_path: str) -> None:
        """Remove macOS quarantine attribute to prevent Gatekeeper blocking"""

        try:
            # Use xattr to remove the com.apple.quarantine extended attribute
            result = subprocess.run(['xattr', '-d', 'com.apple.quarantine', file_path],
                                    capture_output=True, check=False)
            if result.returncode == 0:
                self.report('bridges.tools.quarantine_removed', {
                    'file_name': os.path.basename(file_path)
                })
            else:
                self.report('bridges.tools.quarantine_warning', {
                    'file_name': os.path.basename(file_path),
                    'exit_code': str(result.returncode)
                })
        except Exception as e:
            # Don't fail the entire process if quarantine removal fails
            self.report('bridges.tools.quarantine_exception', {
                'file_name': os.path.basename(file_path),
                'error': str(e)
            })

    def _download_binary(self, url: str, output_path: str) -> None:
        """Download binary from URL using urllib (matches Python urllib pattern)"""

        try:
            self.report('bridges.tools.downloading_from_url', {})
            with urllib.request.urlopen(url) as response:
                with open(output_path, 'wb') as f:
                    f.write(response.read())
        except Exception as e:
            self.report('bridges.tools.download_url_failed', {
                'error': str(e)
            })
            raise Exception(f"Failed to download binary: {str(e)}")

    def report(self, key: str, data: Optional[Dict[str, Any]] = None, tool_group_id: Optional[str] = None) -> None:
        """
        Report tool status or information using leon.answer with automatic toolkit/tool context
        
        Args:
            key: The message key for leon.answer
            data: Optional data dictionary
            tool_group_id: Optional tool group ID for command grouping
        """
        core_data = {
            'isToolOutput': True,
            'toolkitName': self.toolkit,
            'toolName': self.tool_name
        }

        if tool_group_id:
            core_data['toolGroupId'] = tool_group_id

        leon.answer({
            'key': key,
            'data': data or {},
            'core': core_data
        })
