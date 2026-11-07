// The app icon can be switched in Settings (Mac only). "ink" is the icon the app is built with;
// any other choice is drawn from the PNGs in src-tauri/icons/choices/.
#[cfg(target_os = "macos")]
const ICON_I: &[u8] = include_bytes!("../icons/choices/i.png");

/// Shows the chosen icon in the Dock now, and on the app in Finder (so it stays after quitting).
#[cfg(target_os = "macos")]
fn apply_icon(name: &str) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{NSBundle, NSData};
    let Some(mtm) = MainThreadMarker::new() else { return };
    let png: Option<&[u8]> = match name {
        "i" => Some(ICON_I),
        _ => None, // None = back to the built-in icon
    };
    let image = png.and_then(|b| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(b)));
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(image.as_deref()) };
    // Only touch the real app bundle, never the dev build's plain binary.
    let path = NSBundle::mainBundle().bundlePath();
    if path.to_string().ends_with(".app") {
        NSWorkspace::sharedWorkspace().setIcon_forFile_options(image.as_deref(), &path, NSWorkspaceIconCreationOptions(0));
    }
}

#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, name: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || apply_icon(&name));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, name);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![set_app_icon])
        .run(tauri::generate_context!())
        .expect("error while running Inkwell");
}
