import os
import urllib.request
from abc import ABC, abstractmethod
from .platform_utils import PlatformUtils
from ..constants import TOOLKITS_PATH
import subprocess


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

    def get_binary_path(self, binary_name: str) -> str:
        """Get binary path and ensure it's downloaded"""
        from .toolkit_config import ToolkitConfig
        from urllib.parse import urlparse

        # Get tool name without "Tool" suffix for config lookup
        tool_config_name = self.tool_name.lower().replace('tool', '')
        config = ToolkitConfig.load(self.toolkit, tool_config_name)
        binary_url = ToolkitConfig.get_binary_url(config)

        if not binary_url:
            raise Exception(f"No download URL found for binary '{binary_name}'")

        # Extract the actual filename from the URL
        parsed_url = urlparse(binary_url)
        actual_filename = os.path.basename(parsed_url.path)
        executable = f"{actual_filename}.exe" if PlatformUtils.is_windows() and not actual_filename.endswith(
            '.exe') else actual_filename

        bins_path = os.path.join(TOOLKITS_PATH, self.toolkit, 'bins')

        # Ensure toolkit bins directory exists
        if not os.path.exists(bins_path):
            os.makedirs(bins_path, exist_ok=True)

        binary_path = os.path.join(bins_path, executable)

        # Ensure binary is available before returning path
        if not os.path.exists(binary_path):
            self._download_binary_on_demand(binary_name, binary_url, executable)

        """
        Force chmod again in case it has been downloaded but somehow failed
        so it could not chmod correctly earlier
        """
        if not PlatformUtils.is_windows():
            os.chmod(binary_path, 0o755)

        return binary_path

    def _download_binary_on_demand(self, binary_name: str, binary_url: str, executable: str) -> None:
        """Download binary on-demand if not found"""
        try:
            bins_path = os.path.join(TOOLKITS_PATH, self.toolkit, 'bins')
            binary_path = os.path.join(bins_path, executable)

            print(f"{binary_name} binary not found. Downloading...")
            self._download_binary(binary_url, binary_path)
            print(f"{binary_name} binary downloaded successfully")

            # Make binary executable (Unix systems)
            if not PlatformUtils.is_windows():
                os.chmod(binary_path, 0o755)

            # Remove quarantine attribute on macOS to prevent Gatekeeper blocking
            if PlatformUtils.is_macos():
                self._remove_quarantine_attribute(binary_path)

        except Exception as e:
            raise Exception(f"Failed to download binary '{binary_name}': {str(e)}")

    def _remove_quarantine_attribute(self, file_path: str) -> None:
        """Remove macOS quarantine attribute to prevent Gatekeeper blocking"""
        try:
            # Use xattr to remove the com.apple.quarantine extended attribute
            subprocess.run(['xattr', '-d', 'com.apple.quarantine', file_path],
                           capture_output=True, check=False)
            print(f"Removed quarantine attribute from {os.path.basename(file_path)}")
        except Exception as e:
            # Don't fail the entire process if quarantine removal fails
            print(f"Warning: Could not remove quarantine attribute from {os.path.basename(file_path)}: {str(e)}")

    def _download_binary(self, url: str, output_path: str) -> None:
        """Download binary from URL using urllib (no external dependencies)"""
        try:
            with urllib.request.urlopen(url) as response:
                with open(output_path, 'wb') as f:
                    f.write(response.read())
        except Exception as e:
            raise Exception(f"Failed to download binary: {str(e)}")
