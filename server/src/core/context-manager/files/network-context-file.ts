import os from 'node:os'
import dns from 'node:dns'

import { ContextFile } from '@/core/context-manager/context-file'
import { ContextProbeHelper } from '@/core/context-manager/context-probe-helper'

export class NetworkContextFile extends ContextFile {
  public readonly filename = 'NETWORK.md'
  public readonly ttlMs: number

  public constructor(
    private readonly probeHelper: ContextProbeHelper,
    ttlMs: number
  ) {
    super()
    this.ttlMs = ttlMs
  }

  public generate(): string {
    const interfaces = os.networkInterfaces()
    const networkLines: string[] = []
    const vpnInterfaces = new Set<string>()
    let ipv4Count = 0
    let ipv6Count = 0

    for (const [interfaceName, addresses] of Object.entries(interfaces)) {
      if (!addresses || addresses.length === 0) {
        continue
      }

      for (const address of addresses) {
        if (address.internal) {
          continue
        }

        if (address.family === 'IPv4') {
          ipv4Count++
        } else if (address.family === 'IPv6') {
          ipv6Count++
        }

        if (this.probeHelper.isLikelyTunnelInterface(interfaceName)) {
          vpnInterfaces.add(interfaceName)
        }

        const cidrSuffix = address.cidr ? ` | CIDR: ${address.cidr}` : ''
        networkLines.push(
          `- ${interfaceName} (${address.family}): ${address.address}${cidrSuffix}`
        )
      }
    }

    const defaultRoute = this.probeHelper.probeDefaultRoute()
    const dnsResolvers = dns.getServers()
    const proxyEnv = {
      http: this.probeHelper.redactProxyValue(
        process.env['HTTP_PROXY'] || process.env['http_proxy'] || 'unset'
      ),
      https: this.probeHelper.redactProxyValue(
        process.env['HTTPS_PROXY'] || process.env['https_proxy'] || 'unset'
      ),
      noProxy: this.probeHelper.redactProxyValue(
        process.env['NO_PROXY'] || process.env['no_proxy'] || 'unset'
      )
    }

    const hasProxyConfiguration =
      proxyEnv.http !== 'unset' || proxyEnv.https !== 'unset'
    const vpnSummary =
      vpnInterfaces.size > 0
        ? `VPN/tunnel interfaces detected (${[...vpnInterfaces].join(', ')})`
        : 'no VPN/tunnel interfaces detected'
    const summary = `Network context has ${networkLines.length} non-internal IP address(es) (${ipv4Count} IPv4, ${ipv6Count} IPv6), ${dnsResolvers.length} DNS resolver(s), ${vpnSummary}, and ${hasProxyConfiguration ? 'proxy configuration present' : 'no proxy configuration'}.`

    return [
      `> ${summary}`,
      '# NETWORK',
      `- Generated at: ${new Date().toISOString()}`,
      ...(
        networkLines.length > 0
          ? networkLines
          : ['- No non-internal network interfaces detected']
      ),
      `- Default route: ${defaultRoute.route}`,
      `- Default route source: ${defaultRoute.source}`,
      `- VPN/tunnel interfaces: ${vpnInterfaces.size > 0 ? [...vpnInterfaces].join(', ') : 'none'}`,
      `- DNS resolvers: ${dnsResolvers.length > 0 ? dnsResolvers.join(', ') : 'none detected'}`,
      `- HTTP proxy: ${proxyEnv.http}`,
      `- HTTPS proxy: ${proxyEnv.https}`,
      `- NO_PROXY: ${proxyEnv.noProxy}`
    ].join('\n')
  }
}
