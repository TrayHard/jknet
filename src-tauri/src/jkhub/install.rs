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
//!
//! One more rule, and the strictest of them: the name of an archive entry
//! never decides where a file lands. Only its last segment does, and only
//! when that segment is a plain file name — see [`entry_file_name`] and
//! [`destination`]. Everything the site hands out is written by a member of
//! the community and moderated by nobody, so an entry name is a string from a
//! stranger.

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
            let destination = destination(target, name)?;
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
            // A name [`destination`] refuses is not a collision: nothing can
            // be installed under it, and `extract` says so with an error.
            let Ok(file) = destination(target, &entry.file_name) else {
                return false;
            };
            // The library disables a file by renaming it, so a disabled copy
            // is a collision too: installing over it would leave two.
            let disabled = file.with_file_name(format!("{}.disabled", entry.file_name));
            file.exists() || disabled.exists()
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
        let destination = destination(target, &entry.file_name)?;
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
            // The same rule as the zip path: a 7z entry name is a string from
            // a stranger too, and this is the only place it becomes a path.
            let destination = match destination(target, &wanted.file_name) {
                Ok(destination) => destination,
                Err(e) => {
                    failure = Some(e);
                    return Ok(false);
                }
            };
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
    let Some(file_name) = entry_file_name(name) else {
        log::debug!("jkhub: the archive entry {name} is not installable under its own name");
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
///
/// `.` and `..` are not junk: they are an attempt at walking out of the
/// archive, not a hidden file, and since the rule below keeps nothing but the
/// last segment they cost the destination nothing. Dropping the entry would
/// only lose a pk3 the player asked for.
fn skip(path: &str) -> bool {
    path.split('/').any(|segment| {
        segment.eq_ignore_ascii_case(MACOS_JUNK)
            || (segment.starts_with('.') && segment != "." && segment != "..")
    })
}

/// The name an archive entry may be installed under, if any.
///
/// Review finding (High, `review-jkhub-switch.md`): an entry name is a string
/// from a stranger's archive, and on Windows one of them can take over the
/// whole destination. `Path::join` treats a drive-relative component as a
/// fresh start, so
///
/// ```text
/// "…\clients\everyday\home\base".join("evil.pk3")   = "…\home\base\evil.pk3"
/// "…\clients\everyday\home\base".join("C:evil.pk3") = "C:evil.pk3"
/// ```
///
/// and the second path resolves against whatever the current directory of
/// drive `C:` happens to be — a place neither the launcher nor the player
/// chose. The old rule split on `/` alone, so `C:evil.pk3` (a drive letter
/// with no separator after it) passed as a file name.
///
/// The rule now: split on both separators, take the last segment, and accept
/// it only when it is a plain file name.
fn entry_file_name(entry: &str) -> Option<&str> {
    // Both separators, because a zip written on Windows spells its paths with
    // `\` and the format does not forbid it.
    let last = entry.rsplit(['/', '\\']).next()?;
    is_plain_file_name(last).then_some(last)
}

/// Whether a name names a file and nothing else.
///
/// Deliberately narrow: `*?"<>|` are left out only because Windows refuses
/// them at `File::create` anyway, while everything here would otherwise be
/// accepted by the filesystem and mean something other than what it says.
fn is_plain_file_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    // A separator or a drive letter turns the name back into a path; a NUL
    // and its fellow control characters end it early for whatever reads it.
    if name.contains([':', '/', '\\']) || name.chars().any(char::is_control) {
        return false;
    }
    // Windows silently trims these, so `evil.pk3 ` and `evil.pk3` would be the
    // same file under two names, and `kyle.pk3.` would install as `kyle.pk3`.
    if name.starts_with([' ', '.']) || name.ends_with([' ', '.']) {
        return false;
    }
    !is_reserved_device(name)
}

/// The DOS device names Windows still answers to, with or without extension.
///
/// `CON.pk3` opens the console rather than a file, and `LPT1.pk3` a printer
/// port, so a name like either never reaches `File::create`.
fn is_reserved_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default();
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return true;
    }
    // COM1..COM9 and LPT1..LPT9. The fourth byte is checked before the name is
    // split there, and an ASCII digit is always a character boundary, so a
    // name of four bytes that is not four characters cannot panic here.
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && matches!(bytes[3], b'1'..=b'9')
        && (stem[..3].eq_ignore_ascii_case("COM") || stem[..3].eq_ignore_ascii_case("LPT"))
}

/// The one place an entry name becomes a path on disk.
///
/// Three checks: the name is a plain file name, the join left the file in
/// `target`, and the folder the file would land in is still the client's own
/// once the filesystem has had its say. The first refuses everything known to
/// escape; the other two are defence in depth, and they are what would catch
/// the next trick nobody has thought of.
fn destination(target: &Path, file_name: &str) -> Result<PathBuf> {
    if !is_plain_file_name(file_name) {
        return Err(AppError::Archive(format!(
            "{file_name} is not a plain file name, so nothing was installed under it"
        )));
    }
    let destination = PathBuf::from(target).join(file_name);
    if destination.parent() != Some(target) {
        return Err(AppError::Archive(format!(
            "{file_name} would install outside {}",
            target.display()
        )));
    }
    let escaped = matches!(
        (destination.parent().map(Path::canonicalize), target.canonicalize()),
        (Some(Ok(parent)), Ok(root)) if !parent.starts_with(&root)
    );
    if escaped {
        return Err(AppError::Archive(format!(
            "{file_name} would install outside {}",
            target.display()
        )));
    }
    Ok(destination)
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

    /// Review finding (High): the entry name decides nothing but the file
    /// name, and only when that name is a plain one.
    #[test]
    fn an_entry_name_is_reduced_to_its_last_segment_or_refused() {
        // The finding itself: a drive letter with no separator after it used
        // to pass whole, and `Path::join` would then drop the client folder.
        assert_eq!(entry_file_name("C:file.pk3"), None);
        assert_eq!(entry_file_name("c:file.pk3"), None);
        // A drive letter with a path after it keeps only the last segment.
        assert_eq!(entry_file_name(r"C:\x\y.pk3"), Some("y.pk3"));
        assert_eq!(entry_file_name(r"\\server\share\z.pk3"), Some("z.pk3"));
        assert_eq!(entry_file_name(r"..\z.pk3"), Some("z.pk3"));
        assert_eq!(entry_file_name("dir/../z.pk3"), Some("z.pk3"));
        assert_eq!(entry_file_name("maps/foo.pk3"), Some("foo.pk3"));
        assert_eq!(entry_file_name("plain.pk3"), Some("plain.pk3"));
        // Nothing left after the last separator, and the two names that mean
        // a folder rather than a file.
        assert_eq!(entry_file_name("maps/"), None);
        assert_eq!(entry_file_name(".."), None);
        assert_eq!(entry_file_name("."), None);
        // Windows trims a trailing space or dot, so two names would collide.
        assert_eq!(entry_file_name("evil.pk3 "), None);
        assert_eq!(entry_file_name("evil.pk3."), None);
        assert_eq!(entry_file_name(" evil.pk3"), None);
        // A NUL ends the name early for whatever reads it next.
        assert_eq!(entry_file_name("evil\0.pk3"), None);
        // Device names, which open a device instead of creating a file.
        assert_eq!(entry_file_name("CON.pk3"), None);
        assert_eq!(entry_file_name("nul.pk3"), None);
        assert_eq!(entry_file_name("com1.pk3"), None);
        assert_eq!(entry_file_name("LPT9.pk3"), None);
        // …and the names that only look like one.
        assert_eq!(entry_file_name("COM0.pk3"), Some("COM0.pk3"));
        assert_eq!(entry_file_name("CONSOLE.pk3"), Some("CONSOLE.pk3"));
        assert_eq!(entry_file_name("сом1.pk3"), Some("сом1.pk3"), "Cyrillic");
    }

    #[test]
    fn a_hand_made_entry_cannot_escape_the_client_either() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let target = dir.path().join("home").join("base");
        fs::create_dir_all(&target).expect("the target exists");
        let source = dir.path().join("kyle.pk3");
        fs::write(&source, b"pk3").expect("a file");

        // `collect` never produces such an entry; `destination` is what makes
        // that impossible to work around from anywhere else in the module.
        for name in ["C:evil.pk3", r"..\evil.pk3", "CON.pk3", "sub/evil.pk3"] {
            let entries = vec![Pk3Entry {
                path: name.into(),
                file_name: name.into(),
            }];
            let error = extract(&source, &entries, &target).expect_err(name);
            assert!(matches!(error, AppError::Archive(_)), "{name}: {error}");
            assert!(conflicts(&entries, &target).is_empty(), "{name}");
        }
        assert_eq!(
            fs::read_dir(&target).expect("the folder is readable").count(),
            0,
            "nothing was written"
        );
    }

    #[test]
    fn a_drive_relative_entry_name_cannot_take_over_the_destination() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let archive = zip_with(
            dir.path(),
            "evil.zip",
            &[
                ("C:evil.pk3", b"drive relative"),
                (r"C:\dir\drive.pk3", b"drive"),
                (r"..\parent.pk3", b"parent"),
                ("sub/../up.pk3", b"up"),
                ("__MACOSX/mac.pk3", b"junk"),
                ("CON.pk3", b"device"),
                ("maps/foo.pk3", b"map"),
            ],
        );
        let contents = read_archive(&archive).expect("the zip opens");
        assert_eq!(
            contents
                .pk3
                .iter()
                .map(|entry| entry.file_name.as_str())
                .collect::<Vec<_>>(),
            vec!["drive.pk3", "foo.pk3", "parent.pk3", "up.pk3"],
            "only the last segment survives, and only when it is a file name"
        );

        let target = dir.path().join("home").join("base");
        fs::create_dir_all(&target).expect("the target exists");
        let mut written = extract(&archive, &contents.pk3, &target).expect("it extracts");
        written.sort();
        assert_eq!(written, ["drive.pk3", "foo.pk3", "parent.pk3", "up.pk3"]);

        let mut landed: Vec<String> = fs::read_dir(&target)
            .expect("the folder is readable")
            .map(|entry| entry.expect("an entry").file_name().to_string_lossy().to_string())
            .collect();
        landed.sort();
        assert_eq!(landed, ["drive.pk3", "foo.pk3", "parent.pk3", "up.pk3"]);
        assert_eq!(fs::read(target.join("up.pk3")).expect("written"), b"up");
        // Nothing walked up to the client folder, to its parent, or anywhere
        // else the archive tried to name.
        for stray in ["evil.pk3", "parent.pk3", "mac.pk3", "CON.pk3"] {
            assert!(!dir.path().join(stray).exists(), "{stray} in the temp root");
            assert!(
                !dir.path().join("home").join(stray).exists(),
                "{stray} beside the target"
            );
        }
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
