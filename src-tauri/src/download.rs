//! 视频下载模块：支持 HLS (m3u8) 与直链视频下载，
//! 自动解析 m3u8 清单、处理 AES-128 解密分片，并按顺序拼接为完整视频。
//! 若本地安装了 ffmpeg，将自动无损转封装为 .mp4，否则保存为 .ts。

use crate::media::absolutize;
use crate::net::{base, fetch_bytes, get};
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub title: String,
    pub status: String, // "downloading" | "completed" | "error" | "cancelled"
    pub progress: f32,  // 0.0 ~ 100.0
    pub total_segments: usize,
    pub downloaded_segments: usize,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub sub_dir: Option<String>,
}

static TASKS: Lazy<Mutex<HashMap<String, DownloadTask>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn update_task(app: &AppHandle, id: &str, f: impl FnOnce(&mut DownloadTask)) {
    let task = {
        let mut map = TASKS.lock().unwrap();
        if let Some(t) = map.get_mut(id) {
            f(t);
            Some(t.clone())
        } else {
            None
        }
    };
    if let Some(t) = task {
        let _ = app.emit("download-progress", &t);
    }
}

pub fn get_download_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .download_dir()
        .ok()
        .or_else(|| {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(|h| PathBuf::from(h).join("Downloads"))
                .ok()
        })
        .unwrap_or_else(|| PathBuf::from("."));

    let dir = base.join("HGhub");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "video".to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_unique_path(dir: &Path, base_name: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base_name}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    let mut count = 1;
    loop {
        candidate = dir.join(format!("{base_name} ({count}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        count += 1;
    }
}

/* ───────────────────────── AES-128 解密 ───────────────────────── */

fn aes_cbc_decrypt(key: &[u8], iv: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(key).ok()?;
    let mut prev = *iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn seq_to_iv(seq: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..16].copy_from_slice(&seq.to_be_bytes());
    iv
}

fn parse_hex_iv(s: &str) -> Option<[u8; 16]> {
    let s = s
        .trim()
        .strip_prefix("0x")
        .or_else(|| s.trim().strip_prefix("0X"))
        .unwrap_or(s.trim());
    if s.len() != 32 {
        return None;
    }
    let mut iv = [0u8; 16];
    for i in 0..16 {
        iv[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(iv)
}

fn parse_key_tag(line: &str) -> Option<(String, Option<String>, Option<[u8; 16]>)> {
    let (_, rest) = line.split_once(':')?;
    let mut method = String::new();
    let mut uri = None;
    let mut iv = None;

    let mut in_quotes = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            in_quotes = !in_quotes;
        } else if ch == ',' && !in_quotes {
            parts.push(&rest[start..i]);
            start = i + 1;
        }
    }
    parts.push(&rest[start..]);

    for part in parts {
        let (k, v) = match part.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => continue,
        };
        if k.eq_ignore_ascii_case("METHOD") {
            method = v.trim_matches('"').to_string();
        } else if k.eq_ignore_ascii_case("URI") {
            uri = Some(v.trim_matches('"').to_string());
        } else if k.eq_ignore_ascii_case("IV") {
            iv = parse_hex_iv(v.trim_matches('"'));
        }
    }
    Some((method, uri, iv))
}

/* ───────────────────────── 转封装 ───────────────────────── */

fn try_remux_to_mp4(ts_path: &Path, mp4_path: &Path) -> bool {
    let ffmpeg_candidates = [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for bin in ffmpeg_candidates {
        // 先尝试加 aac_adtstoasc 过滤器的快速封装
        let res = std::process::Command::new(bin)
            .args(["-y", "-i"])
            .arg(ts_path)
            .args(["-c", "copy", "-bsf:a", "aac_adtstoasc"])
            .arg(mp4_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        if let Ok(status) = res {
            if status.success()
                && mp4_path.exists()
                && mp4_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
            {
                let _ = std::fs::remove_file(ts_path);
                return true;
            }
        }

        // 备选尝试纯 -c copy
        let res2 = std::process::Command::new(bin)
            .args(["-y", "-i"])
            .arg(ts_path)
            .args(["-c", "copy"])
            .arg(mp4_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        if let Ok(status) = res2 {
            if status.success()
                && mp4_path.exists()
                && mp4_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
            {
                let _ = std::fs::remove_file(ts_path);
                return true;
            }
        }
    }
    false
}

/* ───────────────────────── 核心下载逻辑 ───────────────────────── */

#[derive(Clone)]
struct SegmentItem {
    url: String,
    key: Option<Arc<Vec<u8>>>,
    iv: [u8; 16],
}

async fn download_task_worker(
    app: AppHandle,
    id: String,
    title: String,
    raw_url: String,
    sub_dir: Option<String>,
) -> Result<String, String> {
    let mut save_dir = get_download_dir(&app);
    if let Some(ref sub) = sub_dir {
        let clean_sub = sanitize_filename(sub);
        if !clean_sub.is_empty() {
            save_dir = save_dir.join(clean_sub);
            let _ = std::fs::create_dir_all(&save_dir);
        }
    }
    let clean_title = sanitize_filename(&title);

    // 首先拉取原始地址探测是否是 HLS 还是直接视频文件
    let (_, first_bytes) = fetch_bytes(&raw_url).await?;
    let is_m3u8 = first_bytes.starts_with(b"#EXTM3U")
        || first_bytes.starts_with(b"\xef\xbb\xbf#EXTM3U")
        || raw_url.contains(".m3u8");

    if !is_m3u8 {
        // 直接文件（如 mp4）
        let target_path = get_unique_path(&save_dir, &clean_title, "mp4");
        let mut file = std::fs::File::create(&target_path).map_err(|e| e.to_string())?;

        let referer = format!("{}/", base());
        let mut resp = get(&raw_url, Duration::from_secs(60), None, Some(&referer)).await?;
        let total_size = resp.content_length().unwrap_or(0);
        let mut downloaded = 0u64;

        update_task(&app, &id, |t| {
            t.total_segments = 1;
            t.progress = 5.0;
        });

        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if total_size > 0 {
                let pct = (downloaded as f32 / total_size as f32) * 95.0 + 5.0;
                update_task(&app, &id, |t| {
                    t.progress = pct.min(99.0);
                });
            }
        }

        let path_str = target_path.to_string_lossy().to_string();
        update_task(&app, &id, |t| {
            t.status = "completed".to_string();
            t.progress = 100.0;
            t.downloaded_segments = 1;
            t.file_path = Some(path_str.clone());
        });
        return Ok(path_str);
    }

    // ── HLS 处理 ──
    let text = std::str::from_utf8(&first_bytes).map_err(|_| "播放列表编码错误")?;
    let mut playlist_text = text.trim_start_matches('\u{feff}').to_string();
    let mut current_pl_url = raw_url.clone();

    // 检查 Master Playlist（变体选择）
    if playlist_text.contains("#EXT-X-STREAM-INF") {
        let mut highest_bw = 0u64;
        let mut picked_uri = None;
        let mut next_is_uri = false;
        let mut last_bw = 0u64;

        for line in playlist_text.lines() {
            let l = line.trim();
            if next_is_uri && !l.starts_with('#') && !l.is_empty() {
                if last_bw >= highest_bw || picked_uri.is_none() {
                    highest_bw = last_bw;
                    picked_uri = Some(l.to_string());
                }
                next_is_uri = false;
                continue;
            }
            if l.starts_with("#EXT-X-STREAM-INF:") {
                next_is_uri = true;
                last_bw = 0;
                if let Some(pos) = l.find("BANDWIDTH=") {
                    let num_str: String = l[pos + 10..]
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    last_bw = num_str.parse().unwrap_or(0);
                }
            }
        }

        if let Some(sub_uri) = picked_uri {
            current_pl_url = absolutize(&raw_url, &sub_uri);
            let (_, sub_bytes) = fetch_bytes(&current_pl_url).await?;
            playlist_text = std::str::from_utf8(&sub_bytes)
                .map_err(|_| "子播放列表不是 UTF-8")?
                .trim_start_matches('\u{feff}')
                .to_string();
        }
    }

    // 解析分片清单
    let mut media_seq: u64 = 0;
    let mut current_key: Option<Arc<Vec<u8>>> = None;
    let mut current_iv: Option<[u8; 16]> = None;
    let mut segments: Vec<SegmentItem> = Vec::new();
    let mut key_cache: HashMap<String, Arc<Vec<u8>>> = HashMap::new();

    for line in playlist_text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }

        if l.starts_with("#EXT-X-MEDIA-SEQUENCE:") {
            if let Some(num_str) = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                media_seq = num_str.trim().parse().unwrap_or(0);
            }
            continue;
        }

        if l.starts_with("#EXT-X-KEY:") {
            if let Some((method, uri, iv)) = parse_key_tag(l) {
                if method.eq_ignore_ascii_case("NONE") {
                    current_key = None;
                    current_iv = None;
                } else if method.eq_ignore_ascii_case("AES-128") {
                    if let Some(key_rel) = uri {
                        let key_abs = absolutize(&current_pl_url, &key_rel);
                        let key_bytes = if let Some(hit) = key_cache.get(&key_abs) {
                            hit.clone()
                        } else {
                            let (_, kb) = fetch_bytes(&key_abs).await?;
                            let arc = Arc::new(kb);
                            key_cache.insert(key_abs, arc.clone());
                            arc
                        };
                        current_key = Some(key_bytes);
                    }
                    current_iv = iv;
                }
            }
            continue;
        }

        if !l.starts_with('#') {
            let seg_url = absolutize(&current_pl_url, l);
            let iv = current_iv.unwrap_or_else(|| seq_to_iv(media_seq));
            segments.push(SegmentItem {
                url: seg_url,
                key: current_key.clone(),
                iv,
            });
            media_seq += 1;
        }
    }

    let total = segments.len();
    if total == 0 {
        return Err("播放列表中没有有效分片".to_string());
    }

    update_task(&app, &id, |t| {
        t.total_segments = total;
        t.progress = 1.0;
    });

    let target_ts = get_unique_path(&save_dir, &clean_title, "ts");
    let mut out_file = std::fs::File::create(&target_ts).map_err(|e| e.to_string())?;

    let mut downloaded = 0;
    // 每次并发 5 个分片下载，兼顾带宽利用率与内存/顺序
    const CHUNK_SIZE: usize = 5;
    for chunk in segments.chunks(CHUNK_SIZE) {
        if CANCELLED.lock().unwrap().remove(&id) {
            drop(out_file);
            let _ = std::fs::remove_file(&target_ts);
            update_task(&app, &id, |t| {
                t.status = "cancelled".to_string();
                t.error = Some("已取消下载".to_string());
            });
            return Err("已取消下载".to_string());
        }

        let mut handles = Vec::new();
        for item in chunk {
            let item = item.clone();
            handles.push(tokio::spawn(async move {
                let (_, data) = fetch_bytes(&item.url).await?;
                let decrypted = if let Some(ref key) = item.key {
                    if let Some(dec) = aes_cbc_decrypt(key, &item.iv, &data) {
                        strip_padding(dec)
                    } else {
                        data
                    }
                } else {
                    data
                };
                Ok::<Vec<u8>, String>(decrypted)
            }));
        }

        for h in handles {
            let seg_bytes = h
                .await
                .map_err(|e| format!("分片任务崩溃: {e}"))?
                .map_err(|e| format!("下载分片失败: {e}"))?;
            out_file
                .write_all(&seg_bytes)
                .map_err(|e| format!("写入文件失败: {e}"))?;
            downloaded += 1;
        }

        let pct = (downloaded as f32 / total as f32) * 98.0;
        update_task(&app, &id, |t| {
            t.downloaded_segments = downloaded;
            t.progress = pct.max(1.0).min(98.0);
        });
    }

    out_file.flush().map_err(|e| e.to_string())?;
    drop(out_file);

    // 检查并尝试使用 ffmpeg 快速转为 mp4
    let target_mp4 = target_ts.with_extension("mp4");
    let final_path = if try_remux_to_mp4(&target_ts, &target_mp4) {
        target_mp4
    } else {
        target_ts
    };

    let path_str = final_path.to_string_lossy().to_string();
    update_task(&app, &id, |t| {
        t.status = "completed".to_string();
        t.progress = 100.0;
        t.downloaded_segments = total;
        t.file_path = Some(path_str.clone());
    });

    Ok(path_str)
}

/* ───────────────────────── Tauri 命令 ───────────────────────── */

#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    id: String,
    title: String,
    url: String,
    sub_dir: Option<String>,
) -> Result<DownloadTask, String> {
    let task = DownloadTask {
        id: id.clone(),
        title: title.clone(),
        status: "downloading".to_string(),
        progress: 0.0,
        total_segments: 0,
        downloaded_segments: 0,
        file_path: None,
        error: None,
        sub_dir: sub_dir.clone(),
    };

    {
        let mut map = TASKS.lock().unwrap();
        map.insert(id.clone(), task.clone());
    }

    let app_clone = app.clone();
    let id_clone = id.clone();
    let sub_clone = sub_dir.clone();
    tokio::spawn(async move {
        if let Err(err) = download_task_worker(app_clone.clone(), id_clone.clone(), title, url, sub_clone).await {
            update_task(&app_clone, &id_clone, |t| {
                t.status = "error".to_string();
                t.error = Some(err);
            });
        }
    });

    Ok(task)
}

#[tauri::command]
pub fn download_status(id: String) -> Option<DownloadTask> {
    let map = TASKS.lock().unwrap();
    map.get(&id).cloned()
}

#[tauri::command]
pub fn cancel_download(id: String) {
    let mut c = CANCELLED.lock().unwrap();
    c.insert(id);
}

#[tauri::command]
pub async fn open_download_item(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reveal_download_item(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reveal_download_dir(app: AppHandle, sub_dir: Option<String>) -> Result<(), String> {
    let mut dir = get_download_dir(&app);
    if let Some(ref sub) = sub_dir {
        let clean_sub = sanitize_filename(sub);
        if !clean_sub.is_empty() {
            dir = dir.join(clean_sub);
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_sanitization() {
        assert_eq!(sanitize_filename("test/video:name*?.mp4"), "test_video_name__.mp4");
        assert_eq!(sanitize_filename("   "), "video");
        assert_eq!(sanitize_filename("霸道总裁:爱上我 第1集"), "霸道总裁_爱上我 第1集");
    }

    #[test]
    fn parse_hex_iv_works() {
        let iv = parse_hex_iv("0x00000000000000000000000000000001").unwrap();
        assert_eq!(iv[15], 1);
        assert_eq!(iv[0], 0);

        let iv2 = parse_hex_iv("0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(iv2[0], 0x01);
        assert_eq!(iv2[7], 0xef);
    }

    #[test]
    fn parse_key_tag_works() {
        let tag = "#EXT-X-KEY:METHOD=AES-128,URI=\"https://example.com/key.bin\",IV=0x00000000000000000000000000000002";
        let (method, uri, iv) = parse_key_tag(tag).unwrap();
        assert_eq!(method, "AES-128");
        assert_eq!(uri.as_deref(), Some("https://example.com/key.bin"));
        assert_eq!(iv.unwrap()[15], 2);

        let none_tag = "#EXT-X-KEY:METHOD=NONE";
        let (method2, uri2, iv2) = parse_key_tag(none_tag).unwrap();
        assert_eq!(method2, "NONE");
        assert!(uri2.is_none());
        assert!(iv2.is_none());
    }

    #[test]
    fn seq_to_iv_works() {
        let iv = seq_to_iv(42);
        assert_eq!(iv[15], 42);
        assert_eq!(iv[0], 0);
    }

    #[test]
    fn aes_decrypt_and_unpad() {
        use aes::cipher::BlockEncrypt;

        let key = b"1234567890123456";
        let iv = [0u8; 16];
        let plain = b"hello video data".to_vec();

        let cipher = Aes128::new_from_slice(key).unwrap();
        let mut block = [0u8; 16];
        block.copy_from_slice(&plain);
        for i in 0..16 { block[i] ^= iv[i]; }
        cipher.encrypt_block((&mut block).into());

        let dec = aes_cbc_decrypt(key, &iv, &block).unwrap();
        assert_eq!(dec, plain);
    }
}
