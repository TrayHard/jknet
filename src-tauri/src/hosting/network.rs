//! The addresses of this machine on its local network.
//!
//! A friend on the same network joins the private server directly, so the
//! presence and the invites carry these addresses. Only private IPv4 ranges
//! count: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and the carrier-grade
//! `100.64.0.0/10` that some routers and VPNs hand out. Loopback and
//! link-local (`169.254.0.0/16`) never leave the machine.
//!
//! The list comes from `GetAdaptersAddresses`: interfaces that are up, Ethernet
//! first, then Wi-Fi, then the rest, at most four addresses.

use std::net::Ipv4Addr;

/// How many addresses a presence carries at most, the limit of the contract.
pub const MAX_LAN_ADDRESSES: usize = 4;

/// What kind of interface an address sits on, which decides its place in the
/// list: a friend on the same cable is likelier than one on the same Wi-Fi,
/// and a VPN adapter is the least likely of all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum InterfaceKind {
    Ethernet,
    Wifi,
    Other,
}

/// Whether a friend on the local network could reach this address.
pub fn is_lan_address(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    ip.is_private() || (a == 100 && (64..=127).contains(&b))
}

/// Picks the addresses worth publishing, in order, without duplicates.
pub fn pick(candidates: &[(InterfaceKind, Ipv4Addr)]) -> Vec<Ipv4Addr> {
    let mut sorted: Vec<(InterfaceKind, usize, Ipv4Addr)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, (_, ip))| is_lan_address(*ip))
        .map(|(order, (kind, ip))| (*kind, order, *ip))
        .collect();
    // Stable within a kind: the order Windows lists its adapters in.
    sorted.sort();
    let mut out: Vec<Ipv4Addr> = Vec::new();
    for (_, _, ip) in sorted {
        if !out.contains(&ip) {
            out.push(ip);
        }
        if out.len() == MAX_LAN_ADDRESSES {
            break;
        }
    }
    out
}

/// The addresses of this machine on its local network, best first.
///
/// An empty list is an answer, not a failure: a machine on a public address
/// or with no network at all has nothing for friends on its network.
pub fn lan_ipv4() -> Vec<Ipv4Addr> {
    pick(&adapters())
}

#[cfg(windows)]
fn adapters() -> Vec<(InterfaceKind, Ipv4Addr)> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211,
        IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // 16 KiB is what Microsoft suggests for a first try; the call says how
    // much it wants when that is not enough.
    let mut size: u32 = 16 * 1024;
    let mut buffer: Vec<u64> = Vec::new();
    let mut filled = false;
    for _ in 0..3 {
        // `u64` elements keep the buffer aligned for the structures in it.
        buffer = vec![0u64; (size as usize).div_ceil(8)];
        let result = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_INET),
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        if result == NO_ERROR {
            filled = true;
            break;
        }
        if result != ERROR_BUFFER_OVERFLOW {
            log::debug!("GetAdaptersAddresses answered {result}");
            return Vec::new();
        }
    }
    if !filled {
        // Adapters kept appearing between the calls: nothing was written.
        log::warn!("GetAdaptersAddresses wanted a larger buffer three times; no local addresses this time");
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: the list lives inside `buffer`, which the call filled and which
    // outlives this walk; every pointer followed is one the call wrote.
    unsafe {
        while !adapter.is_null() {
            let current = &*adapter;
            if current.OperStatus == IfOperStatusUp {
                let kind = match current.IfType {
                    IF_TYPE_ETHERNET_CSMACD => InterfaceKind::Ethernet,
                    IF_TYPE_IEEE80211 => InterfaceKind::Wifi,
                    _ => InterfaceKind::Other,
                };
                let mut unicast = current.FirstUnicastAddress;
                while !unicast.is_null() {
                    let address = &(*unicast).Address;
                    let sockaddr = address.lpSockaddr;
                    if !sockaddr.is_null() && (*sockaddr).sa_family == AF_INET {
                        let v4 = &*sockaddr.cast::<SOCKADDR_IN>();
                        let raw = v4.sin_addr.S_un.S_addr;
                        // `S_addr` is in network order, which is the order of
                        // the bytes in memory.
                        out.push((kind, Ipv4Addr::from(raw.to_ne_bytes())));
                    }
                    unicast = (*unicast).Next;
                }
            }
            adapter = current.Next;
        }
    }
    out
}

#[cfg(not(windows))]
fn adapters() -> Vec<(InterfaceKind, Ipv4Addr)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().expect("an IPv4")
    }

    #[test]
    fn the_private_ranges_and_cgnat_stay_and_loopback_and_link_local_go() {
        for kept in ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.23", "100.64.0.1", "100.127.255.254"] {
            assert!(is_lan_address(ip(kept)), "{kept}");
        }
        for dropped in [
            "127.0.0.1",
            "127.77.0.5",
            "169.254.10.20",
            "172.32.0.1",
            "100.128.0.1",
            "100.63.255.255",
            "203.0.113.5",
            "0.0.0.0",
        ] {
            assert!(!is_lan_address(ip(dropped)), "{dropped}");
        }
    }

    #[test]
    fn ethernet_comes_first_then_wifi_then_the_rest_and_four_at_most() {
        let picked = pick(&[
            (InterfaceKind::Other, ip("100.64.1.2")),
            (InterfaceKind::Wifi, ip("192.168.1.50")),
            (InterfaceKind::Ethernet, ip("127.0.0.1")),
            (InterfaceKind::Ethernet, ip("192.168.1.23")),
            (InterfaceKind::Other, ip("169.254.3.3")),
            (InterfaceKind::Ethernet, ip("10.0.0.7")),
            (InterfaceKind::Wifi, ip("192.168.1.50")),
            (InterfaceKind::Other, ip("172.20.0.2")),
        ]);
        assert_eq!(
            picked,
            [ip("192.168.1.23"), ip("10.0.0.7"), ip("192.168.1.50"), ip("100.64.1.2")]
        );
    }

    #[test]
    fn this_machine_answers_without_loopback_or_link_local() {
        // Whatever the machine has; the rule is what matters.
        for address in lan_ipv4() {
            assert!(is_lan_address(address), "{address}");
        }
    }
}
