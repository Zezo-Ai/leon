import fs from 'node:fs'
import path from 'node:path'

import { command } from 'execa'

import {
  IS_GITHUB_ACTIONS,
  PYTHON_BRIDGE_SRC_PATH,
  PYTHON_TCP_SERVER_SRC_PATH
} from '@/constants'
import { CPUArchitectures, OSTypes } from '@/types'
import { LogHelper } from '@/helpers/log-helper'
import { LoaderHelper } from '@/helpers/loader-helper'
import { SystemHelper } from '@/helpers/system-helper'

/**
 * Set up development environment according to the given setup target
 * 1. Verify Python environment
 * 2. Verify if the targeted development environment is up-to-date
 * 3. If up-to-date, exit
 * 4. If not up-to-date, delete the outdated development environment and install the new one
 */

const SETUP_TARGETS = new Map()

SETUP_TARGETS.set('python-bridge', {
  name: 'Python bridge',
  pipfilePath: path.join(PYTHON_BRIDGE_SRC_PATH, 'Pipfile'),
  dotVenvPath: path.join(PYTHON_BRIDGE_SRC_PATH, '.venv'),
  dotProjectPath: path.join(PYTHON_BRIDGE_SRC_PATH, '.venv', '.project')
})
SETUP_TARGETS.set('tcp-server', {
  name: 'TCP server',
  pipfilePath: path.join(PYTHON_TCP_SERVER_SRC_PATH, 'Pipfile'),
  dotVenvPath: path.join(PYTHON_TCP_SERVER_SRC_PATH, '.venv'),
  dotProjectPath: path.join(PYTHON_TCP_SERVER_SRC_PATH, '.venv', '.project')
})
;(async () => {
  LoaderHelper.start()

  const { argv } = process
  const givenSetupTarget = argv[2].toLowerCase()
  if (!SETUP_TARGETS.has(givenSetupTarget)) {
    LogHelper.error(
      `Invalid setup target: ${givenSetupTarget}. Valid targets are: ${Array.from(
        SETUP_TARGETS.keys()
      ).join(', ')}`
    )
    process.exit(1)
  }

  const {
    name: setupTarget,
    pipfilePath,
    dotVenvPath,
    dotProjectPath
  } = SETUP_TARGETS.get(givenSetupTarget)

  LogHelper.info('Checking Python environment...')

  /**
   * Verify Python environment
   */

  // Check if the Pipfile exists
  if (fs.existsSync(pipfilePath)) {
    LogHelper.success(`${pipfilePath} found`)

    try {
      // Check if Pipenv is installed
      const pipenvVersionChild = await command('pipenv --version', {
        shell: true
      })
      let pipenvVersion = String(pipenvVersionChild.stdout)

      if (pipenvVersion.includes('version')) {
        pipenvVersion = pipenvVersion.split('version')[1].trim()
        pipenvVersion = `${pipenvVersion} version`
      }

      LogHelper.success(`Pipenv ${pipenvVersion} found`)
    } catch (e) {
      LogHelper.error(
        `${e}\nPlease install Pipenv: "pip install pipenv" or read the documentation https://docs.pipenv.org`
      )
      process.exit(1)
    }
  }

  /**
   * Install Python packages
   */

  LogHelper.info(`Setting up ${setupTarget} development environment...`)

  const pipfileMtime = fs.statSync(pipfilePath).mtime
  const hasDotVenv = fs.existsSync(dotVenvPath)
  const { type: osType, cpuArchitecture } = SystemHelper.getInformation()
  /**
   * IMPORTANT
   * How to deal with CUDA and PyTorch support
   * --
   * The TCP server dynamically loads PyTorch and NVIDIA libraries from
   * the shared "bin" paths. If these files are missing, re-run
   * "npm run postinstall" to download them.
   *
   * Current CUDA Toolkit to use is 12.4.1:
   * @see https://developer.nvidia.com/cuda-12-4-1-download-archive?target_os=Linux&target_arch=x86_64&Distribution=Ubuntu&target_version=22.04&target_type=deb_network
   *
   * If "nvcc --version" is not found, then need to map the PATH as below in ~/.bashrc:
   * export PATH=/usr/local/cuda-12.4/bin${PATH:+:${PATH}}
   * # Make sure there is no LD_LIBRARY_PATH in current environment (`echo $LD_LIBRARY_PATH` should be empty) since it will override the system path and create conflict on build
   * # export LD_LIBRARY_PATH=/usr/local/cuda-12.4/lib64${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
   *
   * Technically, we don't need CUDA Toolkit at runtime as libraries are loaded
   * from the shared "bin" paths.
   * Need to verify the compatibility matrix between PyTorch and CUDA:
   * @see IMPORTANT: https://github.com/pytorch/pytorch/blob/main/RELEASE.md#release-compatibility-matrix
   * @see https://pytorch.org/get-started/locally/
   *
   * @see CUDA driver x CUDA Toolkit compatibility: https://docs.nvidia.com/deploy/cuda-compatibility/#id3
   *
   * @see https://stackoverflow.com/a/76972265/1768162
   * @see https://docs.nvidia.com/deeplearning/cudnn/latest/reference/support-matrix.html
   */

  const hasSharedPyTorch = () => {
    const torchInitPath = path.join(
      process.cwd(),
      'bin',
      'pytorch',
      'torch',
      'torch',
      '__init__.py'
    )
    return fs.existsSync(torchInitPath)
  }
  /**
   * NLTK data are used for MeloTTS
   *
   * @see https://www.nltk.org/data.html
   */
  const downloadNLTKData = async () => {
    LogHelper.info('Downloading NLTK data...')

    try {
      await command('pipenv run python -m nltk.downloader cmudict', {
        shell: true,
        stdio: 'inherit'
      })
      await command(
        'pipenv run python -m nltk.downloader averaged_perceptron_tagger_eng',
        {
          shell: true,
          stdio: 'inherit'
        }
      )

      LogHelper.success('NLTK data downloaded')
    } catch (e) {
      LogHelper.error(`Failed to download NLTK data: ${e}`)
      process.exit(1)
    }
  }
  const installPythonPackages = async () => {
    LogHelper.info(`Installing Python packages from ${pipfilePath}...`)

    // Delete .venv directory to reset the development environment
    if (hasDotVenv) {
      LogHelper.info(`Deleting ${dotVenvPath}...`)
      await fs.promises.rm(dotVenvPath, { recursive: true, force: true })
      LogHelper.success(`${dotVenvPath} deleted`)
    }

    try {
      await command('pipenv install --verbose --skip-lock', {
        shell: true,
        stdio: 'inherit'
      })

      if (
        osType === OSTypes.MacOS &&
        cpuArchitecture === CPUArchitectures.ARM64
      ) {
        LogHelper.info('macOS ARM64 detected')

        LogHelper.info('Loading Rust environment from "$HOME/.cargo/env"...')
        await command('source "$HOME/.cargo/env"', {
          shell: true,
          stdio: 'inherit'
        })
        LogHelper.success('Rust environment loaded')

        try {
          LogHelper.info('Checking if Rust is already installed...')

          await command('rustc --version', {
            shell: true,
            stdio: 'inherit'
          })
          LogHelper.success('Rust is already installed')
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
          LogHelper.info(
            'Rust not found. Installing Rust installer as it is needed for the "tokenizers" package for macOS ARM64 architecture...'
          )
          await command('curl https://sh.rustup.rs -sSf | sh -s -- -y', {
            shell: true,
            stdio: 'inherit'
          })
          LogHelper.success('Rust installer installed')

          LogHelper.info('Reloading configuration from "$HOME/.cargo/env"...')
          await command('source "$HOME/.cargo/env"', {
            shell: true,
            stdio: 'inherit'
          })
          LogHelper.success('Configuration reloaded')

          LogHelper.info('Checking Rust compiler version...')
          await command('rustc --version', {
            shell: true,
            stdio: 'inherit'
          })
          LogHelper.success('Rust compiler OK')
        }
      }

      LogHelper.success('Python packages installed')

      if (givenSetupTarget === 'tcp-server') {
        if (!hasSharedPyTorch() && !IS_GITHUB_ACTIONS) {
          LogHelper.error(
            'Shared PyTorch bundle not found. Please run "npm run postinstall" and retry.'
          )
          process.exit(1)
        }

        if (!hasSharedPyTorch() && IS_GITHUB_ACTIONS) {
          LogHelper.info('Skipping shared PyTorch bundle check in CI')
        }

        LogHelper.success('Shared PyTorch bundle found')
        await downloadNLTKData()
      }
    } catch (e) {
      if (hasDotVenv) {
        await fs.promises.rm(dotVenvPath, { recursive: true, force: true })
        LogHelper.info(`Error occurred, so "${dotVenvPath}" was deleted`)
      }

      LogHelper.error(`Failed to install Python packages: ${e}`)

      if (osType === OSTypes.Linux || osType === OSTypes.MacOS) {
        LogHelper.error(
          'If the error is related to "PortAudio" not installed or found, you can install it by running: "sudo apt install portaudio19-dev" or "brew install portaudio". Then retry. PortAudio is required for the "pyaudio" package used to record audio'
        )
      }

      if (osType === OSTypes.Windows) {
        LogHelper.error(
          'Please check the error above. It might be related to Microsoft C++ Build Tools. If it is, you can check here: "https://stackoverflow.com/a/64262038/1768162" then restart your machine and retry'
        )
        LogHelper.error(
          'If it is related to some hash mismatch, you can try by installing Pipenv 2024.0.1: pip install pipenv==2024.0.1'
        )
      }

      process.exit(1)
    }
  }

  /**
   * Verify if a fresh development environment installation is necessary
   */

  // Required environment variables to set up
  process.env.PIPENV_PIPFILE = pipfilePath
  process.env.PIPENV_VENV_IN_PROJECT = true

  if (givenSetupTarget === 'python-bridge') {
    // As per: https://github.com/marcelotduarte/cx_Freeze/issues/1548
    process.env.PIP_NO_BINARY = 'cx_Freeze'
  }

  try {
    if (!hasDotVenv) {
      await installPythonPackages()
    } else {
      if (fs.existsSync(dotProjectPath)) {
        const dotProjectMtime = (await fs.promises.stat(dotProjectPath)).mtime

        // Check if Python deps tree has been modified since the initial setup
        if (pipfileMtime > dotProjectMtime) {
          LogHelper.info('The development environment is not up-to-date')
          await installPythonPackages()
        } else {
          LogHelper.success('Python packages are up-to-date')
        }
      } else {
        await installPythonPackages()
      }
    }
  } catch (e) {
    LogHelper.error(
      `Failed to set up the ${setupTarget} development environment: ${e}`
    )
  } finally {
    LoaderHelper.stop()
  }

  LogHelper.success(`${setupTarget} development environment ready`)
})()
