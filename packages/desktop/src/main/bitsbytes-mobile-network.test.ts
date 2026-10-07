import { describe, expect, test } from "bun:test"
import type { NetworkInterfaceInfo } from "node:os"
import { mobileAddresses, mobileLocalIP } from "./bitsbytes-mobile-network"

const address = (value: string, netmask = "255.255.255.0"): NetworkInterfaceInfo => ({
  address: value,
  netmask,
  family: "IPv4",
  internal: false,
  mac: "00:00:00:00:00:00",
  cidr: value + "/24",
})

describe("mobile QR network selection", () => {
  test("this laptop's VPN-first enumeration chooses Wi-Fi, with and without Windows metadata", () => {
    const interfaces = {
      "Radmin VPN": [address("26.76.14.46", "255.0.0.0")],
      "Home-Proxmox": [address("10.77.77.2", "255.255.255.255")],
      Bits_and_Bytes: [address("10.10.4.11", "255.255.255.255")],
      WiFi: [address("192.168.11.242")],
      "vEthernet (WSL (Hyper-V firewall))": [address("192.168.224.1")],
    }
    expect(mobileAddresses(interfaces)[0]).toEqual({ name: "WiFi", address: "192.168.11.242", kind: "lan" })
    expect(mobileAddresses(interfaces, [
      { name: "Home-Proxmox", hardware: false, up: true, metric: null },
      { name: "Bits_and_Bytes", hardware: false, up: true, metric: 1 },
      { name: "WiFi", hardware: true, up: true, metric: 35 },
      { name: "vEthernet (WSL (Hyper-V firewall))", hardware: false, up: true, metric: null },
    ])[0].address).toBe("192.168.11.242")
  })

  test("a renamed physical LAN wins over a virtual default route named Ethernet", () => {
    expect(mobileAddresses({
      Ethernet: [address("10.9.0.2")],
      Office: [address("10.10.1.15")],
      OldWiFi: [address("192.168.1.4")],
    }, [
      { name: "Ethernet", hardware: false, up: true, metric: 0 },
      { name: "Office", hardware: true, up: true, metric: 35 },
      { name: "OldWiFi", hardware: true, up: false, metric: 5 },
    ])).toEqual([
      { name: "Office", address: "10.10.1.15", kind: "lan" },
      { name: "Ethernet", address: "10.9.0.2", kind: "other" },
    ])
  })

  test("connected physical default routes use Windows route plus interface metrics", () => {
    expect(mobileAddresses({
      WiFi: [address("192.168.2.4")],
      Ethernet: [address("172.18.1.4", "255.255.0.0")],
      Isolated: [address("192.168.90.1")],
    }, [
      { name: "WiFi", hardware: true, up: true, metric: 45 },
      { name: "Ethernet", hardware: true, up: true, metric: 15 },
      { name: "Isolated", hardware: true, up: true, metric: null },
    ]).map((row) => row.name)).toEqual(["Ethernet", "WiFi", "Isolated"])
  })

  test("local, public, IPv6 and duplicate addresses never become extra QR choices", () => {
    const loopback = { ...address("127.0.0.1"), internal: true }
    const ipv6 = { ...address("::1"), family: "IPv6" as const, scopeid: 0 }
    expect(mobileAddresses({
      WiFi: [loopback, ipv6, address("8.8.8.8"), address("192.168.1.6")],
      Other: [address("192.168.1.6")],
    })).toHaveLength(1)
    expect(mobileAddresses({})).toEqual([])
    expect(mobileLocalIP("::ffff:192.168.1.6")).toBe(true)
    expect(mobileLocalIP("172.32.1.6")).toBe(false)
  })
})
