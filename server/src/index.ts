import { spawn } from 'node:child_process'
import fs from 'node:fs'

import psList from 'ps-list'
import kill from 'tree-kill'

import {
  IS_DEVELOPMENT_ENV,
  IS_PRODUCTION_ENV,
  IS_TELEMETRY_ENABLED,
  LANG as LEON_LANG,
  NVIDIA_CUBLAS_PATH,
  NVIDIA_CUDNN_PATH,
  NVIDIA_CUSPARSE_PATH,
  NVIDIA_CUSPARSE_FULL_PATH,
  NVIDIA_NCCL_PATH,
  NVIDIA_NVJITLINK_PATH,
  NVIDIA_NVSHMEM_PATH,
  NVIDIA_LIBS_PATH,
  PYTORCH_TORCH_PATH,
  PYTHON_TCP_SERVER_BIN_PATH,
  SHOULD_START_PYTHON_TCP_SERVER
} from '@/constants'
import {
  PYTHON_TCP_CLIENT,
  HTTP_SERVER,
  SOCKET_SERVER,
  LLM_PROVIDER,
  LLM_MANAGER,
  TOOLKIT_REGISTRY,
  CONTEXT_MANAGER,
  PULSE_MANAGER
} from '@/core'
import { shouldIgnoreTCPServerError } from '@/utilities'
import { Updater } from '@/updater'
import { Telemetry } from '@/telemetry'
// import { CustomNERLLMDuty } from '@/core/llm-manager/llm-duties/custom-ner-llm-duty'
// import { SummarizationLLMDuty } from '@/core/llm-manager/llm-duties/summarization-llm-duty'
// import { TranslationLLMDuty } from '@/core/llm-manager/llm-duties/translation-llm-duty'
// import { ParaphraseLLMDuty } from '@/core/llm-manager/llm-duties/paraphrase-llm-duty'
// import { ActionRecognitionLLMDuty } from '@/core/llm-manager/llm-duties/action-recognition-llm-duty'
import { LangHelper } from '@/helpers/lang-helper'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'
;(async (): Promise<void> => {
  process.title = 'leon'
  const shouldStartPythonTCPServer = SHOULD_START_PYTHON_TCP_SERVER

  // Kill any existing Leon process before starting a new one
  const processList = await psList()
  processList
    .filter(
      (p) =>
        (shouldStartPythonTCPServer &&
          (p.cmd?.includes(PYTHON_TCP_SERVER_BIN_PATH) ||
            // PyTorch thread from the TCP server (from binary, not from npm start:tcp-server command)
            (p.name?.includes('pt_main_thread') && !p.cmd?.includes('main.py')))) ||
        (p.cmd === process.title && p.pid !== process.pid)
    )
    .forEach((p) => {
      kill(p.pid)
      LogHelper.info(`Killed existing Leon process: ${p.pid}`)
    })

  /**
   * Start the Python TCP server
   *
   * If running "npm start:tcp-server en" cmd,
   * then can manually delete process from task manager to avoid
   * to have 2 TCP servers running at the same time
   */
  if (shouldStartPythonTCPServer) {
    LogHelper.time('TCP Server ready')
    const tcpServerArgs = [
      LangHelper.getShortCode(LEON_LANG),
      '--pytorch-path',
      PYTORCH_TORCH_PATH,
      '--nvidia-path',
      NVIDIA_LIBS_PATH
    ]
    const tcpServerCmd = [PYTHON_TCP_SERVER_BIN_PATH, ...tcpServerArgs]
      .map((arg) => `"${arg}"`)
      .join(' ')

    const tcpServerEnv = { ...process.env }

    if (SystemHelper.isLinux()) {
      const torchLibPath = `${PYTORCH_TORCH_PATH}/lib`
      const nvidiaLibPaths = [
        `${NVIDIA_CUBLAS_PATH}/lib`,
        `${NVIDIA_CUDNN_PATH}/lib`,
        `${NVIDIA_CUSPARSE_PATH}/lib`,
        `${NVIDIA_CUSPARSE_FULL_PATH}/lib`,
        `${NVIDIA_NCCL_PATH}/lib`,
        `${NVIDIA_NVSHMEM_PATH}/lib`,
        `${NVIDIA_NVJITLINK_PATH}/lib`
      ]
      const existingLdPath = tcpServerEnv['LD_LIBRARY_PATH']
      const combinedLdPath = [torchLibPath, ...nvidiaLibPaths, existingLdPath]
        .filter(Boolean)
        .join(':')
      tcpServerEnv['LD_LIBRARY_PATH'] = combinedLdPath
    }

    global.pythonTCPServerProcess = spawn(tcpServerCmd, {
      shell: true,
      detached: IS_DEVELOPMENT_ENV,
      env: tcpServerEnv
    })
    global.pythonTCPServerProcess.stdout.on('data', (data: Buffer) => {
      LogHelper.title('Python TCP Server')
      LogHelper.info(data.toString())

      if (data.toString().includes('connection...')) {
        LogHelper.timeEnd('TCP Server ready')
      }
    })
    global.pythonTCPServerProcess.stderr.on('data', (data: Buffer) => {
      const formattedData = data.toString().trim()
      const shouldIgnore = shouldIgnoreTCPServerError(formattedData)

      if (shouldIgnore) {
        return
      }

      LogHelper.title('Python TCP Server')
      LogHelper.error(data.toString())
    })

    // Connect the Python TCP client to the Python TCP server
    PYTHON_TCP_CLIENT.connect()
  } else {
    LogHelper.title('Python TCP Server')
    LogHelper.info(
      'Skipped startup because routing mode is "agent" and ASR/STT + TTS are disabled'
    )
  }

  try {
    // Start the HTTP server before heavyweight LLM startup so the client can
    // render the initialization UI while local providers continue booting.
    await HTTP_SERVER.init()
  } catch (e) {
    LogHelper.error(`HTTP server failed to init: ${e}`)
  }

  // Start the socket server as early as possible so init status events can
  // flow to the client while the rest of Leon keeps booting.
  await SOCKET_SERVER.init()
  PULSE_MANAGER.start()

  let isLLMProviderReady = false

  try {
    isLLMProviderReady = await LLM_PROVIDER.init()
  } catch (e) {
    LogHelper.error(`LLM Provider failed to init: ${e}`)
  }

  if (isLLMProviderReady) {
    try {
      await LLM_MANAGER.loadLLM()
    } catch (e) {
      LogHelper.error(`LLM Manager failed to load: ${e}`)
    }
  } else {
    LogHelper.warning('Skipping LLM Manager load because LLM Provider is not ready')
  }

  try {
    await TOOLKIT_REGISTRY.load()
  } catch (e) {
    LogHelper.error(`Toolkit Registry failed to load: ${e}`)
  }

  try {
    await CONTEXT_MANAGER.load()
  } catch (e) {
    LogHelper.error(`Context Manager failed to load: ${e}`)
  }

  /*const actionRecognitionDuty = new ActionRecognitionLLMDuty({
    input: 'Provide a number'
  })
  await actionRecognitionDuty.execute()*/

  /*const customNERDuty = new CustomNERLLMDuty({
    input:
      'Add apples, 1L of milk, orange juice and tissues to the shopping list',
    data: {
      schema: {
        items: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        list_name: {
          type: 'string'
        }
      }
    }
  })
  await customNERDuty.execute()*/

  /*const summarizationDuty = new SummarizationLLMDuty({
    input:
      'We’ll be taking several important safety steps ahead of making Sora available in OpenAI’s products. We are working with red teamers domain experts in areas like misinformation, hateful content, and bias who will be adversarially testing the model.\n' +
      '\n' +
      'We’re also building tools to help detect misleading content such as a detection classifier that can tell when a video was generated by Sora. We plan to include C2PA metadata in the future if we deploy the model in an OpenAI product.\n' +
      '\n' +
      'In addition to us developing new techniques to prepare for deployment, we’re leveraging the existing safety methods that we built for our products that use DALL·E 3, which are applicable to Sora as well.\n' +
      '\n' +
      'For example, once in an OpenAI product, our text classifier will check and reject text input prompts that are in violation of our usage policies, like those that request extreme violence, sexual content, hateful imagery, celebrity likeness, or the IP of others. We’ve also developed robust image classifiers that are used to review the frames of every video generated to help ensure that it adheres to our usage policies, before it’s shown to the user.\n' +
      '\n' +
      'We’ll be engaging policymakers, educators and artists around the world to understand their concerns and to identify positive use cases for this new technology. Despite extensive research and testing, we cannot predict all of the beneficial ways people will use our technology, nor all the ways people will abuse it. That’s why we believe that learning from real-world use is a critical component of creating and releasing increasingly safe AI systems over time.'
  })
  await summarizationDuty.execute()*/

  /*const paraphraseDuty = new ParaphraseLLMDuty({
    input: 'I added your items to the shopping list.'
  })
  await paraphraseDuty.execute()*/

  /*const translationDuty = new TranslationLLMDuty({
    input: 'the weather is good in shenzhen',
    data: {
      // source: 'French',
      target: 'French',
      autoDetectLanguage: true
    }
  })
  await translationDuty.execute()*/

  // TODO
  // Register HTTP API endpoints
  // await HTTP_API.register()

  // Check for updates on startup and every 24 hours
  if (IS_PRODUCTION_ENV) {
    Updater.checkForUpdates()
    setInterval(
      () => {
        Updater.checkForUpdates()
      },
      1_000 * 3_600 * 24
    )
  }

  // Telemetry events
  if (IS_TELEMETRY_ENABLED) {
    Telemetry.start()

    // Watch for errors in the error log file and report them to the telemetry service
    fs.watchFile(LogHelper.ERRORS_FILE_PATH, async () => {
      const logErrors = await LogHelper.parseErrorLogs()
      const lastError = logErrors[logErrors.length - 1] || ''

      Telemetry.error(lastError)
    })

    setInterval(
      () => {
        Telemetry.heartbeat()
      },
      1_000 * 3_600 * 6
    )
  }
  const shutdown = (exitCode = 0): void => {
    LLM_PROVIDER.dispose()

    if (global.pythonTCPServerProcess?.pid) {
      kill(global.pythonTCPServerProcess.pid as number)
    }

    if (IS_TELEMETRY_ENABLED) {
      Telemetry.stop()
    }

    setTimeout(() => {
      process.exit(exitCode)
    }, 1_000)
  }

  ;['exit', 'SIGINT', 'SIGUSR1', 'SIGUSR2', 'SIGTERM', 'SIGHUP'].forEach(
    (eventType) => {
      process.on(eventType, () => {
        shutdown(0)
      })
    }
  )

  process.on('uncaughtException', (error) => {
    LogHelper.title('Server')
    LogHelper.error(`Uncaught exception: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    shutdown(1)
  })

  process.on('unhandledRejection', (reason) => {
    LogHelper.title('Server')
    LogHelper.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
    shutdown(1)
  })
})()
