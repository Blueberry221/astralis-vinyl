#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::command;
use tauri::Manager;

/// =========================================================
/// 1. AUDIO SEARCH MODULE
/// Utilizes yt-dlp ytsearch command to pull JSON metadata
/// =========================================================
#[command]
fn search_song(query: &str) -> Result<String, String> {
    let mut exe_path = env::current_exe().map_err(|e| e.to_string())?;
    exe_path.pop(); exe_path.pop(); exe_path.pop(); 
    exe_path.push("yt-dlp.exe");

    let output = Command::new(exe_path)
        .args(&[&format!("ytsearch5:{}", query), "--dump-json", "--no-playlist", "--ignore-errors"])
        .output()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// =========================================================
/// 2. CACHE AUDIO DOWNLOAD MODULE
/// Saves temporary files (Search Result & Recent Playing) 
/// to the "cache" folder so they can be overwritten
/// =========================================================
#[command]
fn download_audio(video_id: &str) -> Result<String, String> {
    let mut exe_path = env::current_exe().map_err(|e| e.to_string())?;
    exe_path.pop(); exe_path.pop(); exe_path.pop(); 
    exe_path.push("yt-dlp.exe");

    let current_dir = env::current_dir().unwrap();
    let cache_dir = current_dir.join("cache");
    let _ = fs::create_dir_all(&cache_dir);

    let file_path = cache_dir.join(format!("{}.m4a", video_id));
    let target_url = format!("https://www.youtube.com/watch?v={}", video_id);

    let output = Command::new(exe_path)
        .args(&["-f", "ba/b", "-o", file_path.to_str().unwrap(), "--extract-audio", "--audio-format", "m4a", "--extractor-args", "youtube:player_client=android,web", &target_url])
        .output();

    match output {
        Ok(out) => if out.status.success() { Ok(file_path.to_string_lossy().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) },
        Err(e) => Err(format!("Fatal Error: {}", e)),
    }
}

/// =========================================================
/// 3. PERMANENT LIBRARY DOWNLOAD MODULE
/// Saves files permanently to the "library" folder.
/// Will bypass download if the file already exists.
/// =========================================================
#[command]
fn save_to_library(video_id: &str) -> Result<String, String> {
    let mut exe_path = env::current_exe().map_err(|e| e.to_string())?;
    exe_path.pop(); exe_path.pop(); exe_path.pop(); 
    exe_path.push("yt-dlp.exe");

    let current_dir = env::current_dir().unwrap();
    let lib_dir = current_dir.join("library"); 
    let _ = fs::create_dir_all(&lib_dir);

    let file_path = lib_dir.join(format!("{}.m4a", video_id));
    let target_url = format!("https://www.youtube.com/watch?v={}", video_id);

    if file_path.exists() {
        return Ok(file_path.to_string_lossy().to_string());
    }

    let output = Command::new(exe_path)
        .args(&["-f", "ba/b", "-o", file_path.to_str().unwrap(), "--extract-audio", "--audio-format", "m4a", "--extractor-args", "youtube:player_client=android,web", &target_url])
        .output();

    match output {
        Ok(out) => if out.status.success() { Ok(file_path.to_string_lossy().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) },
        Err(e) => Err(e.to_string()),
    }
}

use std::{env, fs};

/// =========================================================
/// 4. DATABASE MANAGER MODULE
/// =========================================================

#[command]
fn load_db() -> String {

    let runtime_dir =
        env::current_dir()
            .unwrap()
            .join("runtime");

    let _ = fs::create_dir_all(&runtime_dir);

    let db_path =
        runtime_dir.join("database.json");

    if db_path.exists() {

        fs::read_to_string(db_path)
            .unwrap_or_else(|_| "[]".to_string())

    } else {

        let default_db =
r#"[{"id":"downloaded","name":"Downloaded","desc":"Permanently downloaded songs","songs":[]}]"#;

        let _ = fs::write(&db_path, default_db);

        default_db.to_string()
    }
}

#[command]
fn save_db(data: &str) -> Result<(), String> {

    let runtime_dir =
        env::current_dir()
            .unwrap()
            .join("runtime");

    let _ = fs::create_dir_all(&runtime_dir);

    let db_path =
        runtime_dir.join("database.json");

    fs::write(db_path, data)
        .map_err(|e| e.to_string())
}

/// =========================================================
/// 5. MAIN ENTRY POINT
/// =========================================================
fn main() {

    tauri::Builder::default()

        .setup(|app| {

            let window =
                app.get_webview_window("main").unwrap();

            let _ = window.maximize();

            Ok(())
        })

        .invoke_handler(
            tauri::generate_handler![
                search_song,
                download_audio,
                save_to_library,
                load_db,
                save_db
            ]
        )

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}