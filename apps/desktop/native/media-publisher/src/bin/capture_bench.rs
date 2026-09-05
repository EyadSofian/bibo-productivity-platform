#[cfg(windows)]
#[path = "windows_capture_bench.rs"]
mod platform;

#[cfg(windows)]
fn main() {
    platform::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This executable requires Windows; portable library tests can run here.");
    std::process::exit(1);
}
