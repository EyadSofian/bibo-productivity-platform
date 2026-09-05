//! Named-pipe server for the media sidecar (ticket 148).
//!
//! The **agent** creates the pipe and owns its security descriptor; the sidecar
//! connects as a client. Doing it this way means the sidecar never has to claim a
//! name in the pipe namespace, and a stale sidecar cannot squat the name a future
//! agent expects.
//!
//! Two protections, because `\\.\pipe\` is enumerable by any local process:
//!
//! 1. An explicit DACL granting access only to the pipe's owner (this user) and
//!    SYSTEM. Another logged-in user cannot open it.
//! 2. `PIPE_REJECT_REMOTE_CLIENTS`, so it is not reachable over SMB.

use std::os::windows::io::FromRawHandle;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, HANDLE, HLOCAL,
    INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

/// Protected DACL: full access for the object owner (the user running the agent)
/// and for SYSTEM, and nobody else. "P" blocks inherited ACEs from widening it.
const PIPE_SDDL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

/// Pipe buffer size. Messages are small JSON lines; this only needs to absorb a
/// burst without blocking the writer.
const BUF_SIZE: u32 = 64 * 1024;

/// A pipe server waiting for (or connected to) the sidecar.
pub struct PipeServer {
    handle: HANDLE,
    connected: bool,
}

// The handle is owned solely by this struct and only used from the supervisor
// thread; sending it between threads is safe.
unsafe impl Send for PipeServer {}

impl PipeServer {
    /// Creates the pipe. Fails if the name already exists, because
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE` refuses to share a name with another server -
    /// which is exactly the squatting protection we want.
    pub fn create(name: &str) -> Result<Self, String> {
        unsafe {
            let mut psd = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(PIPE_SDDL),
                SDDL_REVISION_1,
                &mut psd,
                None,
            )
            .map_err(|e| format!("build pipe security descriptor: {e}"))?;

            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: psd.0,
                bInheritHandle: false.into(),
            };

            let handle = CreateNamedPipeW(
                &HSTRING::from(name),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, // exactly one sidecar per session
                BUF_SIZE,
                BUF_SIZE,
                0,
                Some(&sa),
            );

            // The descriptor was copied into the pipe; release our copy either way.
            if !psd.0.is_null() {
                let _ = LocalFree(HLOCAL(psd.0));
            }

            if handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "CreateNamedPipeW failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self {
                handle,
                connected: false,
            })
        }
    }

    /// Bounded handshake. Only the connection uses NOWAIT; all subsequent I/O
    /// uses ordinary blocking File handles after switching back to PIPE_WAIT.
    pub fn wait_for_client(&mut self) -> Result<(), String> {
        self.wait_for_client_while(Duration::from_secs(5), || true)
    }

    pub fn wait_for_client_while(
        &mut self,
        timeout: Duration,
        mut allowed: impl FnMut() -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !allowed() {
                return Err("sidecar connection cancelled".into());
            }
            unsafe {
                match ConnectNamedPipe(self.handle, None) {
                    // In NOWAIT mode an initial success only starts listening.
                    Ok(()) => {}
                    Err(e) if e.code() == ERROR_PIPE_LISTENING.to_hresult() => {}
                    Err(e) if e.code() == ERROR_PIPE_CONNECTED.to_hresult() => {
                        SetNamedPipeHandleState(self.handle, Some(&PIPE_WAIT), None, None)
                            .map_err(|e| format!("set pipe wait mode: {e}"))?;
                        self.connected = true;
                        return Ok(());
                    }
                    Err(e) => return Err(format!("ConnectNamedPipe failed: {e}")),
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("sidecar connection timed out".into())
    }

    /// Duplicates the pipe into an owned `File` for reading, and another for
    /// writing, so the supervisor can read events on one thread while writing
    /// commands from another.
    pub fn split(&self) -> Result<(std::fs::File, std::fs::File), String> {
        use windows::Win32::Foundation::DUPLICATE_SAME_ACCESS;
        use windows::Win32::System::Threading::GetCurrentProcess;

        unsafe {
            let mut read_h = HANDLE::default();
            let mut write_h = HANDLE::default();
            let proc = GetCurrentProcess();

            windows::Win32::Foundation::DuplicateHandle(
                proc,
                self.handle,
                proc,
                &mut read_h,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
            .map_err(|e| format!("duplicate pipe handle (read): {e}"))?;

            let reader = std::fs::File::from_raw_handle(read_h.0 as *mut _);

            windows::Win32::Foundation::DuplicateHandle(
                proc,
                self.handle,
                proc,
                &mut write_h,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
            .map_err(|e| format!("duplicate pipe handle (write): {e}"))?;

            Ok((reader, std::fs::File::from_raw_handle(write_h.0 as *mut _)))
        }
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        unsafe {
            if self.handle != INVALID_HANDLE_VALUE {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Pipe name for a session. Session-scoped so two concurrent agents never collide.
pub fn pipe_name(session_id: &str) -> String {
    format!(r"\\.\pipe\bibotracking-media-{session_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_is_session_scoped_and_local() {
        let a = pipe_name("s-a");
        let b = pipe_name("s-b");
        assert_ne!(a, b);
        assert!(a.starts_with(r"\\.\pipe\"), "got {a}");
    }

    /// The pipe must actually be creatable with our DACL, and a second server on the
    /// same name must be refused (that refusal is the anti-squatting protection).
    #[test]
    fn create_succeeds_and_rejects_a_second_instance() {
        let name = pipe_name(&format!("test-{}", std::process::id()));
        let first = PipeServer::create(&name).expect("first pipe server should be created");
        let second = PipeServer::create(&name);
        assert!(
            second.is_err(),
            "a second server on the same name must be refused"
        );
        drop(first);
    }

    #[test]
    fn absent_sidecar_does_not_block_forever() {
        let mut server =
            PipeServer::create(&pipe_name(&format!("timeout-{}", std::process::id()))).unwrap();
        let start = Instant::now();
        assert!(server
            .wait_for_client_while(Duration::from_millis(60), || true)
            .is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn local_stop_cancels_the_handshake() {
        let mut server =
            PipeServer::create(&pipe_name(&format!("cancel-{}", std::process::id()))).unwrap();
        assert!(server
            .wait_for_client_while(Duration::from_secs(5), || false)
            .unwrap_err()
            .contains("cancelled"));
    }
}
