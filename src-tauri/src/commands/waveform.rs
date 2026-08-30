use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use std::fs::File;

#[derive(serde::Serialize)]
pub struct WaveformResult {
    pub peaks: Vec<f32>,
    pub duration: f64,
}

#[tauri::command]
pub async fn extract_waveform(path: String, peaks_per_second: f64) -> Result<WaveformResult, String> {
    tokio::task::spawn_blocking(move || extract_waveform_sync(&path, peaks_per_second))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

fn extract_waveform_sync(path: &str, peaks_per_second: f64) -> Result<WaveformResult, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Unsupported format: {e}"))?;

    let mut format = probed.format;

    // Find the first audio track
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or("Unknown sample rate")? as f64;

    // n_frames gives us the total frame count — use it for duration and to enable
    // the fast seeking path (avoids reading the whole file sequentially).
    let n_frames = track.codec_params.n_frames.unwrap_or(0);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec not supported: {e}"))?;

    // --- Fast path: seek to evenly-spaced positions ---
    // When n_frames is known we can jump through the file instead of reading
    // every packet.  This is orders of magnitude faster for large files.
    if n_frames > 0 {
        let duration = n_frames as f64 / sample_rate;
        // Cap total peaks so we never do more work than needed.
        let n_peaks = ((duration * peaks_per_second) as usize)
            .min(18_000)
            .max(10);
        let step = duration / n_peaks as f64;

        let mut peaks = vec![0.0f32; n_peaks];

        for i in 0..n_peaks {
            let seek_secs = i as f64 * step;

            if format
                .seek(
                    SeekMode::Coarse,
                    SeekTo::Time {
                        time: Time {
                            seconds: seek_secs as u64,
                            frac: seek_secs.fract(),
                        },
                        track_id: Some(track_id),
                    },
                )
                .is_err()
            {
                break;
            }

            // Read packets until we find an audio one for this slot.
            let rms = 'slot: loop {
                let packet = match format.next_packet() {
                    Ok(p) => p,
                    Err(_) => break 'slot 0.0f32,
                };
                if packet.track_id() != track_id {
                    continue;
                }
                let decoded = match decoder.decode(&packet) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                let spec = *decoded.spec();
                let ch = spec.channels.count();
                let n_f = decoded.capacity();
                let mut sample_buf = SampleBuffer::<f32>::new(n_f as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);
                let samples = sample_buf.samples();

                let mut sum_sq = 0.0f64;
                let mut count = 0usize;
                let mut j = 0;
                while j < samples.len() {
                    let mut frame_sum = 0.0f32;
                    for c in 0..ch {
                        if j + c < samples.len() {
                            frame_sum += samples[j + c];
                        }
                    }
                    let mono = frame_sum / ch as f32;
                    sum_sq += (mono as f64) * (mono as f64);
                    count += 1;
                    j += ch;
                }

                break 'slot if count > 0 {
                    (sum_sq / count as f64).sqrt() as f32
                } else {
                    0.0f32
                };
            };

            peaks[i] = rms;
        }

        // Normalize
        let max_peak = peaks.iter().cloned().fold(0.0f32, f32::max);
        if max_peak > 0.0 {
            for p in &mut peaks {
                *p /= max_peak;
            }
        }

        return Ok(WaveformResult { peaks, duration });
    }

    // --- Slow path: sequential decode (fallback when n_frames is unknown) ---
    let samples_per_peak = (sample_rate / peaks_per_second).max(1.0) as usize;

    let mut peaks: Vec<f32> = Vec::new();
    let mut sum_sq: f64 = 0.0;
    let mut count: usize = 0;
    // total_frames counts mono frames (one per sample-pair across channels).
    let mut total_frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let num_frames = decoded.capacity();
        let ch = spec.channels.count();

        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        // Mix channels down to mono and accumulate RMS per peak window.
        let mut i = 0;
        while i < samples.len() {
            let mut frame_sum: f32 = 0.0;
            for c in 0..ch {
                if i + c < samples.len() {
                    frame_sum += samples[i + c];
                }
            }
            let mono = frame_sum / ch as f32;

            sum_sq += (mono as f64) * (mono as f64);
            count += 1;
            total_frames += 1;

            if count >= samples_per_peak {
                let rms = (sum_sq / count as f64).sqrt() as f32;
                peaks.push(rms);
                sum_sq = 0.0;
                count = 0;
            }

            i += ch;
        }
    }

    // Flush remaining samples
    if count > 0 {
        let rms = (sum_sq / count as f64).sqrt() as f32;
        peaks.push(rms);
    }

    // Normalize peaks
    let max_peak = peaks.iter().cloned().fold(0.0f32, f32::max);
    if max_peak > 0.0 {
        for p in &mut peaks {
            *p /= max_peak;
        }
    }

    // Fixed: total_frames already counts frames (not raw interleaved samples),
    // so we only divide by sample_rate — NOT by channels.
    let duration = total_frames as f64 / sample_rate;

    Ok(WaveformResult { peaks, duration })
}
