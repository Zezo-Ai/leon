import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

import { SystemHelper } from '@/helpers/system-helper'

export interface CommandProbe {
  available: boolean
  version: string
}

export interface DefaultRouteProbe {
  source: string
  route: string
}

export interface NvidiaSmiProbe {
  status: string
  gpus: Array<{
    name: string
    memoryMb: string
    driverVersion: string
  }>
}

export interface StorageSnapshotEntry {
  filesystem: string
  size: string
  used: string
  available: string
  usedPct: string
  mountPoint: string
}

export interface StorageSnapshot {
  source: string
  summary: string
  entries: StorageSnapshotEntry[]
}

export type ProcessCpuMetric = 'percent' | 'seconds'

export interface RunningProcessEntry {
  pid: number
  name: string
  cpu: number
  cpuMetric: ProcessCpuMetric
  memoryMb: number
  runtimeSeconds: number
  startedAt: string
}

export interface RunningProcessSnapshot {
  source: string
  sampledAt: string
  entries: RunningProcessEntry[]
}

export class ContextProbeHelper {
  public getSafeUsername(): string {
    try {
      return os.userInfo().username
    } catch {
      return process.env['USER'] || process.env['USERNAME'] || 'unknown'
    }
  }

  public runCommand(command: string, args: string[]): string | null {
    for (const candidate of this.getCommandCandidates(command)) {
      try {
        const output = execFileSync(candidate, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5_000
        }).trim()

        if (output.length > 0) {
          return output
        }
      } catch {
        continue
      }
    }

    return null
  }

  public probeCommandVersion(command: string, args: string[]): CommandProbe {
    const output = this.runCommand(command, args)
    if (!output) {
      return {
        available: false,
        version: 'unavailable'
      }
    }

    const version =
      output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) || 'unknown'

    return {
      available: true,
      version
    }
  }

  public formatCommandProbe(commandProbe: CommandProbe): string {
    if (!commandProbe.available) {
      return 'unavailable'
    }

    return `available (${commandProbe.version})`
  }

  public getOperatingSystemNameVersion(): string {
    if (SystemHelper.isLinux()) {
      const linuxReleaseInfo = this.parseLinuxOsRelease()
      if (linuxReleaseInfo.prettyName) {
        return linuxReleaseInfo.prettyName
      }

      if (linuxReleaseInfo.name && linuxReleaseInfo.version) {
        return `${linuxReleaseInfo.name} ${linuxReleaseInfo.version}`
      }

      if (linuxReleaseInfo.name) {
        return linuxReleaseInfo.name
      }

      return `Linux ${os.release()}`
    }

    if (SystemHelper.isMacOS()) {
      const productName = this.runCommand('sw_vers', ['-productName'])
      const productVersion = this.runCommand('sw_vers', ['-productVersion'])

      if (productName && productVersion) {
        return `${productName} ${productVersion}`
      }

      if (productName) {
        return productName
      }

      return `macOS ${os.release()}`
    }

    if (SystemHelper.isWindows()) {
      const rawWindowsInfo = this.runCommand('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version | ConvertTo-Json -Compress)'
      ])

      if (rawWindowsInfo) {
        try {
          const windowsInfo = JSON.parse(rawWindowsInfo) as {
            Caption?: string
            Version?: string
          }
          const caption = windowsInfo.Caption?.trim() || ''
          const version = windowsInfo.Version?.trim() || ''

          if (caption && version && !caption.includes(version)) {
            return `${caption} ${version}`
          }

          if (caption) {
            return caption
          }
        } catch {
          // Ignore parsing failures and fallback below.
        }
      }

      return `Windows ${os.release()}`
    }

    return `${os.type()} ${os.release()}`
  }

  public parseKeyValueFile(content: string): Record<string, string> {
    const output: Record<string, string> = {}

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) {
        continue
      }

      const separatorIndex = line.indexOf('=')
      if (separatorIndex < 1) {
        continue
      }

      const key = line.slice(0, separatorIndex).trim()
      const value = line
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1')

      if (key) {
        output[key] = value
      }
    }

    return output
  }

  public formatGiB(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return 'unknown'
    }

    return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GiB`
  }

  public formatUptime(totalSeconds: number): string {
    const safeTotalSeconds = Math.max(0, Math.floor(totalSeconds))
    const days = Math.floor(safeTotalSeconds / 86_400)
    const hours = Math.floor((safeTotalSeconds % 86_400) / 3_600)
    const minutes = Math.floor((safeTotalSeconds % 3_600) / 60)
    const seconds = safeTotalSeconds % 60
    const chunks: string[] = []

    if (days > 0) {
      chunks.push(`${days}d`)
    }

    if (hours > 0 || chunks.length > 0) {
      chunks.push(`${hours}h`)
    }

    chunks.push(`${minutes}m`)
    chunks.push(`${seconds}s`)

    return chunks.join(' ')
  }

  public redactProxyValue(proxyValue: string): string {
    if (!proxyValue || proxyValue === 'unset') {
      return 'unset'
    }

    try {
      const parsedUrl = new URL(proxyValue)
      if (parsedUrl.username || parsedUrl.password) {
        parsedUrl.username = '***'
        parsedUrl.password = '***'
      }
      return parsedUrl.toString()
    } catch {
      const atSymbolIndex = proxyValue.lastIndexOf('@')
      if (atSymbolIndex > 0) {
        return `***@${proxyValue.slice(atSymbolIndex + 1)}`
      }

      return proxyValue
    }
  }

  public isLikelyTunnelInterface(interfaceName: string): boolean {
    const lowerInterfaceName = interfaceName.toLowerCase()

    return (
      lowerInterfaceName.startsWith('tun') ||
      lowerInterfaceName.startsWith('tap') ||
      lowerInterfaceName.startsWith('wg') ||
      lowerInterfaceName.startsWith('ppp') ||
      lowerInterfaceName.startsWith('utun') ||
      lowerInterfaceName.includes('wireguard') ||
      lowerInterfaceName.includes('tailscale') ||
      lowerInterfaceName.includes('vpn')
    )
  }

  public probeDefaultRoute(): DefaultRouteProbe {
    if (SystemHelper.isMacOS()) {
      return this.probeDefaultRouteMacOS()
    }

    if (SystemHelper.isWindows()) {
      return this.probeDefaultRouteWindows()
    }

    return this.probeDefaultRouteLinux()
  }

  public probeNvidiaSmi(): NvidiaSmiProbe {
    try {
      const rawOutput =
        this.runCommand('nvidia-smi', [
          '--query-gpu=name,memory.total,driver_version',
          '--format=csv,noheader,nounits'
        ]) || ''

      if (!rawOutput) {
        return {
          status: 'no_output',
          gpus: []
        }
      }

      const gpus = rawOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name = 'unknown', memoryMb = 'unknown', driverVersion = 'unknown'] =
            line.split(',').map((part) => part.trim())

          return {
            name,
            memoryMb,
            driverVersion
          }
        })

      return {
        status: 'ok',
        gpus
      }
    } catch {
      return {
        status: 'unavailable',
        gpus: []
      }
    }
  }

  public probeStorage(): StorageSnapshot {
    if (SystemHelper.isWindows()) {
      return this.probeStorageWindows()
    }

    return this.probeStorageUnix()
  }

  public probeRunningProcesses(limit = 80): RunningProcessSnapshot {
    if (SystemHelper.isWindows()) {
      return this.probeRunningProcessesWindows(limit)
    }

    return this.probeRunningProcessesUnix(limit)
  }

  private getCommandCandidates(command: string): string[] {
    if (!SystemHelper.isWindows() || /[\\/]/.test(command)) {
      return [command]
    }

    return [...new Set([`${command}.cmd`, `${command}.exe`, command])]
  }

  private parseLinuxOsRelease(): {
    prettyName: string
    name: string
    version: string
  } {
    const osReleasePath = '/etc/os-release'
    if (!fs.existsSync(osReleasePath)) {
      return {
        prettyName: '',
        name: '',
        version: ''
      }
    }

    try {
      const osReleaseRaw = fs.readFileSync(osReleasePath, 'utf8')
      const parsedValues = this.parseKeyValueFile(osReleaseRaw)

      return {
        prettyName: parsedValues['PRETTY_NAME'] || '',
        name: parsedValues['NAME'] || '',
        version: parsedValues['VERSION'] || parsedValues['VERSION_ID'] || ''
      }
    } catch {
      return {
        prettyName: '',
        name: '',
        version: ''
      }
    }
  }

  private probeDefaultRouteLinux(): DefaultRouteProbe {
    const ipRouteOutput = this.runCommand('ip', ['route', 'show', 'default'])
    if (ipRouteOutput) {
      const firstLine = ipRouteOutput
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)

      if (firstLine) {
        const gateway = firstLine.match(/\bvia\s+([^\s]+)/)?.[1] || 'unknown'
        const networkInterface =
          firstLine.match(/\bdev\s+([^\s]+)/)?.[1] || 'unknown'
        const metric = firstLine.match(/\bmetric\s+([^\s]+)/)?.[1]

        return {
          source: 'ip route show default',
          route: `gateway ${gateway} | interface ${networkInterface}${metric ? ` | metric ${metric}` : ''}`
        }
      }
    }

    const routeOutput = this.runCommand('route', ['-n'])
    if (routeOutput) {
      const routeLine = routeOutput
        .split('\n')
        .map((line) => line.trim())
        .find(
          (line) => line.startsWith('0.0.0.0') || line.startsWith('default')
        )

      if (routeLine) {
        const normalizedParts = routeLine.replace(/\s+/g, ' ').split(' ')

        return {
          source: 'route -n',
          route: `gateway ${normalizedParts[1] || 'unknown'} | interface ${
            normalizedParts.at(-1) || 'unknown'
          }`
        }
      }
    }

    return {
      source: 'unavailable',
      route: 'unknown'
    }
  }

  private probeDefaultRouteMacOS(): DefaultRouteProbe {
    const routeOutput = this.runCommand('route', ['-n', 'get', 'default'])
    if (!routeOutput) {
      return {
        source: 'unavailable',
        route: 'unknown'
      }
    }

    const gateway = this.extractPrefixedLineValue(routeOutput, 'gateway:')
    const networkInterface = this.extractPrefixedLineValue(
      routeOutput,
      'interface:'
    )

    return {
      source: 'route -n get default',
      route: `gateway ${gateway || 'unknown'} | interface ${
        networkInterface || 'unknown'
      }`
    }
  }

  private probeDefaultRouteWindows(): DefaultRouteProbe {
    const powershellOutput = this.runCommand('powershell', [
      '-NoProfile',
      '-Command',
      'Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' | Sort-Object RouteMetric | Select-Object -First 1 -Property NextHop,InterfaceAlias,RouteMetric | ConvertTo-Json -Compress'
    ])

    if (powershellOutput) {
      try {
        const routeData = JSON.parse(powershellOutput) as {
          NextHop?: string
          InterfaceAlias?: string
          RouteMetric?: number | string
        }

        return {
          source: 'powershell Get-NetRoute',
          route: `gateway ${routeData.NextHop || 'unknown'} | interface ${
            routeData.InterfaceAlias || 'unknown'
          }${
            routeData.RouteMetric !== undefined
              ? ` | metric ${routeData.RouteMetric}`
              : ''
          }`
        }
      } catch {
        // Ignore parsing failures and fallback below.
      }
    }

    return {
      source: 'unavailable',
      route: 'unknown'
    }
  }

  private extractPrefixedLineValue(
    content: string,
    linePrefix: string
  ): string | null {
    const normalizedPrefix = linePrefix.toLowerCase()
    const line = content
      .split('\n')
      .map((lineContent) => lineContent.trim())
      .find((lineContent) =>
        lineContent.toLowerCase().startsWith(normalizedPrefix)
      )

    if (!line) {
      return null
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      return null
    }

    const value = line.slice(separatorIndex + 1).trim()
    return value || null
  }

  private probeStorageUnix(): StorageSnapshot {
    try {
      const rawOutput = this.runCommand('df', ['-hP']) || ''

      const rows = rawOutput
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/\s+/g, ' ').split(' '))
        .filter((parts) => parts.length >= 6)
        .map((parts) => ({
          filesystem: parts[0] || 'unknown',
          size: parts[1] || 'unknown',
          used: parts[2] || 'unknown',
          available: parts[3] || 'unknown',
          usedPct: parts[4] || 'unknown',
          mountPoint: parts.slice(5).join(' ') || 'unknown'
        }))

      const targetRow =
        rows.find((row) => row.mountPoint === os.homedir()) ||
        rows.find((row) => row.mountPoint === '/home') ||
        rows.find((row) => row.mountPoint === '/') ||
        rows[0]

      const summary = targetRow
        ? `Storage snapshot shows ${targetRow.available} free on ${targetRow.mountPoint}.`
        : 'Storage snapshot unavailable.'

      return {
        source: 'df -hP',
        summary,
        entries: rows.slice(0, 12)
      }
    } catch {
      return {
        source: 'df -hP (failed)',
        summary: 'Storage snapshot unavailable.',
        entries: []
      }
    }
  }

  private probeStorageWindows(): StorageSnapshot {
    try {
      const rawOutput =
        this.runCommand('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,FileSystem,Size,FreeSpace | ConvertTo-Json -Compress'
        ]) || ''

      if (!rawOutput) {
        return {
          source: 'powershell Get-CimInstance Win32_LogicalDisk',
          summary: 'Storage snapshot unavailable.',
          entries: []
        }
      }

      const parsedData = JSON.parse(rawOutput) as
        | {
            DeviceID?: string
            FileSystem?: string
            Size?: number | string
            FreeSpace?: number | string
          }
        | Array<{
            DeviceID?: string
            FileSystem?: string
            Size?: number | string
            FreeSpace?: number | string
          }>
      const storageRows = Array.isArray(parsedData) ? parsedData : [parsedData]

      const entries: StorageSnapshotEntry[] = storageRows.map((row) => {
        const sizeBytes = Number(row.Size || 0)
        const freeBytes = Number(row.FreeSpace || 0)
        const usedBytes = Math.max(sizeBytes - freeBytes, 0)
        const usedPct =
          sizeBytes > 0 ? `${((usedBytes / sizeBytes) * 100).toFixed(0)}%` : '0%'

        return {
          filesystem: row.FileSystem || 'local-disk',
          size: this.formatGiB(sizeBytes),
          used: this.formatGiB(usedBytes),
          available: this.formatGiB(freeBytes),
          usedPct,
          mountPoint: row.DeviceID || 'unknown'
        }
      })

      const normalizedHomeDirectory = os
        .homedir()
        .slice(0, 2)
        .toUpperCase()
      const targetRow =
        entries.find((row) =>
          row.mountPoint.toUpperCase().startsWith(normalizedHomeDirectory)
        ) || entries[0]

      return {
        source: 'powershell Get-CimInstance Win32_LogicalDisk',
        summary: targetRow
          ? `Storage snapshot shows ${targetRow.available} free on ${targetRow.mountPoint}.`
          : 'Storage snapshot unavailable.',
        entries: entries.slice(0, 12)
      }
    } catch {
      return {
        source: 'powershell Get-CimInstance Win32_LogicalDisk (failed)',
        summary: 'Storage snapshot unavailable.',
        entries: []
      }
    }
  }

  private probeRunningProcessesUnix(limit: number): RunningProcessSnapshot {
    const commandPlans: Array<{
      args: string[]
      source: string
      elapsedMode: 'seconds' | 'duration'
    }> = [
      {
        args: ['-eo', 'pid=,comm=,%cpu=,rss=,etimes='],
        source: 'ps -eo pid=,comm=,%cpu=,rss=,etimes=',
        elapsedMode: 'seconds'
      },
      {
        args: ['-A', '-o', 'pid=,comm=,%cpu=,rss=,etime='],
        source: 'ps -A -o pid=,comm=,%cpu=,rss=,etime=',
        elapsedMode: 'duration'
      }
    ]

    for (const commandPlan of commandPlans) {
      const rawOutput = this.runCommand('ps', commandPlan.args)
      if (!rawOutput) {
        continue
      }

      const entries = rawOutput
        .split('\n')
        .map((line) =>
          this.parseUnixProcessLine(line, commandPlan.elapsedMode)
        )
        .filter((entry): entry is RunningProcessEntry => Boolean(entry))
        .sort((entryA, entryB) => {
          if (entryA.cpu !== entryB.cpu) {
            return entryB.cpu - entryA.cpu
          }

          if (entryA.memoryMb !== entryB.memoryMb) {
            return entryB.memoryMb - entryA.memoryMb
          }

          return entryB.runtimeSeconds - entryA.runtimeSeconds
        })
        .slice(0, Math.max(1, limit))

      if (entries.length > 0) {
        return {
          source: commandPlan.source,
          sampledAt: new Date().toISOString(),
          entries
        }
      }
    }

    return {
      source: 'ps unavailable',
      sampledAt: new Date().toISOString(),
      entries: []
    }
  }

  private probeRunningProcessesWindows(limit: number): RunningProcessSnapshot {
    const powershellScript = `
$now = Get-Date
Get-Process | ForEach-Object {
  $startTimeIso = ''
  $runtimeSeconds = 0

  try {
    $startTime = $_.StartTime
    $startTimeIso = $startTime.ToUniversalTime().ToString('o')
    $runtimeSeconds = [int]($now - $startTime).TotalSeconds
  } catch {
    $startTimeIso = ''
    $runtimeSeconds = 0
  }

  [PSCustomObject]@{
    pid = $_.Id
    name = $_.ProcessName
    cpuSeconds = [double]($_.CPU -as [double])
    memoryBytes = [double]($_.WorkingSet64)
    startedAt = $startTimeIso
    runtimeSeconds = $runtimeSeconds
  }
} | Sort-Object cpuSeconds -Descending | Select-Object -First ${Math.max(1, limit)} | ConvertTo-Json -Compress
    `.trim()

    const rawOutput = this.runCommand('powershell', [
      '-NoProfile',
      '-Command',
      powershellScript
    ])

    if (!rawOutput) {
      return {
        source: 'powershell Get-Process unavailable',
        sampledAt: new Date().toISOString(),
        entries: []
      }
    }

    try {
      const parsedValue = JSON.parse(rawOutput) as
        | {
            pid?: number
            name?: string
            cpuSeconds?: number
            memoryBytes?: number
            startedAt?: string
            runtimeSeconds?: number
          }
        | Array<{
            pid?: number
            name?: string
            cpuSeconds?: number
            memoryBytes?: number
            startedAt?: string
            runtimeSeconds?: number
          }>

      const rows = Array.isArray(parsedValue) ? parsedValue : [parsedValue]
      const entries = rows
        .map((row) => {
          const pid = Number(row.pid)
          const name = (row.name || '').trim()
          const cpuSeconds = Number(row.cpuSeconds || 0)
          const memoryBytes = Number(row.memoryBytes || 0)
          const runtimeSeconds = Math.max(0, Number(row.runtimeSeconds || 0))

          if (!Number.isFinite(pid) || !name) {
            return null
          }

          const entry: RunningProcessEntry = {
            pid,
            name,
            cpu: Number.isFinite(cpuSeconds) ? cpuSeconds : 0,
            cpuMetric: 'seconds',
            memoryMb: Number.isFinite(memoryBytes)
              ? Number((memoryBytes / (1_024 * 1_024)).toFixed(1))
              : 0,
            runtimeSeconds,
            startedAt: row.startedAt || this.formatStartedAt(runtimeSeconds)
          }

          return entry
        })
        .filter(this.isRunningProcessEntry)
        .sort((entryA, entryB) => {
          if (entryA.cpu !== entryB.cpu) {
            return entryB.cpu - entryA.cpu
          }

          if (entryA.memoryMb !== entryB.memoryMb) {
            return entryB.memoryMb - entryA.memoryMb
          }

          return entryB.runtimeSeconds - entryA.runtimeSeconds
        })
        .slice(0, Math.max(1, limit))

      return {
        source: 'powershell Get-Process',
        sampledAt: new Date().toISOString(),
        entries
      }
    } catch {
      return {
        source: 'powershell Get-Process (parse failed)',
        sampledAt: new Date().toISOString(),
        entries: []
      }
    }
  }

  private parseUnixProcessLine(
    line: string,
    elapsedMode: 'seconds' | 'duration'
  ): RunningProcessEntry | null {
    const normalizedLine = line.trim().replace(/\s+/g, ' ')
    if (!normalizedLine) {
      return null
    }

    const matchedLine = normalizedLine.match(
      /^(\d+)\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)$/
    )
    if (!matchedLine) {
      return null
    }

    const pid = Number(matchedLine[1] || 0)
    const name = matchedLine[2] || ''
    const cpuPercent = Number(matchedLine[3] || 0)
    const rssKb = Number(matchedLine[4] || 0)
    const elapsedValue = matchedLine[5] || '0'
    const runtimeSeconds =
      elapsedMode === 'seconds'
        ? Number(elapsedValue || 0)
        : this.parseElapsedDuration(elapsedValue)

    if (!Number.isFinite(pid) || !name) {
      return null
    }

    return {
      pid,
      name,
      cpu: Number.isFinite(cpuPercent) ? Number(cpuPercent.toFixed(1)) : 0,
      cpuMetric: 'percent',
      memoryMb: Number.isFinite(rssKb) ? Number((rssKb / 1_024).toFixed(1)) : 0,
      runtimeSeconds: Number.isFinite(runtimeSeconds)
        ? Math.max(0, Math.floor(runtimeSeconds))
        : 0,
      startedAt: this.formatStartedAt(runtimeSeconds)
    }
  }

  private parseElapsedDuration(duration: string): number {
    const trimmedDuration = duration.trim()
    if (!trimmedDuration) {
      return 0
    }

    let days = 0
    let timePart = trimmedDuration

    if (trimmedDuration.includes('-')) {
      const [dayPart = '0', rawTimePart = '0:00:00'] = trimmedDuration.split('-')
      days = Number(dayPart || 0)
      timePart = rawTimePart
    }

    const chunks = timePart
      .split(':')
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))

    if (chunks.length === 0) {
      return 0
    }

    if (chunks.length === 1) {
      const [seconds = 0] = chunks
      return days * 86_400 + seconds
    }

    if (chunks.length === 2) {
      const [minutes = 0, seconds = 0] = chunks
      return days * 86_400 + minutes * 60 + seconds
    }

    const [hours = 0, minutes = 0, seconds = 0] = chunks.slice(-3)
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
  }

  private formatStartedAt(runtimeSeconds: number): string {
    if (!Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
      return 'unknown'
    }

    return new Date(Date.now() - runtimeSeconds * 1_000).toISOString()
  }

  private isRunningProcessEntry(
    entry: RunningProcessEntry | null
  ): entry is RunningProcessEntry {
    return Boolean(entry)
  }
}
