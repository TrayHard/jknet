//! Host OS and native architecture, independent of the launcher process.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSystem {
    pub os: &'static str,
    pub arch: &'static str,
}

impl HostSystem {
    pub fn current() -> Self {
        Self { os: std::env::consts::OS, arch: native_arch() }
    }

    pub fn supports_engines(self) -> bool {
        self.os == "windows" && matches!(self.arch, "x86" | "x86_64")
    }

    pub fn label(self) -> String {
        format!("{} ({})", self.os, self.arch)
    }

    pub fn cache_key(self, engine_id: &str) -> String {
        // Versioned because older caches chose archives by process width.
        format!("v2-{engine_id}-{}-{}", self.os, self.arch)
    }
}

#[cfg(windows)]
fn native_arch() -> &'static str {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }
    type IsWow64Process2 = unsafe extern "system" fn(*mut c_void, *mut u16, *mut u16) -> i32;
    static ARCH: OnceLock<&'static str> = OnceLock::new();
    ARCH.get_or_init(|| {
        let kernel: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        // Resolve dynamically: missing APIs must disable installs rather than
        // prevent the launcher from starting on an older Windows version.
        unsafe {
            let module = GetModuleHandleW(kernel.as_ptr());
            if module.is_null() { return "unknown"; }
            let address = GetProcAddress(module, c"IsWow64Process2".as_ptr().cast());
            if address.is_null() { return "unknown"; }
            let query: IsWow64Process2 = std::mem::transmute(address);
            let mut process = 0;
            let mut native = 0;
            if query(GetCurrentProcess(), &mut process, &mut native) == 0 {
                return "unknown";
            }
            match native {
                0x014c => "x86",
                0x8664 => "x86_64",
                0xaa64 => "aarch64",
                _ => "unknown",
            }
        }
    })
}

#[cfg(not(windows))]
fn native_arch() -> &'static str {
    std::env::consts::ARCH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_supported_windows_architectures_allow_engine_installs() {
        for os in ["windows", "linux", "macos", "unknown"] {
            for arch in ["x86", "x86_64", "aarch64", "arm", "unknown"] {
                let host = HostSystem { os, arch };
                assert_eq!(host.supports_engines(), os == "windows" && matches!(arch, "x86" | "x86_64"));
            }
        }
    }

    #[test]
    fn host_detection_and_cache_identity() {
        let host = HostSystem::current();
        assert_eq!(host.os, std::env::consts::OS);
        assert!(!host.arch.is_empty());
        let x86 = HostSystem { os: "windows", arch: "x86" };
        let x64 = HostSystem { os: "windows", arch: "x86_64" };
        assert_ne!(x86.cache_key("openjk"), x64.cache_key("openjk"));
        assert_ne!(x86.cache_key("openjk"), x86.cache_key("taystjk"));
        eprintln!("Detected host: {}", host.label());
    }
}
