use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Keeps a console window from flashing up on Windows for every ffmpeg call.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn new_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Locations worth checking before giving up on finding ffmpeg.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("ffmpeg")];

    if let Some(home) = dirs::home_dir() {
        out.push(home.join("cmd/yt-dlp/ffmpeg.exe"));
        out.push(home.join("scoop/shims/ffmpeg.exe"));
        out.push(home.join("AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe"));
    }
    out.push(PathBuf::from("C:/ffmpeg/bin/ffmpeg.exe"));
    out.push(PathBuf::from("C:/Program Files/ffmpeg/bin/ffmpeg.exe"));
    out.push(PathBuf::from("/usr/bin/ffmpeg"));
    out.push(PathBuf::from("/usr/local/bin/ffmpeg"));
    out.push(PathBuf::from("/opt/homebrew/bin/ffmpeg"));
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
    /// libass is what renders the karaoke sweep; without it there is no export.
    pub has_libass: bool,
    /// NVIDIA hardware encoding, which makes 4K renders roughly realtime.
    pub has_nvenc: bool,
}

async fn probe(path: &Path) -> Option<FfmpegInfo> {
    let output = new_command(path)
        .arg("-hide_banner")
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let version = text.lines().next().unwrap_or("").trim().to_string();
    let has_libass = text.contains("--enable-libass");

    let encoders = new_command(path)
        .args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    Some(FfmpegInfo {
        found: true,
        path: path.to_string_lossy().to_string(),
        version,
        has_libass,
        has_nvenc: encoders.contains("h264_nvenc"),
    })
}

/// Locate a usable ffmpeg, preferring an explicit override from settings.
#[tauri::command]
pub async fn check_ffmpeg(override_path: Option<String>) -> Result<FfmpegInfo, String> {
    if let Some(p) = override_path.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(p);
        if let Some(info) = probe(&path).await {
            return Ok(info);
        }
        return Ok(FfmpegInfo {
            found: false,
            path: path.to_string_lossy().to_string(),
            version: String::new(),
            has_libass: false,
            has_nvenc: false,
        });
    }

    for candidate in candidate_paths() {
        if let Some(info) = probe(&candidate).await {
            return Ok(info);
        }
    }

    Ok(FfmpegInfo {
        found: false,
        path: String::new(),
        version: String::new(),
        has_libass: false,
        has_nvenc: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    /// ASS script carrying the karaoke timing, written by the frontend.
    pub ass_path: String,
    /// Flattened background still, rendered from the same canvas as the preview.
    pub background_image: Option<String>,
    /// Used instead of the still when the background is a moving clip.
    pub background_video: Option<String>,
    pub audio_path: Option<String>,
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration: f64,
    /// Extra directory for libass to search for fonts.
    pub fonts_dir: Option<String>,
    /// "libx264" or "h264_nvenc".
    pub encoder: Option<String>,
    /// 0-51 for x264; lower is better quality.
    pub crf: Option<u32>,
    pub ffmpeg_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub frame: u64,
    pub total_frames: u64,
    pub fps: f64,
    pub seconds_done: f64,
    pub speed: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub output_path: String,
    pub duration_seconds: f64,
}

/// Escape a path for use inside an ffmpeg filter argument.
///
/// Filter arguments are colon-delimited, so a Windows drive letter would split
/// the option. Backslashes are normalised first because the escape character is
/// itself a backslash.
fn escape_filter_path(path: &str) -> String {
    path.replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace(',', "\\,")
}

#[tauri::command]
pub async fn render_lyric_video(
    app: AppHandle,
    request: RenderRequest,
) -> Result<RenderResult, String> {
    let info = check_ffmpeg(request.ffmpeg_path.clone()).await?;
    if !info.found {
        return Err(
            "ffmpeg was not found. Set its location in the render settings, or install it and \
             make sure it is on your PATH."
                .to_string(),
        );
    }
    if !info.has_libass {
        return Err(format!(
            "The ffmpeg at {} was built without libass, so it cannot draw the karaoke text. \
             Install a full build (for example gyan.dev or BtbN) and point VibeSub at it.",
            info.path
        ));
    }

    let ffmpeg = PathBuf::from(&info.path);
    let ass_path = PathBuf::from(&request.ass_path);
    let work_dir = ass_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Subtitle script has no parent directory".to_string())?;
    let ass_name = ass_path
        .file_name()
        .ok_or_else(|| "Subtitle script has no file name".to_string())?
        .to_string_lossy()
        .to_string();

    if request.duration <= 0.0 {
        return Err("Render duration must be greater than zero".to_string());
    }

    let mut cmd = new_command(&ffmpeg);
    // Running from the script's directory lets the filter reference it by bare
    // name, sidestepping the drive-letter colon entirely.
    cmd.current_dir(&work_dir);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);

    // Video source: a looped still, a clip, or a generated colour field.
    // Arguments are pushed one at a time so a String never has to unify with a
    // &str inside an array literal.
    if let Some(video) = request.background_video.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("-stream_loop").arg("-1");
        cmd.arg("-i").arg(video);
    } else if let Some(image) = request.background_image.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("-loop").arg("1");
        cmd.arg("-framerate").arg(request.fps.to_string());
        cmd.arg("-i").arg(image);
    } else {
        cmd.arg("-f").arg("lavfi");
        cmd.arg("-i").arg(format!(
            "color=c=black:s={}x{}:r={}",
            request.width, request.height, request.fps
        ));
    }

    // When the backdrop video is also the sound source, reuse input 0 rather
    // than opening the same file a second time.
    let audio = request.audio_path.as_deref().filter(|s| !s.is_empty());
    let background_video = request.background_video.as_deref().filter(|s| !s.is_empty());
    let audio_is_background = matches!((audio, background_video), (Some(a), Some(v)) if a == v);

    if let Some(path) = audio {
        if !audio_is_background {
            cmd.arg("-i").arg(path);
        }
    }
    let has_audio = audio.is_some();
    let audio_map = if audio_is_background { "0:a?" } else { "1:a" };

    let mut ass_filter = format!("ass=filename={}", escape_filter_path(&ass_name));
    if let Some(dir) = request.fonts_dir.as_ref().filter(|s| !s.is_empty()) {
        ass_filter.push_str(&format!(":fontsdir={}", escape_filter_path(dir)));
    }

    let filter = format!(
        "[0:v]scale={w}:{h}:force_original_aspect_ratio=disable,fps={fps},format=rgb24,setsar=1[bg];[bg]{ass}[v]",
        w = request.width,
        h = request.height,
        fps = request.fps,
        ass = ass_filter
    );

    cmd.arg("-filter_complex").arg(filter);
    cmd.args(["-map", "[v]"]);
    if has_audio {
        cmd.arg("-map").arg(audio_map);
    }

    let encoder = request.encoder.as_deref().unwrap_or("libx264");
    let use_nvenc = encoder == "h264_nvenc" && info.has_nvenc;
    if use_nvenc {
        cmd.args(["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq"]);
        cmd.arg(request.crf.unwrap_or(19).to_string());
    } else {
        cmd.args(["-c:v", "libx264", "-preset", "medium", "-crf"]);
        cmd.arg(request.crf.unwrap_or(18).to_string());
    }
    cmd.args(["-pix_fmt", "yuv420p"]);

    if has_audio {
        cmd.args(["-c:a", "aac", "-b:a", "320k"]);
    }

    cmd.arg("-t").arg(format!("{:.3}", request.duration));
    cmd.args(["-movflags", "+faststart"]);
    cmd.args(["-progress", "pipe:1", "-nostats"]);
    cmd.arg(&request.output_path);

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;

    let total_frames = (request.duration * request.fps as f64).round() as u64;

    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut frame: u64 = 0;
            let mut fps_now: f64 = 0.0;
            let mut speed = String::new();
            let mut out_time: f64 = 0.0;

            while let Ok(Some(line)) = lines.next_line().await {
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                match key.trim() {
                    "frame" => frame = value.trim().parse().unwrap_or(frame),
                    "fps" => fps_now = value.trim().parse().unwrap_or(fps_now),
                    "speed" => speed = value.trim().to_string(),
                    "out_time_us" | "out_time_ms" => {
                        // Both keys report microseconds despite the ms name.
                        if let Ok(us) = value.trim().parse::<f64>() {
                            out_time = us / 1_000_000.0;
                        }
                    }
                    "progress" => {
                        let _ = app_handle.emit(
                            "karaoke-render-progress",
                            RenderProgress {
                                frame,
                                total_frames,
                                fps: fps_now,
                                seconds_done: out_time,
                                speed: speed.clone(),
                            },
                        );
                    }
                    _ => {}
                }
            }
        });
    }

    // ffmpeg writes real errors to stderr; keep them for the failure message.
    let stderr_handle = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut collected = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push(line);
                if collected.len() > 60 {
                    collected.remove(0);
                }
            }
            collected.join("\n")
        })
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg failed to run: {e}"))?;

    let stderr_text = match stderr_handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };

    if !status.success() {
        return Err(format!(
            "ffmpeg exited with {}.\n{}",
            status.code().unwrap_or(-1),
            stderr_text.trim()
        ));
    }

    Ok(RenderResult {
        output_path: request.output_path,
        duration_seconds: request.duration,
    })
}
