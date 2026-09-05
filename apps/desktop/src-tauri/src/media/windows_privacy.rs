//! Read-only checks of this process's interactive Windows session.
//! Fail closed for lock, disconnect, secure desktop or an unavailable OS query.
use windows::core::PWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_UNLOCK,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};

fn session_allowed(info: &WTSINFOEXW) -> bool {
    if info.Level != 1 {
        return false;
    }
    // Level was checked before reading the tagged Windows union.
    let session = unsafe { info.Data.WTSInfoExLevel1 };
    session.SessionState == WTSActive && session.SessionFlags == WTS_SESSIONSTATE_UNLOCK as i32
}

pub fn capture_allowed() -> bool {
    unsafe {
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
        let active = queried
            && !buffer.is_null()
            && bytes as usize >= std::mem::size_of::<WTSINFOEXW>()
            && session_allowed(&*buffer.0.cast::<WTSINFOEXW>());
        if !buffer.is_null() {
            WTSFreeMemory(buffer.0.cast());
        }
        if !active {
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
    use windows::Win32::System::RemoteDesktop::{
        WTSDisconnected, WTSINFOEX_LEVEL1_W, WTSINFOEX_LEVEL_W,
    };
    #[test]
    fn only_connected_unlocked_sessions_allow_capture() {
        let mut info = WTSINFOEXW {
            Level: 1,
            Data: WTSINFOEX_LEVEL_W {
                WTSInfoExLevel1: WTSINFOEX_LEVEL1_W {
                    SessionState: WTSActive,
                    SessionFlags: WTS_SESSIONSTATE_UNLOCK as i32,
                    ..Default::default()
                },
            },
        };
        assert!(session_allowed(&info));
        info.Data.WTSInfoExLevel1.SessionFlags = 0;
        assert!(!session_allowed(&info));
        info.Data.WTSInfoExLevel1.SessionFlags = WTS_SESSIONSTATE_UNLOCK as i32;
        info.Data.WTSInfoExLevel1.SessionState = WTSDisconnected;
        assert!(!session_allowed(&info));
        info.Level = 0;
        assert!(!session_allowed(&info));
    }
}
