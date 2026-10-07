import type { NetworkInterfaceInfo } from "node:os"

export type MobileAdapter = {
  name: string
  hardware: boolean
  up: boolean
  metric: number | null
}

export const mobileLocalIP = (address: string) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.replace(/^::ffff:/, "")) || address === "::1"

// OS enumeration order is not a route preference: VPNs often appear before Wi-Fi.
export function mobileAddresses(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  adapters: MobileAdapter[] = [],
) {
  const addresses = Object.entries(interfaces).flatMap(([name, rows]) => {
    const adapter = adapters.find((item) => item.name === name)
    if (adapter && !adapter.up) return []
    return (rows ?? [])
      .filter((row) => row.family === "IPv4" && !row.internal && mobileLocalIP(row.address))
      .map((row) => {
        const virtual = /vpn|wireguard|tailscale|zerotier|hyper-v|vethernet|virtual|wsl|docker|tun\d*|tap\d*/i.test(name)
        const lan = adapter
          ? adapter.hardware
          : !virtual && row.netmask !== "255.255.255.255"
        return {
          name,
          address: row.address,
          kind: lan ? ("lan" as const) : ("other" as const),
          rank: lan ? (adapter?.metric != null ? 0 : 1) : 2,
          metric: adapter?.metric ?? Number.MAX_SAFE_INTEGER,
        }
      })
  })
  return addresses
    .sort((a, b) => a.rank - b.rank || a.metric - b.metric || a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
    .filter((row, index, all) => all.findIndex((item) => item.address === row.address) === index)
    .map(({ name, address, kind }) => ({ name, address, kind }))
}
