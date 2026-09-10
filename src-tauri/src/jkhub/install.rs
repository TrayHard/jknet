//! Putting the pk3 files of a downloaded archive into a client.
//!
//! Three layouts came out of the three archives the research unpacked
//! (report, section 7), and no fourth one can be ruled out:
//!
//! * one pk3 next to a readme, at the root of the archive;
//! * everything wrapped in a folder, with `__MACOSX\` and `.DS_Store` next to
//!   it, left behind by an author on macOS;
//! * no pk3 at all — a config, a script and a readme, which is not something
//!   that can be installed in one click.
//!
//! So the rule is: take every `.pk3` at any depth, ignore `__MACOSX\` and
//! anything whose name starts with a dot, and when nothing is left say so
//! instead of installing an empty set.
//!
//! Twelve of the thirteen archives checked were `.zip` and the thirteenth was
//! a link to another site; `.rar` never appeared. It is refused by name
//! rather than half-supported: the only Rust readers for it wrap `unrar`,
//! whose licence forbids writing a competing compressor and is a question for
//! the user, not a decision to smuggle into a dependency list.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

use super::parse::MAX_ENTRY_PREVIEW;

/// Folder inside an archive that only exists on macOS and holds no content.
const MACOS_JUNK: &str = "__MACOSX";

/// One pk3 found inside an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pk3Entry {
    /// Path as the archive spells it, for the log and for the tests.
    pub path: String,
    /// The file name alone, which is what lands in the client.
    pub file_name: String,
}

/// What an archive turned out to hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveContents {
    pub pk3: Vec<Pk3Entry>,
    /// The first names inside, for the screen that has to explain why
    /// nothing was installed.
    pub preview: Vec<String>,
}

/// Reads the listing of an archive without extracting anything.
///
/// A bare `.pk3` is treated as an archive of one file: JKHub hosts mostly
/// zips, but nothing stops a record from being the pk3 itself.
pub fn read_archive(path: &Path) -> Result<ArchiveContents> {
    match extension(path).as_str() {
        "pk3" => {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file.pk3")
                .to_string();
            Ok(ArchiveContents {
                pk3: vec![Pk3Entry {
                    path: file_name.clone(),
                    file_name,
                }],
                preview: Vec::new(),
            })
        }
        "zip" => read_zip(path),
        "7z" => read_7z(path),
        "rar" => Err(AppError::ArchiveUnsupported {
            format: "rar".into(),
        }),
        other => Err(AppError::ArchiveUnsupported {
            format: other.to_string(),
        }),
    }
}

/// Extracts the chosen entries into `target`, overwriting only when told to.
///
/// Returns the names written. A name already taken is reported by
/// [`conflicts`] before this is called, so reaching an existing file here
/// means the caller passed `replace`.
pub fn extract(path: &Path, entries: &[Pk3Entry], target: &Path) -> Result<Vec<String>> {
    match extension(path).as_str() {
        "pk3" => {
            let name = &entries
                .first()
                .ok_or_else(|| AppError::Archive("nothing to install".into()))?
                .file_name;
            let destination = target.join(name);
            fs::copy(path, &destination)
                .map_err(|e| AppError::io_path("cannot copy into", &destination, e))?;
            Ok(vec![name.clone()])
        }
        "zip" => extract_zip(path, entries, target),
        "7z" => extract_7z(path, entries, target),
        other => Err(AppError::ArchiveUnsupported {
            format: other.to_string(),
        }),
    }
}

/// Names among `entries` that already exist in `target`.
pub fn conflicts(entries: &[Pk3Entry], target: &Path) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| {
            let file = target.join(&entry.file_name);
            // The library disables a file by renaming it, so a disabled copy
            // is a collision too: installing over it would leave two.
            file.exists() || target.join(format!("{}.disabled", entry.file_name)).exists()
        })
        .map(|entry| entry.file_name.clone())
        .collect()
}

/// Turns the listing into the error the screens name, when nothing is inside.
///
/// A separate function so the message and the structured answer are built
/// from the same list.
pub fn require_pk3(contents: &ArchiveContents) -> Result<&[Pk3Entry]> {
    if contents.pk3.is_empty() {
        return Err(AppError::NoPk3Files {
            entries: contents.preview.join(", "),
        });
    }
    Ok(&contents.pk3)
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

fn read_zip(path: &Path) -> Result<ArchiveContents> {
    let file = fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))?;
    let mut contents = ArchiveContents {
        pk3: Vec::new(),
        preview: Vec::new(),
    };
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        collect(entry.name(), &mut contents);
    }
    finish(contents)
}

fn extract_zip(path: &Path, entries: &[Pk3Entry], target: &Path) -> Result<Vec<String>> {
    let file = fs::File::open(path).map_err(|e| AppError::io_path("cannot open", path, e))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))?;
    let mut written = Vec::new();
    for entry in entries {
        let mut source = archive.by_name(&entry.path)?;
        let destination = target.join(&entry.file_name);
        let mut sink = fs::File::create(&destination)
            .map_err(|e| AppError::io_path("cannot create", &destination, e))?;
        std::io::copy(&mut source, &mut sink)
            .map_err(|e| AppError::io_path("cannot write", &destination, e))?;
        written.push(entry.file_name.clone());
    }
    Ok(written)
}

fn read_7z(path: &Path) -> Result<ArchiveContents> {
    let reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
        .map_err(seven_zip_error)?;
    let mut contents = ArchiveContents {
        pk3: Vec::new(),
        preview: Vec::new(),
    };
    for entry in reader.archive().files.clone() {
        if entry.is_directory {
            continue;
        }
        collect(&entry.name, &mut contents);
    }
    finish(contents)
}

fn extract_7z(path: &Path, entries: &[Pk3Entry], target: &Path) -> Result<Vec<String>> {
    let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
        .map_err(seven_zip_error)?;
    let mut written = Vec::new();
    // 7z entries share one compressed block, so the whole archive is walked
    // once and the wanted names are picked out of the walk.
    let wanted: Vec<Pk3Entry> = entries.to_vec();
    let mut failure: Option<AppError> = None;
    reader
        .for_each_entries(|entry, source| {
            let Some(wanted) = wanted.iter().find(|candidate| candidate.path == entry.name) else {
                return Ok(true);
            };
            let destination = target.join(&wanted.file_name);
            let mut buffer = Vec::new();
            if let Err(e) = source.read_to_end(&mut buffer) {
                failure = Some(AppError::io_path("cannot read from", path, e));
                return Ok(false);
            }
            if let Err(e) = fs::write(&destination, &buffer) {
                failure = Some(AppError::io_path("cannot write", &destination, e));
                return Ok(false);
            }
            written.push(wanted.file_name.clone());
            Ok(true)
        })
        .map_err(seven_zip_error)?;
    match failure {
        Some(e) => Err(e),
        None => Ok(written),
    }
}

fn seven_zip_error(e: sevenz_rust2::Error) -> AppError {
    AppError::Archive(format!("7z: {e}"))
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/// Sorts one entry name into the listing.
fn collect(name: &str, contents: &mut ArchiveContents) {
    let normalised = name.replace('\\', "/");
    if contents.preview.len() < MAX_ENTRY_PREVIEW {
        contents.preview.push(normalised.clone());
    }
    if skip(&normalised) {
        return;
    }
    let Some(file_name) = normalised.rsplit('/').next() else {
        return;
    };
    if !file_name.to_ascii_lowercase().ends_with(".pk3") {
        return;
    }
    contents.pk3.push(Pk3Entry {
        path: name.to_string(),
        file_name: file_name.to_string(),
    });
}

/// Whether an entry is one of the two kinds of junk an archive carries.
fn skip(path: &str) -> bool {
    path.split('/').any(|segment| {
        segment.eq_ignore_ascii_case(MACOS_JUNK) || segment.starts_with('.')
    })
}

/// Drops repeats and orders the result, so two runs install the same set.
fn finish(mut contents: ArchiveContents) -> Result<ArchiveContents> {
    contents
        .pk3
        .sort_by_key(|entry| entry.file_name.to_lowercase());
    contents
        .pk3
        .dedup_by(|a, b| a.file_name.eq_ignore_ascii_case(&b.file_name));
    Ok(contents)
}

/// Lowercase extension of a path, empty when there is none.
fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Where the files of one client live, creating the folder if needed.
pub fn target_folder(client_dir: &Path, folder: &str) -> Result<PathBuf> {
    let target = client_dir.join("home").join(folder);
    crate::paths::create_dir(&target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;

    /// Builds a zip with the given entries, stored rather than deflated so
    /// the test does not depend on the compressor.
    fn zip_with(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let file = fs::File::create(&path).expect("the archive is created");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (entry, bytes) in entries {
            writer.start_file(*entry, options).expect("an entry starts");
            writer.write_all(bytes).expect("the entry is written");
        }
        writer.finish().expect("the archive is closed");
        path
    }

    #[test]
    fn a_pk3_at_the_root_is_installed_under_its_own_name() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = zip_with(
            dir.path(),
            "saito_hajime.zip",
            &[("saitohajime.pk3", b"pk3"), ("Read Me.txt", b"text")],
        );
        let contents = read_archive(&archive).expect("the zip opens");
        assert_eq!(contents.pk3.len(), 1);
        assert_eq!(contents.pk3[0].file_name, "saitohajime.pk3");

        let target = dir.path().join("home").join("base");
        fs::create_dir_all(&target).expect("the target exists");
        let written = extract(&archive, &contents.pk3, &target).expect("it extracts");
        assert_eq!(written, vec!["saitohajime.pk3".to_string()]);
        assert_eq!(
            fs::read(target.join("saitohajime.pk3")).expect("the file is there"),
            b"pk3"
        );
    }

    #[test]
    fn a_pk3_in_a_folder_is_found_and_the_macos_copy_is_not() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = zip_with(
            dir.path(),
            "CircaZoomScript.zip",
            &[
                ("CircaZoomScript/autoexec.cfg", b"cfg"),
                ("CircaZoomScript/pack/nested.pk3", b"real"),
                ("__MACOSX/CircaZoomScript/pack/._nested.pk3", b"junk"),
                ("CircaZoomScript/.DS_Store", b"junk"),
                (".hidden.pk3", b"junk"),
            ],
        );
        let contents = read_archive(&archive).expect("the zip opens");
        assert_eq!(
            contents.pk3.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["CircaZoomScript/pack/nested.pk3"],
            "__MACOSX and dot files are junk, a nested pk3 is not"
        );

        let target = dir.path().join("target");
        fs::create_dir_all(&target).expect("the target exists");
        let written = extract(&archive, &contents.pk3, &target).expect("it extracts");
        assert_eq!(written, vec!["nested.pk3".to_string()]);
        assert_eq!(fs::read(target.join("nested.pk3")).expect("written"), b"real");
    }

    #[test]
    fn an_archive_without_a_pk3_names_what_is_inside_instead() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = zip_with(
            dir.path(),
            "SaberChanger.zip",
            &[
                ("README-SaberChanger.txt", b"text"),
                ("saberchanger.cfg", b"cfg"),
            ],
        );
        let contents = read_archive(&archive).expect("the zip opens");
        assert!(contents.pk3.is_empty());
        assert_eq!(
            contents.preview,
            vec![
                "README-SaberChanger.txt".to_string(),
                "saberchanger.cfg".to_string()
            ]
        );

        let error = require_pk3(&contents).expect_err("nothing to install");
        assert!(matches!(error, AppError::NoPk3Files { .. }), "{error}");
        assert!(error.to_string().contains("saberchanger.cfg"));
    }

    #[test]
    fn rar_is_refused_by_name_rather_than_half_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("skin.rar");
        fs::write(&path, b"Rar!").expect("a file");
        let error = read_archive(&path).expect_err("rar is out of scope");
        match error {
            AppError::ArchiveUnsupported { format } => assert_eq!(format, "rar"),
            other => panic!("{other}"),
        }
    }

    #[test]
    fn a_bare_pk3_is_its_own_archive() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("kyle.pk3");
        fs::write(&path, b"pk3").expect("a file");
        let contents = read_archive(&path).expect("a pk3 needs no unpacking");
        assert_eq!(contents.pk3[0].file_name, "kyle.pk3");

        let target = dir.path().join("target");
        fs::create_dir_all(&target).expect("the target exists");
        assert_eq!(
            extract(&path, &contents.pk3, &target).expect("it copies"),
            vec!["kyle.pk3".to_string()]
        );
    }

    #[test]
    fn a_name_already_taken_is_reported_before_anything_is_written() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let target = dir.path().join("base");
        fs::create_dir_all(&target).expect("the target exists");
        fs::write(target.join("taken.pk3"), b"old").expect("a file");
        fs::write(target.join("off.pk3.disabled"), b"old").expect("a disabled file");

        let entries = vec![
            Pk3Entry {
                path: "taken.pk3".into(),
                file_name: "taken.pk3".into(),
            },
            Pk3Entry {
                path: "off.pk3".into(),
                file_name: "off.pk3".into(),
            },
            Pk3Entry {
                path: "free.pk3".into(),
                file_name: "free.pk3".into(),
            },
        ];
        assert_eq!(
            conflicts(&entries, &target),
            vec!["taken.pk3".to_string(), "off.pk3".to_string()],
            "a disabled file still owns its name"
        );
    }

    #[test]
    fn the_same_name_twice_in_one_archive_is_installed_once() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = zip_with(
            dir.path(),
            "bundle.zip",
            &[("a/map.pk3", b"one"), ("b/map.pk3", b"two")],
        );
        let contents = read_archive(&archive).expect("the zip opens");
        assert_eq!(contents.pk3.len(), 1, "one name, one file in the client");
    }
}
