//! A private Windows desktop keeps the capture window off every user monitor.
//! The renderer still owns a normal window and framebuffer (no jaMME pbuffer).
use std::{
    io,
    process::{Child, Command, ExitStatus},
};

pub enum VideoProcess {
    Normal(Child),
    #[cfg(windows)]
    Isolated(IsolatedProcess),
}
impl VideoProcess {
    pub fn spawn(command: &mut Command, isolated: bool) -> io::Result<Self> {
        #[cfg(windows)]
        if isolated {
            return IsolatedProcess::spawn(command).map(Self::Isolated);
        }
        let _ = isolated;
        command.spawn().map(Self::Normal)
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self {
            Self::Normal(p) => p.try_wait(),
            #[cfg(windows)]
            Self::Isolated(p) => p.try_wait(),
        }
    }
    pub fn kill(&mut self) -> io::Result<()> {
        match self {
            Self::Normal(p) => p.kill(),
            #[cfg(windows)]
            Self::Isolated(p) => p.kill(),
        }
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        match self {
            Self::Normal(p) => p.wait(),
            #[cfg(windows)]
            Self::Isolated(p) => {
                unsafe {
                    WaitForSingleObject(p.process, u32::MAX);
                }
                p.try_wait()?.ok_or_else(io::Error::last_os_error)
            }
        }
    }
    pub fn close(&self) {
        #[cfg(windows)]
        if let Self::Isolated(p) = self {
            p.close();
        }
    }
}
#[cfg(windows)]
pub struct IsolatedProcess {
    process: isize,
    desktop: isize,
    pid: u32,
}
#[cfg(windows)]
#[repr(C)]
struct StartupInfo {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    chars_x: u32,
    chars_y: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved_ptr: *mut u8,
    stdin: isize,
    stdout: isize,
    stderr: isize,
}
#[cfg(windows)]
#[repr(C)]
struct ProcessInfo {
    process: isize,
    thread: isize,
    pid: u32,
    tid: u32,
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateProcessW(
        app: *const u16,
        command: *mut u16,
        process_security: *mut std::ffi::c_void,
        thread_security: *mut std::ffi::c_void,
        inherit: i32,
        flags: u32,
        env: *mut std::ffi::c_void,
        dir: *const u16,
        startup: *mut StartupInfo,
        result: *mut ProcessInfo,
    ) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetExitCodeProcess(handle: isize, code: *mut u32) -> i32;
    fn TerminateProcess(handle: isize, code: u32) -> i32;
    fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
}
#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn CreateDesktopW(
        name: *const u16,
        device: *const u16,
        mode: *mut std::ffi::c_void,
        flags: u32,
        access: u32,
        security: *mut std::ffi::c_void,
    ) -> isize;
    fn CloseDesktop(handle: isize) -> i32;
    fn EnumDesktopWindows(
        desktop: isize,
        callback: unsafe extern "system" fn(isize, isize) -> i32,
        data: isize,
    ) -> i32;
    fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    fn PostMessageW(window: isize, message: u32, w: usize, l: isize) -> i32;
}
#[cfg(windows)]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}
#[cfg(windows)]
fn quote(value: &std::ffi::OsStr) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.to_string_lossy().chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        out.push(c);
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
#[cfg(windows)]
impl IsolatedProcess {
    fn spawn(command: &Command) -> io::Result<Self> {
        let desktop_name = format!("JKNetCapture-{}", crate::user_files::id());
        let desktop = unsafe {
            CreateDesktopW(
                wide(desktop_name.as_ref()).as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                0x01ff,
                std::ptr::null_mut(),
            )
        };
        if desktop == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut name = wide(format!("WinSta0\\{desktop_name}").as_ref());
        let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
        startup.size = std::mem::size_of::<StartupInfo>() as u32;
        startup.desktop = name.as_mut_ptr();
        let mut info: ProcessInfo = unsafe { std::mem::zeroed() };
        let cmd = std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(quote)
            .collect::<Vec<_>>()
            .join(" ");
        let mut cmd = wide(cmd.as_ref());
        let dir = command.get_current_dir().map(|p| wide(p.as_os_str()));
        let ok = unsafe {
            CreateProcessW(
                wide(command.get_program()).as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                0x08000000,
                std::ptr::null_mut(),
                dir.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
                &mut startup,
                &mut info,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseDesktop(desktop);
            }
            return Err(error);
        }
        unsafe {
            CloseHandle(info.thread);
        }
        Ok(Self {
            process: info.process,
            desktop,
            pid: info.pid,
        })
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        use std::os::windows::process::ExitStatusExt;
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((code != 259).then(|| ExitStatus::from_raw(code)))
    }
    fn kill(&mut self) -> io::Result<()> {
        if unsafe { TerminateProcess(self.process, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn close(&self) {
        unsafe extern "system" fn close(window: isize, pid: isize) -> i32 {
            let mut owner = 0;
            unsafe {
                GetWindowThreadProcessId(window, &mut owner);
                if owner == pid as u32 {
                    PostMessageW(window, 0x0010, 0, 0);
                }
            }
            1
        }
        unsafe {
            EnumDesktopWindows(self.desktop, close, self.pid as isize);
        }
    }
}
#[cfg(windows)]
impl Drop for IsolatedProcess {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.process);
            CloseDesktop(self.desktop);
        }
    }
}
