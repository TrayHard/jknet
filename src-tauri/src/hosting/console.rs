//! The process of the dedicated server, its console and its Job Object.
//!
//! A dedicated server needs a real console. Started the way the launcher
//! starts a client — `CREATE_NO_WINDOW` and null standard streams — OpenJK
//! x86 dies with `0xC0000005` right after `------- Game Initialization
//! -------` in six runs of seven: `CON_Show` calls `GetConsoleScreenBufferInfo`
//! without checking the result (`shared/sys/con_win32.cpp:193`) and writes
//! through garbage. Stage 0 of TASK-41 tried eight ways and picked two
//! (`notes/host-spike-2026-09-25.md` of the workspace):
//!
//! - **A, the way used:** a pseudo console (ConPTY). The process gets real
//!   console handles and no window at all, and its output arrives on a pipe,
//!   which gives the log, the tail of the Failed state and the reasons of a
//!   start that went wrong (`Couldn't bind`, `Can't find map`).
//! - **D, the fallback** when `CreatePseudoConsole` is missing or refuses:
//!   `CREATE_NO_WINDOW` without `STARTF_USESTDHANDLES`. A console without a
//!   window, and no output.
//!
//! Both start the process suspended, put it into a Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and `…_DIE_ON_UNHANDLED_EXCEPTION`
//! and only then resume it. When the launcher dies, Windows closes the job
//! handle and ends the server with it, so no port stays taken; a crash of the
//! server shows no error dialog.
//!
//! The rules the stage 0 found out the hard way:
//!
//! - `STARTF_USESTDHANDLES` with three `INVALID_HANDLE_VALUE` is what makes
//!   the child take the pseudo console. Without it the child inherits the
//!   launcher's own standard handles and OpenJK x86 crashes again.
//! - The reader of the output starts before the process and runs to the end
//!   of the pipe after `ClosePseudoConsole`. An unread pipe stalls the server.
//! - The output is a redrawn screen, not a stream of lines: escape sequences
//!   are cut out, a carriage return and a cursor jump end a line, trailing
//!   blanks go. The pseudo console is 1024 columns wide so a long line such
//!   as `InitGame` does not wrap.
//! - The job handle is not inheritable (`CreateJobObjectW(NULL, …)`): a game
//!   the launcher starts later with inherited handles must not keep it alive.
//! - `std::process::Command` cannot do any of this: it always sets
//!   `STARTF_USESTDHANDLES` and cannot resume a suspended process.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::error::Result;

/// Lines of the console the core keeps in memory, for `logTail`.
const TAIL_LINES: usize = 200;

/// The log of one server stops growing here; the tail in memory goes on.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// How the process was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleMethod {
    /// Method A: a pseudo console, output captured.
    PseudoConsole,
    /// Method D: a console without a window, no output.
    NoWindow,
}

/// What the console said that the session cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    /// `Opening IP socket`: the network part of the engine is up.
    SocketOpened,
    /// `------- Game Initialization -------`: the game module is loading.
    GameInitialization,
    /// `Couldn't bind to a v4 ip address`: all ten ports are taken.
    BindFailed,
    /// `Can't find map`: the map is not in any archive.
    MapMissing,
}

impl Marker {
    const ALL: [Marker; 4] = [
        Marker::SocketOpened,
        Marker::GameInitialization,
        Marker::BindFailed,
        Marker::MapMissing,
    ];

    /// The text that sets the marker, as `net_ip.cpp`, `g_main.c` and
    /// `sv_ccmds.cpp` of OpenJK print it.
    fn needle(self) -> &'static str {
        match self {
            Marker::SocketOpened => "Opening IP socket",
            Marker::GameInitialization => "Game Initialization",
            Marker::BindFailed => "Couldn't bind to a v4 ip address",
            Marker::MapMissing => "Can't find map",
        }
    }
}

/// The output of the server: the tail in memory, the log on disk and the
/// markers a start waits on. Shared between the reader thread and the
/// session.
#[derive(Default)]
pub struct ConsoleOutput {
    tail: Mutex<VecDeque<String>>,
    file: Mutex<Option<File>>,
    written: AtomicU64,
    /// One flag per entry of [`Marker::ALL`], in its order.
    markers: [AtomicBool; Marker::ALL.len()],
}

impl ConsoleOutput {
    /// An output that also writes `log`, created or truncated.
    pub fn with_log(log: &Path) -> ConsoleOutput {
        let output = ConsoleOutput::default();
        if let Some(folder) = log.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        match File::create(log) {
            Ok(file) => *output.file.lock().unwrap_or_else(|e| e.into_inner()) = Some(file),
            Err(e) => log::warn!("cannot write the server log {}: {e}", log.display()),
        }
        output
    }

    /// Writes a line of the launcher's own into the log, such as the note
    /// that the console of this server is not captured.
    pub fn note(&self, line: &str) {
        self.push_line(&format!("[JKNet] {line}"));
    }

    /// The last `count` lines, oldest first.
    pub fn tail(&self, count: usize) -> Vec<String> {
        let tail = self.tail.lock().unwrap_or_else(|e| e.into_inner());
        let skip = tail.len().saturating_sub(count);
        tail.iter().skip(skip).cloned().collect()
    }

    /// Whether the console printed the text of `marker` yet.
    pub fn saw(&self, marker: Marker) -> bool {
        let index = Marker::ALL.iter().position(|m| *m == marker).unwrap_or(0);
        self.markers[index].load(Ordering::Relaxed)
    }

    fn push_line(&self, line: &str) {
        for (index, marker) in Marker::ALL.iter().enumerate() {
            if line.contains(marker.needle()) {
                self.markers[index].store(true, Ordering::Relaxed);
            }
        }
        {
            let mut tail = self.tail.lock().unwrap_or_else(|e| e.into_inner());
            if tail.len() == TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.to_string());
        }
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = file.as_mut() {
            let bytes = line.len() as u64 + 1;
            let before = self.written.fetch_add(bytes, Ordering::Relaxed);
            if before + bytes <= MAX_LOG_BYTES {
                let _ = writeln!(handle, "{line}");
            } else if before <= MAX_LOG_BYTES {
                let _ = writeln!(handle, "[JKNet] the log stops here: it passed {MAX_LOG_BYTES} bytes");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cutting the escape sequences out of the pseudo console
// ---------------------------------------------------------------------------

/// Turns the byte stream of a pseudo console into plain text.
///
/// A state machine over ECMA-48: CSI sequences until their final byte, OSC
/// until BEL or ST, DCS until ST, two-byte character set selections. A cursor
/// jump to a row (`H` or `f`) ends the line, a carriage return ends it too
/// unless a line feed follows. Other control bytes are dropped.
#[derive(Default)]
pub struct VtText {
    state: u8,
    pending_cr: bool,
    line: Vec<u8>,
}

impl VtText {
    /// Feeds a chunk and calls `line` for every line it completed, with the
    /// trailing blanks cut and the empty lines skipped.
    pub fn feed(&mut self, input: &[u8], mut line: impl FnMut(&str)) {
        for &byte in input {
            match self.state {
                // Ground.
                0 => {
                    if self.pending_cr {
                        self.pending_cr = false;
                        self.end_line(&mut line);
                        if byte == b'\n' {
                            continue;
                        }
                    }
                    match byte {
                        0x1b => self.state = 1,
                        b'\r' => self.pending_cr = true,
                        b'\n' => self.end_line(&mut line),
                        b'\t' => self.line.push(b' '),
                        0x00..=0x1f | 0x7f => {}
                        _ => self.line.push(byte),
                    }
                }
                // After ESC.
                1 => {
                    self.state = match byte {
                        b'[' => 2,
                        b']' => 3,
                        b'P' => 5,
                        b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b'#' | b'%' => 7,
                        _ => 0,
                    }
                }
                // CSI: parameters and intermediates until a final byte.
                2 => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.state = 0;
                        if byte == b'H' || byte == b'f' {
                            self.end_line(&mut line);
                        }
                    }
                }
                // OSC until BEL or ST.
                3 => match byte {
                    0x07 => self.state = 0,
                    0x1b => self.state = 4,
                    _ => {}
                },
                4 => self.state = if byte == b'\\' { 0 } else { 3 },
                // DCS until ST.
                5 => {
                    if byte == 0x1b {
                        self.state = 6;
                    }
                }
                6 => self.state = if byte == b'\\' { 0 } else { 5 },
                // One byte of a character set selection.
                _ => self.state = 0,
            }
        }
    }

    /// Hands out what is left when the stream ends.
    pub fn finish(&mut self, mut line: impl FnMut(&str)) {
        self.pending_cr = false;
        self.end_line(&mut line);
    }

    fn end_line(&mut self, line: &mut impl FnMut(&str)) {
        let text = String::from_utf8_lossy(&self.line).into_owned();
        self.line.clear();
        let trimmed = text.trim_end();
        if !trimmed.is_empty() {
            line(trimmed);
        }
    }
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/// Quotes one argument the way `CommandLineToArgvW` and the CRT read it back.
pub fn quote_argument(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.chars().any(|c| c == ' ' || c == '\t' || c == '"');
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', backslashes));
        }
        backslashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The whole command line: the quoted executable, then every argument.
pub fn command_line(executable: &Path, args: &[String]) -> String {
    let mut line = quote_argument(&executable.display().to_string());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_argument(arg));
    }
    line
}

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

/// A dedicated server started by the launcher.
///
/// Dropping it ends the server: the job goes, and the job takes the process.
pub struct ServerProcess {
    pid: u32,
    method: ConsoleMethod,
    output: Arc<ConsoleOutput>,
    #[cfg(windows)]
    inner: windows::Inner,
}

impl ServerProcess {
    /// Starts `executable` with `args` in `working_dir`, method A first and
    /// D when the pseudo console is not available. The console goes to
    /// `output`, which may already carry lines of the launcher.
    pub fn spawn(
        executable: &Path,
        working_dir: &Path,
        args: &[String],
        output: Arc<ConsoleOutput>,
    ) -> Result<ServerProcess> {
        #[cfg(windows)]
        {
            windows::spawn(executable, working_dir, args, output)
        }
        #[cfg(not(windows))]
        {
            let _ = (executable, working_dir, args, output);
            Err(crate::error::AppError::HostStartFailed {
                reason: "a dedicated server can only be started on Windows".into(),
                exit_code: None,
            })
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn method(&self) -> ConsoleMethod {
        self.method
    }

    pub fn output(&self) -> &Arc<ConsoleOutput> {
        &self.output
    }

    /// The exit code once the process is gone, `None` while it runs.
    pub fn exit_code(&self) -> Option<u32> {
        self.wait(Duration::ZERO)
    }

    /// Waits up to `timeout` for the process to end.
    pub fn wait(&self, timeout: Duration) -> Option<u32> {
        #[cfg(windows)]
        {
            self.inner.wait(timeout)
        }
        #[cfg(not(windows))]
        {
            let _ = timeout;
            Some(0)
        }
    }

    /// Types a line into the console of the server, `quit` for example. Only
    /// a pseudo console has an input; answers whether the line went out.
    pub fn type_line(&self, line: &str) -> bool {
        #[cfg(windows)]
        {
            self.inner.type_line(line)
        }
        #[cfg(not(windows))]
        {
            let _ = line;
            false
        }
    }

    /// Ends the process and everything in its job.
    pub fn terminate(&self) {
        #[cfg(windows)]
        self.inner.terminate();
    }

    /// Ends the process if it still runs, closes the pseudo console, waits for
    /// the reader to drain it and releases every handle. Called once the
    /// server is down, so the tail and the log are complete; a second call
    /// does nothing, and the exit code stays readable.
    pub fn close(&self) {
        #[cfg(windows)]
        self.inner.close();
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        self.inner.close();
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use windows_sys::core::HRESULT;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Console::{COORD, HPCON};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    };

    use super::{command_line, ConsoleMethod, ConsoleOutput, ServerProcess, VtText};
    use crate::error::{AppError, Result};

    /// Columns of the pseudo console: wide enough that no line of the
    /// engine wraps.
    const COLUMNS: i16 = 1024;
    const ROWS: i16 = 50;

    type CreatePseudoConsoleFn =
        unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> HRESULT;
    type ClosePseudoConsoleFn = unsafe extern "system" fn(HPCON);

    /// A handle that may cross threads. Every use is a Win32 call that is
    /// itself thread safe.
    #[derive(Clone, Copy)]
    struct Handle(HANDLE);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    /// The two functions of the pseudo console, looked up at run time: a
    /// Windows 10 older than 1809 has neither, and the launcher must still
    /// start there and fall back to method D rather than fail to load.
    struct PseudoConsoleApi {
        create: CreatePseudoConsoleFn,
        close: ClosePseudoConsoleFn,
    }

    fn pseudo_console_api() -> Option<PseudoConsoleApi> {
        let kernel32: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        unsafe {
            let module = GetModuleHandleW(kernel32.as_ptr());
            if module.is_null() {
                return None;
            }
            let create = GetProcAddress(module, c"CreatePseudoConsole".as_ptr().cast())?;
            let close = GetProcAddress(module, c"ClosePseudoConsole".as_ptr().cast())?;
            Some(PseudoConsoleApi {
                create: std::mem::transmute::<unsafe extern "system" fn() -> isize, CreatePseudoConsoleFn>(create),
                close: std::mem::transmute::<unsafe extern "system" fn() -> isize, ClosePseudoConsoleFn>(close),
            })
        }
    }

    struct Pty {
        hpc: HPCON,
        close: ClosePseudoConsoleFn,
    }

    pub(super) struct Inner {
        process: Handle,
        job: Handle,
        pty: Mutex<Option<Pty>>,
        input: Mutex<Option<File>>,
        reader: Mutex<Option<JoinHandle<()>>>,
        /// Set by the first [`Inner::close`]; the handles are gone after it.
        closed: std::sync::atomic::AtomicBool,
        /// Read while a call uses `process` or `job`, written while
        /// [`Inner::close`] closes them: no call reaches a closed handle,
        /// whose number Windows may have given to something else by then.
        handles: std::sync::RwLock<()>,
        /// The exit code, once seen: it outlives the handles.
        exit: Mutex<Option<u32>>,
    }

    // SAFETY: `HPCON` is a plain value; the handles are only used through
    // thread-safe Win32 calls, and the rest sits behind mutexes.
    unsafe impl Send for Inner {}
    unsafe impl Sync for Inner {}

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    fn failed(reason: String) -> AppError {
        AppError::HostStartFailed { reason, exit_code: None }
    }

    /// The job every server lives in: killed with the last handle, no error
    /// dialog on a crash, not inheritable.
    fn create_job() -> Result<Handle> {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(failed(format!("CreateJobObjectW failed: {}", last_error())));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let error = last_error();
                CloseHandle(job);
                return Err(failed(format!("SetInformationJobObject failed: {error}")));
            }
            Ok(Handle(job))
        }
    }

    /// Reads the pseudo console to the end of its pipe.
    fn start_reader(read: File, output: Arc<ConsoleOutput>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("host-console".into())
            .spawn(move || {
                let mut read = read;
                let mut text = VtText::default();
                let mut buffer = vec![0u8; 16 * 1024];
                loop {
                    match read.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => text.feed(&buffer[..count], |line| output.push_line(line)),
                    }
                }
                text.finish(|line| output.push_line(line));
            })
            .expect("a thread for the server console")
    }

    pub(super) fn spawn(
        executable: &Path,
        working_dir: &Path,
        args: &[String],
        output: Arc<ConsoleOutput>,
    ) -> Result<ServerProcess> {
        let job = create_job()?;
        let line = command_line(executable, args);
        let attempt = match pseudo_console_api() {
            Some(api) => spawn_pty(&api, executable, working_dir, &line, &output),
            None => Err(failed("this Windows has no pseudo console".into())),
        };
        let (process, thread, pid, method, pty, input, reader) = match attempt {
            Ok(started) => started,
            Err(e) => {
                log::warn!("the server console cannot be captured ({e}); starting it without one");
                output.note("this server was started without a captured console; its output is not in this log");
                let (process, thread, pid) = create_process(executable, working_dir, &line, None)
                    .inspect_err(|_| unsafe {
                        CloseHandle(job.0);
                    })?;
                (process, thread, pid, ConsoleMethod::NoWindow, None, None, None)
            }
        };

        let inner = Inner {
            process,
            job,
            pty: Mutex::new(pty),
            input: Mutex::new(input),
            reader: Mutex::new(reader),
            closed: std::sync::atomic::AtomicBool::new(false),
            handles: std::sync::RwLock::new(()),
            exit: Mutex::new(None),
        };
        // Into the job before the first instruction runs, then resumed.
        unsafe {
            if AssignProcessToJobObject(job.0, process.0) == 0 {
                let error = last_error();
                TerminateProcess(process.0, 1);
                CloseHandle(thread.0);
                inner.close();
                return Err(failed(format!("AssignProcessToJobObject failed: {error}")));
            }
            ResumeThread(thread.0);
            CloseHandle(thread.0);
        }
        Ok(ServerProcess {
            pid,
            method,
            output,
            inner,
        })
    }

    /// The process, its main thread (still suspended), its id and the console.
    type Started = (
        Handle,
        Handle,
        u32,
        ConsoleMethod,
        Option<Pty>,
        Option<File>,
        Option<JoinHandle<()>>,
    );

    fn spawn_pty(
        api: &PseudoConsoleApi,
        executable: &Path,
        working_dir: &Path,
        line: &str,
        output: &Arc<ConsoleOutput>,
    ) -> Result<Started> {
        unsafe {
            let (mut in_read, mut in_write, mut out_read, mut out_write): (HANDLE, HANDLE, HANDLE, HANDLE) =
                (null_mut(), null_mut(), null_mut(), null_mut());
            if CreatePipe(&mut in_read, &mut in_write, null(), 0) == 0 {
                return Err(failed(format!("CreatePipe failed: {}", last_error())));
            }
            if CreatePipe(&mut out_read, &mut out_write, null(), 0) == 0 {
                let error = last_error();
                CloseHandle(in_read);
                CloseHandle(in_write);
                return Err(failed(format!("CreatePipe failed: {error}")));
            }
            let mut hpc: HPCON = 0;
            let hr = (api.create)(COORD { X: COLUMNS, Y: ROWS }, in_read, out_write, 0, &mut hpc);
            // The pseudo console holds its own duplicates of these two ends.
            CloseHandle(in_read);
            CloseHandle(out_write);
            if hr < 0 {
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(failed(format!("CreatePseudoConsole failed: {hr:#x}")));
            }
            let pty = Pty { hpc, close: api.close };
            // Read from the very start: an unread pipe stalls the server.
            let reader = start_reader(File::from_raw_handle(out_read as RawHandle), output.clone());
            let input = File::from_raw_handle(in_write as RawHandle);

            match create_process(executable, working_dir, line, Some(hpc)) {
                Ok((process, thread, pid)) => Ok((
                    process,
                    thread,
                    pid,
                    ConsoleMethod::PseudoConsole,
                    Some(pty),
                    Some(input),
                    Some(reader),
                )),
                Err(e) => {
                    (pty.close)(pty.hpc);
                    drop(input);
                    let _ = reader.join();
                    Err(e)
                }
            }
        }
    }

    /// `CreateProcessW`, suspended; with a pseudo console when `hpc` is
    /// given (method A), with a console of its own and no window otherwise
    /// (method D).
    fn create_process(
        executable: &Path,
        working_dir: &Path,
        line: &str,
        hpc: Option<HPCON>,
    ) -> Result<(Handle, Handle, u32)> {
        let exe = wide(&executable.display().to_string());
        let cwd = wide(&working_dir.display().to_string());
        let mut cmd = wide(line);
        unsafe {
            let mut info: PROCESS_INFORMATION = zeroed();
            let created = match hpc {
                Some(hpc) => {
                    let mut size = 0usize;
                    InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
                    let mut attributes = vec![0u8; size];
                    let list = attributes.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
                    if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
                        return Err(failed(format!(
                            "InitializeProcThreadAttributeList failed: {}",
                            last_error()
                        )));
                    }
                    if UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                        hpc as *const c_void,
                        size_of::<HPCON>(),
                        null_mut(),
                        null(),
                    ) == 0
                    {
                        let error = last_error();
                        DeleteProcThreadAttributeList(list);
                        return Err(failed(format!("UpdateProcThreadAttribute failed: {error}")));
                    }
                    let mut startup: STARTUPINFOEXW = zeroed();
                    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
                    // Without the three invalid handles the child takes the
                    // launcher's standard handles instead of the pseudo
                    // console, and OpenJK x86 crashes.
                    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
                    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
                    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
                    startup.lpAttributeList = list;
                    let ok = CreateProcessW(
                        exe.as_ptr(),
                        cmd.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
                        null(),
                        cwd.as_ptr(),
                        &startup.StartupInfo,
                        &mut info,
                    );
                    let error = last_error();
                    DeleteProcThreadAttributeList(list);
                    if ok == 0 { Err(error) } else { Ok(()) }
                }
                None => {
                    let mut startup: STARTUPINFOW = zeroed();
                    startup.cb = size_of::<STARTUPINFOW>() as u32;
                    let ok = CreateProcessW(
                        exe.as_ptr(),
                        cmd.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED,
                        null(),
                        cwd.as_ptr(),
                        &startup,
                        &mut info,
                    );
                    if ok == 0 { Err(last_error()) } else { Ok(()) }
                }
            };
            if let Err(error) = created {
                return Err(failed(format!(
                    "cannot start {}: Windows error {error}",
                    executable.display()
                )));
            }
            // The main thread stays suspended: the caller resumes it once the
            // process is in the job.
            Ok((Handle(info.hProcess), Handle(info.hThread), info.dwProcessId))
        }
    }

    impl Inner {
        pub(super) fn wait(&self, timeout: Duration) -> Option<u32> {
            if let Some(code) = *self.exit.lock().unwrap_or_else(|e| e.into_inner()) {
                return Some(code);
            }
            let _handles = self.handles.read().unwrap_or_else(|e| e.into_inner());
            if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                // Closed before an exit was seen: the job ended it.
                return Some(1);
            }
            let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            let code = unsafe {
                if WaitForSingleObject(self.process.0, millis) != WAIT_OBJECT_0 {
                    return None;
                }
                let mut code = 0u32;
                GetExitCodeProcess(self.process.0, &mut code);
                code
            };
            *self.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
            Some(code)
        }

        pub(super) fn type_line(&self, line: &str) -> bool {
            let mut input = self.input.lock().unwrap_or_else(|e| e.into_inner());
            match input.as_mut() {
                Some(file) => file.write_all(format!("{line}\r").as_bytes()).is_ok(),
                None => false,
            }
        }

        pub(super) fn terminate(&self) {
            let _handles = self.handles.read().unwrap_or_else(|e| e.into_inner());
            if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            unsafe {
                TerminateJobObject(self.job.0, 1);
            }
        }

        /// Ends the process if it still runs, closes the pseudo console,
        /// drains the reader and closes every handle.
        pub(super) fn close(&self) {
            // One close: the second would close handles that are gone.
            if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            if self.wait(Duration::ZERO).is_none() {
                self.terminate();
                let _ = self.wait(Duration::from_secs(5));
            }
            // Waits for the calls using a handle, and keeps new ones out.
            let _handles = self.handles.write().unwrap_or_else(|e| e.into_inner());
            if self.closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
                return;
            }
            if let Some(pty) = self.pty.lock().unwrap_or_else(|e| e.into_inner()).take() {
                unsafe { (pty.close)(pty.hpc) };
            }
            drop(self.input.lock().unwrap_or_else(|e| e.into_inner()).take());
            if let Some(reader) = self.reader.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = reader.join();
            }
            unsafe {
                CloseHandle(self.process.0);
                CloseHandle(self.job.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut text = VtText::default();
        let mut out = Vec::new();
        for chunk in chunks {
            text.feed(chunk, |line| out.push(line.to_string()));
        }
        text.finish(|line| out.push(line.to_string()));
        out
    }

    #[test]
    fn the_escape_sequences_of_a_pseudo_console_are_cut_out() {
        // What ConPTY sends around the first lines of OpenJK: private modes,
        // a window title, cursor jumps, erase to end of line and the redrawn
        // input line padded with blanks.
        let raw: &[u8] = b"\x1b[?9001h\x1b[?1004h\x1b]0;C:\\engine\\openjkded.x86.exe\x07\x1b[H\x1b[?25l\
Opening IP socket: 127.0.0.1:29070\x1b[K\r\n\
2026-09-25 19:57:26 ------- Game Initialization -------   \x1b[K\r\n\x1b[5;1H]                    \x1b[5;1H\
2026-09-25 19:57:31 quit\r";
        assert_eq!(
            lines(&[raw]),
            [
                "Opening IP socket: 127.0.0.1:29070",
                "2026-09-25 19:57:26 ------- Game Initialization -------",
                "]",
                "2026-09-25 19:57:31 quit",
            ]
        );
    }

    #[test]
    fn a_sequence_split_between_two_reads_is_still_cut() {
        assert_eq!(
            lines(&[b"one\x1b[", b"38;5;1mtwo\r", b"\nthree"]),
            ["onetwo", "three"]
        );
    }

    #[test]
    fn the_output_keeps_a_tail_and_sets_its_markers() {
        let temp = tempfile::tempdir().expect("a temp dir");
        let log = temp.path().join("logs").join("host-server.log");
        let output = ConsoleOutput::with_log(&log);
        for index in 0..(TAIL_LINES + 5) {
            output.push_line(&format!("line {index}"));
        }
        assert!(!output.saw(Marker::BindFailed));
        output.push_line("WARNING: Couldn't bind to a v4 ip address.");
        output.push_line("Can't find map maps/mp/nowhere.bsp");
        assert!(output.saw(Marker::BindFailed));
        assert!(output.saw(Marker::MapMissing));
        assert!(!output.saw(Marker::GameInitialization));

        let tail = output.tail(30);
        assert_eq!(tail.len(), 30);
        assert_eq!(tail.last().map(String::as_str), Some("Can't find map maps/mp/nowhere.bsp"));
        assert_eq!(output.tail(1000).len(), TAIL_LINES);
        let written = std::fs::read_to_string(&log).expect("the log");
        assert!(written.starts_with("line 0\n"), "the whole run is on disk");
    }

    #[test]
    fn arguments_are_quoted_the_way_the_crt_reads_them() {
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(
            quote_argument(r"D:\SteamLibrary\steamapps\common\Jedi Academy\GameData"),
            r#""D:\SteamLibrary\steamapps\common\Jedi Academy\GameData""#
        );
        // A trailing backslash inside quotes is doubled, a quote is escaped.
        assert_eq!(quote_argument(r"C:\with space\"), r#""C:\with space\\""#);
        assert_eq!(quote_argument(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(
            command_line(Path::new(r"C:\a b\openjkded.x86.exe"), &["+set".into(), "net_port".into(), "29070".into()]),
            r#""C:\a b\openjkded.x86.exe" +set net_port 29070"#
        );
    }
}
