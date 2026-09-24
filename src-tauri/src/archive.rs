//! One walk over the entries of a zip archive, for everything that lists a
//! pk3: the report of a file of the library, the listing of a pk3 of a
//! bundle, the products of a preview session and the entry one of its
//! commands reads, and the limit the preview of the Library screen applies
//! before it reads an archive.
//!
//! A pk3 is a zip, and its central directory says what is inside without
//! decompressing anything. `zip::ZipArchive::new` reads that directory
//! whole; what this module bounds is everything after it: the names kept,
//! the sizes read, and the local headers seeked to. A walk hands out at most
//! `limit` file entries and stops there, so an archive that declares a
//! million entries costs a million names parsed by the zip crate and no
//! more.
//!
//! Every walk leaves folders out, spells the path with forward slashes and
//! keeps the order of the central directory: the caller sorts if it needs
//! to.

use std::io::{Read, Seek};

use zip::ZipArchive;

use crate::error::Result;

/// File entries one walk hands out at most: the limit of the preview of the
/// Library screen, of the listing of a pk3 of a bundle and of the report of
/// a file of the library, which read the same archives.
pub const MAX_ENTRIES: usize = 50_000;

/// One file entry of an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The path inside the archive, forward slashes.
    pub path: String,
    /// Uncompressed bytes, as the central directory declares them.
    pub size: u64,
}

/// The path of an entry as a walk spells it, or `None` for a folder or an
/// entry without a name.
fn file_path(name: &str) -> Option<String> {
    let path = name.replace('\\', "/");
    if path.is_empty() || path.ends_with('/') {
        return None;
    }
    Some(path)
}

/// The index and path of the first `limit` file entries, in the order of
/// the central directory, one at a time: a caller that looks for one entry
/// stops at it. Reads nothing past the directory the archive was opened
/// with.
pub fn walk<R: Read + Seek>(
    archive: &ZipArchive<R>,
    limit: usize,
) -> impl Iterator<Item = (usize, String)> + '_ {
    (0..archive.len())
        .filter_map(move |index| {
            archive
                .name_for_index(index)
                .and_then(file_path)
                .map(|path| (index, path))
        })
        .take(limit)
}

/// The paths of the first `limit` file entries. No seek in the archive:
/// what a report that only classifies an archive needs.
pub fn names<R: Read + Seek>(archive: &ZipArchive<R>, limit: usize) -> Vec<String> {
    walk(archive, limit).map(|(_, path)| path).collect()
}

/// The first `limit` file entries with their sizes. Reads the local header
/// of each entry it hands out and of no other: what a listing needs.
pub fn entries<R: Read + Seek>(archive: &mut ZipArchive<R>, limit: usize) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let found: Vec<_> = walk(archive, limit).collect();
    for (index, path) in found {
        let entry = archive.by_index_raw(index)?;
        entries.push(Entry {
            path,
            size: entry.size(),
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use super::*;

    fn archive(entries: &[(&str, &[u8])]) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut bytes = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut bytes));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, body) in entries {
                if name.ends_with('/') {
                    writer.add_directory(name.trim_end_matches('/'), options).expect("a folder");
                    continue;
                }
                writer.start_file(*name, options).expect("an entry starts");
                writer.write_all(body).expect("the entry is written");
            }
            writer.finish().expect("the archive is closed");
        }
        ZipArchive::new(Cursor::new(bytes)).expect("the archive opens")
    }

    #[test]
    fn a_walk_leaves_folders_out_and_stops_at_its_limit() {
        let mut zip = archive(&[
            ("models/players/reborn/", b"" as &[u8]),
            ("models\\players\\reborn\\model.glm", b"geometry"),
            ("sound/taunt.mp3", b"taunt taunt"),
            ("README.txt", b"read me"),
            ("levelshots/", b""),
            ("maps/duel.bsp", b"map"),
        ]);
        assert_eq!(zip.len(), 6, "folders count in the archive");
        assert_eq!(
            names(&zip, MAX_ENTRIES),
            ["models/players/reborn/model.glm", "sound/taunt.mp3", "README.txt", "maps/duel.bsp"]
        );
        // The walk keeps the index of the central directory next to the path.
        assert_eq!(walk(&zip, MAX_ENTRIES).map(|(index, _)| index).collect::<Vec<_>>(), [1, 2, 3, 5]);
        assert_eq!(walk(&zip, MAX_ENTRIES).find(|(_, path)| path == "README.txt"), Some((3, "README.txt".to_string())));
        let all = entries(&mut zip, MAX_ENTRIES).expect("the entries read");
        assert_eq!(all.len(), 4);
        assert_eq!(all[0].path, "models/players/reborn/model.glm");
        assert_eq!(all[0].size, 8);
        assert_eq!(all[3], Entry { path: "maps/duel.bsp".into(), size: 3 });

        // The limit counts files, not folders, and the walk stops there.
        assert_eq!(names(&zip, 2), ["models/players/reborn/model.glm", "sound/taunt.mp3"]);
        let two = entries(&mut zip, 2).expect("two entries");
        assert_eq!(two.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(), ["models/players/reborn/model.glm", "sound/taunt.mp3"]);
        assert!(names(&zip, 0).is_empty());
        assert!(entries(&mut zip, 0).unwrap().is_empty());
    }
}
