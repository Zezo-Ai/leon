import os from 'node:os'

import { ContextFile } from '@/core/context-manager/context-file'
import { ContextProbeHelper } from '@/core/context-manager/context-probe-helper'

export class HostSystemContextFile extends ContextFile {
  public readonly filename = 'HOST_SYSTEM.md'
  public readonly ttlMs = null

  public constructor(private readonly probeHelper: ContextProbeHelper) {
    super()
  }

  public generate(): string {
    const username = this.probeHelper.getSafeUsername()
    const operatingSystemNameVersion =
      this.probeHelper.getOperatingSystemNameVersion()
    const shell =
      process.env['SHELL'] ||
      process.env['COMSPEC'] ||
      process.env['ComSpec'] ||
      'unknown'
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'unknown'
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
    const ownerLocation = this.probeHelper.probeOwnerLocation({
      timeZone,
      locale
    })
    const vpnProxyStatus = this.probeHelper.probeVpnOrProxyStatus()
    const cpuModel = os.cpus()[0]?.model || 'unknown'
    const cpuCores = os.cpus().length
    const totalMemory = this.probeHelper.formatGiB(os.totalmem())
    const bootTimeIso = new Date(Date.now() - os.uptime() * 1_000).toISOString()

    return [
      `> Host system is ${operatingSystemNameVersion} (${os.platform()} ${os.release()}, ${os.arch()}), user ${username}, shell ${shell}, owner location ${ownerLocation.value}${vpnProxyStatus.behindVpnOrProxy ? ' (VPN/proxy detected).' : '.'}`,
      '# HOST_SYSTEM',
      `- OS name and version: ${operatingSystemNameVersion}`,
      `- Platform: ${os.platform()}`,
      `- OS type: ${os.type()}`,
      `- OS release: ${os.release()}`,
      `- Architecture: ${os.arch()}`,
      `- Hostname: ${os.hostname()}`,
      `- Locale: ${locale}`,
      `- Time zone: ${timeZone}`,
      `- Owner location: ${ownerLocation.value}`,
      `- Owner location source: ${ownerLocation.source}`,
      `- Owner location confidence: ${ownerLocation.confidence}`,
      `- VPN/proxy detected: ${vpnProxyStatus.behindVpnOrProxy ? 'yes' : 'no'}`,
      `- VPN/proxy reasons: ${vpnProxyStatus.reasons.join(', ') || 'none'}`,
      `- VPN tunnel interfaces: ${vpnProxyStatus.tunnelInterfaces.join(', ') || 'none'}`,
      `- VPN-related processes: ${vpnProxyStatus.vpnProcesses.join(', ') || 'none'}`,
      `- CPU model: ${cpuModel}`,
      `- CPU cores: ${cpuCores}`,
      `- Total RAM: ${totalMemory}`,
      `- Username: ${username}`,
      `- Home directory: ${os.homedir()}`,
      `- Shell: ${shell}`,
      `- Boot time (UTC): ${bootTimeIso}`,
      `- Uptime: ${this.probeHelper.formatUptime(os.uptime())}`,
      `- Temporary directory: ${os.tmpdir()}`
    ].join('\n')
  }
}
