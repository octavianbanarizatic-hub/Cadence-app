//! Gives the window proper icons on Windows.
//!
//! Tauri only sets the window's small icon. Windows uses the big one for
//! Alt+Tab and the taskbar, and otherwise stretches whatever it can find, so
//! load both sizes from the icon embedded in the exe at the window's DPI.

#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON,
        SM_CXSMICON, WM_SETICON,
    };

    /// The resource id tauri-build gives the app icon.
    const APP_ICON_ID: usize = 32512;

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as _;
    // SAFETY: plain Win32 calls on our own window and module. LoadImageW
    // returns null on failure, which is checked before use.
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let dpi = GetDpiForWindow(hwnd);
        for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
            let size = GetSystemMetricsForDpi(metric, dpi);
            let icon = LoadImageW(module, APP_ICON_ID as _, IMAGE_ICON, size, size, LR_DEFAULTCOLOR);
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn apply(_window: &tauri::WebviewWindow) {}
