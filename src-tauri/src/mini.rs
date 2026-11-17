//! The mini player: a small always-on-top window that stands in for the main
//! one. Audio keeps playing in the (hidden) main window; the two pages talk
//! through events (`mini-state` to the mini window, `mini-command` back).

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub const LABEL: &str = "mini";
const WIDTH: f64 = 460.0;
const HEIGHT: f64 = 96.0;
/// Gap between the window and the screen edge in its default spot.
const MARGIN: f64 = 24.0;

/// Hides the main window and shows the mini player.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("mini.html".into()))
                .title("Cadence mini player")
                .inner_size(WIDTH, HEIGHT)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .always_on_top(true)
                .visible(false)
                .build()?;
            crate::winicon::apply(&window);
            place_default(app, &window)?;
            // Back where the user last dragged it, if that screen is still there.
            window.restore_state(StateFlags::POSITION)?;
            window.set_size(LogicalSize::new(WIDTH, HEIGHT))?;
            window
        }
    };
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    if let Some(main) = app.get_webview_window("main") {
        main.hide()?;
    }
    Ok(())
}

/// Closes the mini player and brings the main window back.
pub fn close(app: &AppHandle) -> tauri::Result<()> {
    show_main(app)?;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.close()?;
    }
    Ok(())
}

pub fn show_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window("main") {
        main.show()?;
        main.unminimize()?;
        main.set_focus()?;
        let _ = main.emit("mini-closed", ());
    }
    Ok(())
}

/// Bottom-right corner of the screen the main window is on.
fn place_default(app: &AppHandle, window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let monitor = match app.get_webview_window("main") {
        Some(main) => main.current_monitor()?,
        None => window.primary_monitor()?,
    };
    let Some(monitor) = monitor else { return Ok(()) };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = window.outer_size()?;
    let margin = (MARGIN * scale) as i32;
    window.set_position(PhysicalPosition::new(
        area.position.x + area.size.width as i32 - size.width as i32 - margin,
        area.position.y + area.size.height as i32 - size.height as i32 - margin,
    ))
}
