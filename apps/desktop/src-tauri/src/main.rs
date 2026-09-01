// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    {
        let arguments = std::env::args().collect::<Vec<_>>();
        if arguments.iter().any(|arg| arg == "--supervisor-service") {
            if let Err(error) = ctracking_lib::supervisor::run() {
                ctracking_lib::supervisor::log_error(&format!(
                    "service dispatcher stopped with an error: {error}"
                ));
            }
            return;
        }

        let administrative_action = if arguments
            .iter()
            .any(|arg| arg == "--install-supervisor-service")
        {
            Some(("install", ctracking_lib::supervisor::install()))
        } else if arguments
            .iter()
            .any(|arg| arg == "--stop-supervisor-service")
        {
            Some(("stop", ctracking_lib::supervisor::stop()))
        } else if arguments
            .iter()
            .any(|arg| arg == "--uninstall-supervisor-service")
        {
            Some(("uninstall", ctracking_lib::supervisor::uninstall()))
        } else {
            None
        };

        if let Some((action, result)) = administrative_action {
            if let Err(error) = result {
                ctracking_lib::supervisor::log_error(&format!(
                    "could not {action} supervisor service: {error}"
                ));
                std::process::exit(1);
            }
            return;
        }
    }

    ctracking_lib::run()
}
