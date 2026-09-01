//! Windows service that keeps the visible, company-managed tray agent running.
//!
//! This is deliberately not a hidden monitoring process: it launches the same
//! signed BiBoTracking UI in the interactive user's session. The per-machine
//! installer and Windows service ACLs reserve service stop/uninstall operations
//! for device administrators.

use std::{
    collections::VecDeque,
    ffi::{c_void, OsString},
    fs::OpenOptions,
    io::Write,
    mem::{size_of, zeroed},
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, BOOL, HANDLE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
            RemoteDesktop::{
                ProcessIdToSessionId, WTSGetActiveConsoleSessionId, WTSQueryUserToken,
            },
            Threading::{
                CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
            },
        },
    },
};
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

pub const SERVICE_NAME: &str = "BiBoTrackingSupervisor";
const AGENT_EXE_NAME: &str = "BiBoTracking.exe";
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const RESTART_WINDOW_SECS: u64 = 10 * 60;
const MAX_RESTARTS_PER_WINDOW: usize = 5;

define_windows_service!(ffi_service_main, service_main);

/// Called by the binary before Tauri starts when Windows Service Control
/// Manager launches it with the supervisor-service argument.
pub fn run() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run_worker() {
        log_error(&format!("supervisor worker stopped with an error: {error}"));
    }
}

fn run_worker() -> windows_service::Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel();
    let event_handler = move |event| match event {
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = shutdown_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        _ => ServiceControlHandlerResult::NotImplemented,
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    log_info("supervisor service started");
    let mut restart_budget = RestartBudget::default();
    loop {
        supervise_once(&mut restart_budget);
        match shutdown_rx.recv_timeout(CHECK_INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    log_info("supervisor service stopped");

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;
    Ok(())
}

fn supervise_once(restart_budget: &mut RestartBudget) {
    let session_id = unsafe { WTSGetActiveConsoleSessionId() };
    if session_id == u32::MAX || agent_running_in_session(session_id) {
        return;
    }

    let now = unix_seconds();
    if !restart_budget.allow(now) {
        return;
    }

    // Count attempts, not just successful launches. A broken install or missing
    // user token must not produce an endless five-second restart/log loop.
    restart_budget.record(now);
    match launch_agent_in_session(session_id) {
        Ok(()) => {
            log_info(&format!(
                "started visible agent in Windows session {session_id}"
            ));
        }
        Err(error) => log_error(&format!(
            "could not start visible agent in Windows session {session_id}: {error}"
        )),
    }
}

fn agent_running_in_session(session_id: u32) -> bool {
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => handle,
        Err(error) => {
            log_error(&format!("process snapshot failed: {error}"));
            return false;
        }
    };

    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = false;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while next {
        let name_len = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
        if name.eq_ignore_ascii_case(AGENT_EXE_NAME) {
            let mut process_session = u32::MAX;
            if unsafe { ProcessIdToSessionId(entry.th32ProcessID, &mut process_session) }.is_ok()
                && process_session == session_id
            {
                found = true;
                break;
            }
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }

    let _ = unsafe { CloseHandle(snapshot) };
    found
}

fn launch_agent_in_session(session_id: u32) -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve service executable: {error}"))?;
    let executable_wide = wide_null(executable.as_os_str());
    let mut command_wide = wide_null(format!("\"{}\" --background", executable.display()));
    let working_directory = executable
        .parent()
        .map(Path::as_os_str)
        .map(wide_null)
        .unwrap_or_else(|| vec![0]);

    let mut user_token = HANDLE::default();
    unsafe { WTSQueryUserToken(session_id, &mut user_token) }
        .map_err(|error| format!("query interactive user token: {error}"))?;

    let mut environment: *mut c_void = std::ptr::null_mut();
    if let Err(error) = unsafe { CreateEnvironmentBlock(&mut environment, user_token, false) } {
        let _ = unsafe { CloseHandle(user_token) };
        return Err(format!("create user environment: {error}"));
    }

    let desktop = wide_null("winsta0\\default");
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop = PWSTR(desktop.as_ptr().cast_mut());
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };

    let result = unsafe {
        CreateProcessAsUserW(
            user_token,
            PCWSTR(executable_wide.as_ptr()),
            PWSTR(command_wide.as_mut_ptr()),
            None,
            None,
            BOOL(0),
            CREATE_UNICODE_ENVIRONMENT,
            Some(environment.cast_const()),
            PCWSTR(working_directory.as_ptr()),
            &startup,
            &mut process,
        )
    };

    if !process.hThread.is_invalid() {
        let _ = unsafe { CloseHandle(process.hThread) };
    }
    if !process.hProcess.is_invalid() {
        let _ = unsafe { CloseHandle(process.hProcess) };
    }
    let _ = unsafe { DestroyEnvironmentBlock(environment) };
    let _ = unsafe { CloseHandle(user_token) };

    result.map_err(|error| format!("create interactive agent process: {error}"))
}

fn wide_null(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

#[derive(Default)]
struct RestartBudget {
    launches: VecDeque<u64>,
}

impl RestartBudget {
    fn remove_expired(&mut self, now: u64) {
        while self
            .launches
            .front()
            .is_some_and(|started| now.saturating_sub(*started) >= RESTART_WINDOW_SECS)
        {
            self.launches.pop_front();
        }
    }

    fn allow(&mut self, now: u64) -> bool {
        self.remove_expired(now);
        self.launches.len() < MAX_RESTARTS_PER_WINDOW
    }

    fn record(&mut self, now: u64) {
        self.remove_expired(now);
        self.launches.push_back(now);
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn log_path() -> Option<std::path::PathBuf> {
    std::env::var_os("PROGRAMDATA").map(|root| {
        let directory = std::path::PathBuf::from(root).join("BiBoTracking");
        let _ = std::fs::create_dir_all(&directory);
        directory.join("supervisor.log")
    })
}

fn log_info(message: &str) {
    write_log("INFO", message);
}

pub fn log_error(message: &str) {
    write_log("ERROR", message);
}

fn write_log(level: &str, message: &str) {
    let Some(path) = log_path() else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {level} {message}", unix_seconds());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_budget_limits_crash_loops() {
        let mut budget = RestartBudget::default();
        for second in 0..MAX_RESTARTS_PER_WINDOW as u64 {
            assert!(budget.allow(second));
            budget.record(second);
        }
        assert!(!budget.allow(100));
    }

    #[test]
    fn restart_budget_recovers_after_window() {
        let mut budget = RestartBudget::default();
        for second in 0..MAX_RESTARTS_PER_WINDOW as u64 {
            budget.record(second);
        }
        assert!(budget.allow(RESTART_WINDOW_SECS));
    }
}
