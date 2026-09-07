//! Read-only checks of this process's interactive Windows session.
//! Fail closed for lock, disconnect, secure desktop or an unavailable OS query.
use windows::core::PWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSConnectState, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx,
    WTSINFOEXW, WTS_CONNECTSTATE_CLASS, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    WTS_SESSIONSTATE_UNLOCK,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};

fn session_allowed(state: WTS_CONNECTSTATE_CLASS) -> bool {
    state == WTSActive
}

fn session_flags_allowed(flags: i32) -> bool {
    flags == WTS_SESSIONSTATE_UNLOCK as i32
}

/// `WTSActive` only means that the user owns the console session; it remains
/// active while the workstation is locked. `WTSSessionInfoEx.SessionFlags` is
/// the Windows signal that distinguishes the unlocked desktop from the lock
/// screen. Fail closed if the extended query is unavailable or malformed.
unsafe fn session_unlocked() -> bool {
    let mut buffer = PWSTR::null();
    let mut bytes = 0;
    let queried = WTSQuerySessionInformationW(
        WTS_CURRENT_SERVER_HANDLE,
        WTS_CURRENT_SESSION,
        WTSSessionInfoEx,
        &mut buffer,
        &mut bytes,
    )
    .is_ok();
    let unlocked =
        if queried && !buffer.is_null() && bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*buffer.0.cast::<WTSINFOEXW>();
            info.Level == 1
                && session_allowed(info.Data.WTSInfoExLevel1.SessionState)
                && session_flags_allowed(info.Data.WTSInfoExLevel1.SessionFlags)
        } else {
            false
        };
    if !buffer.is_null() {
        WTSFreeMemory(buffer.0.cast());
    }
    unlocked
}

pub fn capture_allowed() -> bool {
    unsafe {
        let mut buffer = PWSTR::null();
        let mut bytes = 0;
        let queried = WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        )
        .is_ok();
        let active = queried
            && !buffer.is_null()
            && bytes as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>()
            && session_allowed(*buffer.0.cast::<WTS_CONNECTSTATE_CLASS>());
        if !buffer.is_null() {
            WTSFreeMemory(buffer.0.cast());
        }
        if !active {
            return false;
        }
        if !session_unlocked() {
            return false;
        }

        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 256];
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            None,
        )
        .is_ok();
        let _ = CloseDesktop(desktop);
        if !read {
            return false;
        }
        let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16(&name[..length]).is_ok_and(|name| name.eq_ignore_ascii_case("Default"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::RemoteDesktop::WTSDisconnected;

    #[test]
    fn only_an_active_interactive_session_allows_capture() {
        assert!(session_allowed(WTSActive));
        assert!(!session_allowed(WTSDisconnected));
    }

    #[test]
    fn only_the_unlocked_session_flag_allows_capture() {
        assert!(session_flags_allowed(WTS_SESSIONSTATE_UNLOCK as i32));
        assert!(!session_flags_allowed(0));
        assert!(!session_flags_allowed(-1));
    }
}
