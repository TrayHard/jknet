//! Archive-local metadata and bounded, launcher-owned preview images.
use std::{
    fs::{self, File},
    io::{BufReader, Cursor, Read},
    path::Path,
};

use image::{ImageFormat, ImageReader, Limits};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::SystemTime,
};
use zip::ZipArchive;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
type Stamp = (u64, Option<SystemTime>);
type Preview = (Vec<String>, Option<String>);
struct Cached {
    source: Option<Stamp>,
    image: Option<Stamp>,
    value: Preview,
}
static CACHE: LazyLock<Mutex<HashMap<(PathBuf, PathBuf), Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

#[cfg(test)]
fn inspect(path: &Path, cache: &Path) -> Preview {
    inspect_protected(path, cache, &[])
}

pub(crate) fn inspect_protected(path: &Path, cache: &Path, protected: &[String]) -> Preview {
    let mut capacity_failure = false;
    let Ok(mut memo) = CACHE.lock() else {
        return inspect_uncached(path, cache, protected, &mut capacity_failure);
    };
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path = canonical.as_path();
    let key = (canonical.clone(), cache.to_path_buf());
    let source = stamp(path);
    if let Some(previous) = memo.get(&key) {
        let image = previous
            .value
            .1
            .as_ref()
            .and_then(|path| stamp(Path::new(path)));
        if source == previous.source && image == previous.image {
            return previous.value.clone();
        }
    }
    let value = inspect_uncached(path, cache, protected, &mut capacity_failure);
    if capacity_failure {
        memo.remove(&key);
        return value;
    }
    let image = value.1.as_ref().and_then(|path| stamp(Path::new(path)));
    if memo.len() >= 128 {
        memo.clear();
    }
    memo.insert(
        key,
        Cached {
            source,
            image,
            value: value.clone(),
        },
    );
    value
}

/// Keep the engine-relative path and extension, including every map in packs.
pub(crate) fn map_names(entries: &[String]) -> Vec<String> {
    let mut maps: Vec<_> = entries
        .iter()
        .filter_map(|name| {
            let name = name.replace('\\', "/");
            let lower = name.to_ascii_lowercase();
            (lower.starts_with("maps/") && lower.ends_with(".bsp")).then(|| name[5..].to_string())
        })
        .collect();
    maps.sort();
    maps.dedup();
    maps
}

fn candidates(entries: &[String], maps: &[String]) -> Vec<(usize, String)> {
    let mut choices = Vec::new();
    for (index, original) in entries.iter().enumerate() {
        let name = original.replace('\\', "/").to_ascii_lowercase();
        let Some((stem, extension)) = name.rsplit_once('.') else {
            continue;
        };
        if !matches!(extension, "jpg" | "jpeg" | "png" | "tga") {
            continue;
        }
        let rank = if let Some(level) = stem.strip_prefix("levelshots/") {
            if maps.iter().any(|map| {
                let map = map.to_ascii_lowercase();
                let key = map.trim_end_matches(".bsp");
                level == key || level == key.rsplit('/').next().unwrap_or(key)
            }) {
                0
            } else {
                continue;
            }
        } else if maps.is_empty()
            && stem.starts_with("models/players/")
            && stem
                .rsplit('/')
                .next()
                .is_some_and(|name| name == "icon_default" || name.starts_with("icon_"))
        {
            if stem.ends_with("/icon_default") {
                1
            } else {
                2
            }
        } else if matches!(
            stem,
            "preview" | "screenshot" | "thumbnail" | "readme/preview" | "splash" | "readme/splash"
        ) {
            3
        } else {
            continue;
        };
        choices.push((rank, name, index, original.clone()));
    }
    choices.sort();
    choices
        .into_iter()
        .map(|(_, _, index, name)| (index, name))
        .collect()
}

fn decode(bytes: &[u8], format: ImageFormat) -> Option<image::DynamicImage> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().ok()
}

fn valid_cache(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    if !file.metadata().is_ok_and(|meta| meta.len() <= MAX_BYTES) {
        return false;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_ok()
        && bytes.len() as u64 <= MAX_BYTES
        && decode(&bytes, ImageFormat::Png).is_some()
}

/// Bound retained thumbnails as archives are replaced or removed. Only files
/// generated by this module qualify; unrelated files are never removed.
fn prune(cache: &Path, keep: &Path, protected: &[String]) -> bool {
    let Ok(entries) = fs::read_dir(cache) else {
        return true;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if name.len() != 44
                || !name.ends_with(".png")
                || !name[..40].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            let meta = entry.metadata().ok()?;
            meta.is_file()
                .then(|| (meta.modified().ok(), meta.len(), path))
        })
        .collect();
    files.sort();
    let mut bytes: u64 = files.iter().map(|file| file.1).sum();
    let mut count = files.len();
    for (_, size, path) in files {
        if bytes <= 64 * 1024 * 1024 && count <= 256 {
            break;
        }
        if path != keep
            && !protected.iter().any(|entry| Path::new(entry) == path)
            && fs::remove_file(&path).is_ok()
        {
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
    }
    bytes <= 64 * 1024 * 1024 && count <= 256
}

/// No extraction destination uses an archive-controlled path. ZIP CRC and the
/// source timestamp make replacement images distinct asset URLs.
fn inspect_uncached(
    path: &Path,
    cache: &Path,
    protected: &[String],
    capacity_failure: &mut bool,
) -> Preview {
    let Ok(file) = File::open(path) else {
        return (vec![], None);
    };
    let stamp = file
        .metadata()
        .ok()
        .map(|meta| (meta.len(), meta.modified().ok()));
    let Ok(mut archive) = ZipArchive::new(BufReader::new(file)) else {
        return (vec![], None);
    };
    let entries: Vec<_> = (0..archive.len())
        .map(|index| {
            archive
                .by_index_raw(index)
                .map(|entry| entry.name().to_string())
                .unwrap_or_default()
        })
        .collect();
    let maps = map_names(&entries);
    for (index, name) in candidates(&entries, &maps).into_iter().take(16) {
        let Ok(mut entry) = archive.by_index(index) else {
            continue;
        };
        if entry.size() > MAX_BYTES {
            continue;
        }
        let key = format!("v1:{path:?}:{stamp:?}:{name}:{}", entry.crc32());
        let hash: String = Sha1::digest(key.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let target = cache.join(format!("{hash}.png"));
        if valid_cache(&target) {
            return (maps, Some(target.display().to_string()));
        }
        let mut bytes = Vec::new();
        if entry
            .by_ref()
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BYTES
        {
            continue;
        }
        let extension = name
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(format) = ImageFormat::from_extension(extension) else {
            continue;
        };
        let Some(image) = decode(&bytes, format) else {
            continue;
        };
        let image = image.thumbnail(640, 360);
        let mut output = Cursor::new(Vec::new());
        if image.write_to(&mut output, ImageFormat::Png).is_err() {
            continue;
        }
        if fs::create_dir_all(cache).is_ok() && fs::write(&target, output.into_inner()).is_ok() {
            if !prune(cache, &target, protected) {
                let _ = fs::remove_file(&target);
                *capacity_failure = true;
                return (maps, None);
            }
            return (maps, Some(target.display().to_string()));
        }
    }
    (maps, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "jknet-preview-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    fn png() -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(32, 32)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    #[test]
    fn every_map_after_twenty_entries_survives_disabled_archive() {
        let root = Temp::new();
        let path = root.0.join("unrelated.pk3.disabled");
        let names: Vec<_> = (0..35).map(|n| format!("maps/mp/map{n:02}.bsp")).collect();
        let mut entries: Vec<(&str, &[u8])> = Vec::new();
        entries.extend(names.iter().map(|name| (name.as_str(), b"".as_slice())));
        entries.push(("Maps\\nested\\Extra.BSP", b""));
        archive(&path, &entries);
        let (maps, image) = inspect(&path, &root.0.join("cache"));
        assert_eq!(maps.len(), 36);
        assert!(maps.contains(&"mp/map34.bsp".into()));
        assert!(maps.contains(&"nested/Extra.BSP".into()));
        assert!(image.is_none());
    }
    #[test]
    fn candidates_match_maps_and_ignore_effects_and_unrelated_levelshots() {
        let entries = [
            "gfx/effects/atlantica/splash.tga",
            "levelshots/other.jpg",
            "levelshots/atlantica.jpg",
            "models/players/kyle/icon_default.jpg",
        ]
        .map(String::from);
        assert_eq!(
            candidates(&entries, &["atlantica.bsp".into()]),
            vec![(2, entries[2].clone())]
        );
        assert_eq!(candidates(&entries, &[]), vec![(3, entries[3].clone())]);
    }
    #[test]
    fn corruption_falls_through_and_cached_image_is_repaired() {
        let root = Temp::new();
        let path = root.0.join("maps.pk3");
        let bytes = png();
        archive(
            &path,
            &[
                ("maps/a.bsp", b""),
                ("levelshots/a.jpg", b"broken"),
                ("levelshots/a.png", &bytes),
            ],
        );
        let cache = root.0.join("cache");
        let first = inspect(&path, &cache);
        let target = Path::new(first.1.as_ref().unwrap());
        assert!(valid_cache(target));
        let before = stamp(target);
        assert_eq!(first, inspect(&path, &cache));
        assert_eq!(before, stamp(target), "cache hit does not rewrite");
        fs::write(target, b"broken").unwrap();
        assert_eq!(first, inspect(&path, &cache));
        assert!(valid_cache(target));
    }
    #[test]
    fn same_size_replacement_invalidates_metadata_and_negative_cache() {
        let root = Temp::new();
        let path = root.0.join("maps.pk3");
        let cache = root.0.join("cache");
        archive(&path, &[("maps/a.bsp", b"")]);
        let first = stamp(&path).unwrap();
        assert_eq!(inspect(&path, &cache).0, vec!["a.bsp"]);
        archive(&path, &[("maps/b.bsp", b"")]);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(12345))
            .unwrap();
        assert_eq!(first.0, stamp(&path).unwrap().0);
        assert_eq!(inspect(&path, &cache).0, vec!["b.bsp"]);
        fs::write(&path, b"invalid zip").unwrap();
        assert_eq!(inspect(&path, &cache), (vec![], None));
    }
    #[test]
    fn oversized_decode_is_refused() {
        let mut tga = vec![0; 18];
        tga[2] = 2;
        tga[12..14].copy_from_slice(&8192u16.to_le_bytes());
        tga[14..16].copy_from_slice(&8192u16.to_le_bytes());
        tga[16] = 24;
        assert!(decode(&tga, ImageFormat::Tga).is_none());
    }

    #[test]
    fn explicit_cover_is_available_for_a_map_without_levelshot() {
        let entries = ["maps/mp/a.bsp", "preview.png", "gfx/effects/splash.tga"].map(String::from);
        assert_eq!(
            candidates(&entries, &["mp/a.bsp".into()]),
            vec![(1, "preview.png".into())]
        );
    }

    #[test]
    fn pruning_bounds_only_owned_cache_files() {
        let root = Temp::new();
        for n in 0..260 {
            fs::write(root.0.join(format!("{n:040x}.png")), b"x").unwrap();
        }
        let keep = root.0.join(format!("{:040x}.png", 259));
        fs::write(root.0.join("unrelated.txt"), b"keep").unwrap();
        assert!(prune(&root.0, &keep, &[]));
        assert!(keep.exists());
        assert!(root.0.join("unrelated.txt").exists());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 257);
    }

    #[test]
    fn pruning_never_removes_previews_already_selected_for_this_response() {
        let root = Temp::new();
        let protected: Vec<_> = (0..256)
            .map(|n| {
                let path = root.0.join(format!("{n:040x}.png"));
                fs::write(&path, b"x").unwrap();
                path.display().to_string()
            })
            .collect();
        let keep = root.0.join(format!("{:040x}.png", 256));
        fs::write(&keep, b"x").unwrap();
        assert!(!prune(&root.0, &keep, &protected));
        assert!(protected.iter().all(|path| Path::new(path).exists()));
    }

    #[test]
    fn capacity_failure_retries_when_space_is_freed_without_source_changes() {
        let root = Temp::new();
        let cache = root.0.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let protected: Vec<_> = (0..256)
            .map(|n| {
                let path = cache.join(format!("{n:040x}.png"));
                fs::write(&path, b"x").unwrap();
                path.display().to_string()
            })
            .collect();
        let path = root.0.join("map.pk3");
        archive(&path, &[("maps/a.bsp", b""), ("levelshots/a.png", &png())]);
        let before = stamp(&path);
        assert_eq!(
            inspect_protected(&path, &cache, &protected),
            (vec!["a.bsp".into()], None)
        );
        fs::remove_file(&protected[0]).unwrap();
        let retried = inspect_protected(&path, &cache, &protected);
        assert!(retried.1.is_some());
        assert_eq!(before, stamp(&path));
    }

    /// Read-only input directory; generated images live only in a test temp root.
    #[test]
    #[ignore = "requires JKNET_PREVIEW_FIXTURE_DIR pointing to downloaded archives"]
    fn downloaded_archives_report_maps_and_own_artwork() {
        let input = PathBuf::from(
            std::env::var_os("JKNET_PREVIEW_FIXTURE_DIR").expect("fixture directory"),
        );
        let root = Temp::new();
        let mut count = 0;
        for entry in fs::read_dir(input).unwrap().flatten() {
            let path = entry.path();
            if !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pk3"))
            {
                continue;
            }
            let (maps, preview) = inspect(&path, &root.0);
            eprintln!(
                "{}: maps={maps:?}, own_artwork={}",
                path.file_name().unwrap().to_string_lossy(),
                preview.is_some()
            );
            if let Some(preview) = preview {
                assert!(valid_cache(Path::new(&preview)));
            }
            count += 1;
        }
        assert!(count > 0);
    }
}
