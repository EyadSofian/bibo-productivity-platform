// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    if std::env::args().any(|arg| arg == "--supervisor-service") {
        if let Err(error) = ctracking_lib::supervisor::run() {
            ctracking_lib::supervisor::log_error(&format!(
                "service dispatcher stopped with an error: {error}"
            ));
        }
        return;
    }

    ctracking_lib::run()
}
