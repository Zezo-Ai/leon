import platform


class PlatformUtils:
    """
    Platform utilities for consistent platform and architecture detection
    Matches the naming convention from system-helper.ts BinaryFolderNames enum
    """

    @classmethod
    def get_platform_name(cls) -> str:
        """Get platform name with architecture granularity (matches system-helper.ts)
        Returns same format as BinaryFolderNames enum from system-helper.ts
        """
        system = platform.system().lower()
        architecture = platform.machine().lower()

        if system == 'linux':
            if architecture in ['x86_64', 'amd64']:
                return 'linux-x86_64'
            elif architecture in ['aarch64', 'arm64']:
                return 'linux-aarch64'
            else:
                # Default to x86_64 for unknown architectures on Linux
                return 'linux-x86_64'

        elif system == 'darwin':
            if architecture in ['arm64', 'aarch64'] or 'apple' in platform.processor().lower():
                return 'macosx-arm64'
            else:
                return 'macosx-x86_64'

        elif system == 'windows':
            return 'win-amd64'

        else:
            return 'unknown'

    @classmethod
    def is_windows(cls) -> bool:
        """Check if current platform is Windows"""
        return cls.get_platform_name().startswith('win')

    @classmethod
    def is_macos(cls) -> bool:
        """Check if current platform is macOS"""
        return cls.get_platform_name().startswith('macosx')

    @classmethod
    def is_linux(cls) -> bool:
        """Check if current platform is Linux"""
        return cls.get_platform_name().startswith('linux')
