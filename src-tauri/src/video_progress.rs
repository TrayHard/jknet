//! Read growing jaMME RIFF chunks without loading frame payloads into memory.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub frames: u64,
    pub captured_seconds: f64,
    pub output_bytes: u64,
    pub encoded_seconds: f64,
    pub encoding_percent: Option<f64>,
}
#[derive(Default)]
struct AviCursor {
    offset: u64,
    frames: u64,
    bytes: u64,
}
impl AviCursor {
    fn scan(&mut self, file: &mut (impl Read + Seek), size: u64) -> io::Result<()> {
        self.bytes = size;
        if self.offset == 0 {
            let mut header = [0; 12];
            if size < 12 {
                return Ok(());
            }
            file.seek(SeekFrom::Start(0))?;
            file.read_exact(&mut header)?;
            if &header[..4] != b"RIFF" || &header[8..] != b"AVI " {
                return Ok(());
            }
            self.offset = 12;
        }
        // A growing movi LIST has no final length yet; enter it, then count
        // complete video chunks only. Keep the offset at a partial chunk.
        while self.offset + 8 <= size {
            file.seek(SeekFrom::Start(self.offset))?;
            let mut header = [0; 8];
            file.read_exact(&mut header)?;
            let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as u64;
            if &header[..4] == b"LIST" {
                if self.offset + 12 > size {
                    break;
                }
                let mut kind = [0; 4];
                file.read_exact(&mut kind)?;
                if &kind == b"movi" || &kind == b"rec " {
                    self.offset += 12;
                    continue;
                }
            }
            let next = self.offset + 8 + length + (length & 1);
            if next > size {
                break;
            }
            if &header[..4] == b"00dc" || &header[..4] == b"00db" {
                self.frames += 1;
            }
            self.offset = next;
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct CaptureProgress(BTreeMap<PathBuf, AviCursor>);
impl CaptureProgress {
    pub fn sample(&mut self, files: &[PathBuf], fps: u32) -> VideoProgress {
        for path in files {
            if let Ok(mut file) = File::open(path) {
                if let Ok(meta) = file.metadata() {
                    let _ = self
                        .0
                        .entry(path.clone())
                        .or_default()
                        .scan(&mut file, meta.len());
                }
            }
        }
        let frames = self.0.values().map(|v| v.frames).sum();
        VideoProgress {
            frames,
            captured_seconds: frames as f64 / fps as f64,
            output_bytes: self.0.values().map(|v| v.bytes).sum(),
            ..Default::default()
        }
    }
}
pub fn encoder_sample(path: &Path, duration: f64) -> (f64, Option<f64>) {
    // Bound reads even when encoding a long demo. Ignore the first partial line.
    let text = (|| -> io::Result<String> {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(8192)))?;
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        Ok(text)
    })()
    .unwrap_or_default();
    let seconds = text
        .lines()
        .filter_map(|line| line.strip_prefix("out_time_us=")?.parse::<u64>().ok())
        .next_back()
        .unwrap_or(0) as f64
        / 1_000_000.0;
    (
        seconds,
        (duration > 0.0).then(|| (seconds / duration * 100.0).clamp(0.0, 99.9)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_last_valid_encoder_timestamp_and_bounds_percent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("progress.txt");
        std::fs::write(
            &path,
            "out_time_us=1000000\nout_time_us=5000000\nout_time_us=N/A\n",
        )
        .unwrap();
        assert_eq!(encoder_sample(&path, 10.0), (5.0, Some(50.0)));
        assert_eq!(encoder_sample(&path, 0.0), (5.0, None));
        assert_eq!(encoder_sample(&path, 1.0), (5.0, Some(99.9)));
    }
    #[test]
    fn counts_growing_interleaved_avi_without_counting_partial_frames_twice() {
        let mut bytes = b"RIFF\0\0\0\0AVI LIST\x04\0\0\0movi".to_vec();
        bytes.extend_from_slice(b"00db\x03\0\0\0abc\0");
        bytes.extend_from_slice(b"01wb\x02\0\0\0ab");
        bytes.extend_from_slice(b"00dc\x04\0\0\0abcd");
        let mut cursor = AviCursor::default();
        cursor
            .scan(&mut io::Cursor::new(&bytes), bytes.len() as u64 - 2)
            .unwrap();
        assert_eq!(cursor.frames, 1);
        cursor
            .scan(&mut io::Cursor::new(&bytes), bytes.len() as u64)
            .unwrap();
        cursor
            .scan(&mut io::Cursor::new(&bytes), bytes.len() as u64)
            .unwrap();
        assert_eq!(cursor.frames, 2);
    }
}
