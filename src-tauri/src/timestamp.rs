//! A dependency-free UTC timestamp.
//!
//! The core stores `created_at` as an RFC 3339 string so a `client.json` stays
//! readable by hand. That is the only date handling the launcher needs, which
//! is not enough to justify a date-time crate.

use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Falls back to the Unix epoch if the system clock is set before 1970.
pub fn now_rfc3339() -> String {
    from_unix_seconds(now_unix())
}

/// Returns the current time as Unix seconds.
///
/// The release cache stores both this and the RFC 3339 string: the string is
/// what a human reads in the cache file, the number is what the freshness
/// check subtracts. Keeping both spares the core an RFC 3339 parser.
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Formats Unix seconds as an RFC 3339 string in UTC.
pub fn from_unix_seconds(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = time_of_day / 3_600;
    let minute = (time_of_day % 3_600) / 60;
    let second = time_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

// --- slice: play with friends ---
/// Reads an RFC 3339 time back into Unix seconds, or `None` for anything
/// else.
///
/// The relay API answers `expiresAt` in this form. Fractional seconds are
/// dropped and an offset other than `Z` is applied, which covers what a
/// service written in any language prints; a time before 1970 is refused.
pub fn parse_rfc3339(text: &str) -> Option<u64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', 't', ' '])?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Split the clock from the zone: `Z`, `+hh:mm` or `-hh:mm`.
    let (clock, offset_seconds) = if let Some(clock) = rest.strip_suffix(['Z', 'z']) {
        (clock, 0i64)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (clock, zone) = rest.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = zone[1..].split_once(':')?;
        let hours: i64 = hours.parse().ok()?;
        let minutes: i64 = minutes.parse().ok()?;
        (clock, sign * (hours * 3_600 + minutes * 60))
    };
    let clock = clock.split('.').next()?;
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts.next()?.parse().ok()?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds;
    u64::try_from(seconds).ok()
}

/// Converts a civil date into a count of days since 1970-01-01: the inverse
/// of [`civil_from_days`], Howard Hinnant's `days_from_civil`.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Converts a count of days since 1970-01-01 into a civil date.
///
/// Howard Hinnant's `civil_from_days`, the standard branch-free algorithm
/// behind `std::chrono`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153; // [0, 11], March is 0
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_unix_epoch() {
        assert_eq!(from_unix_seconds(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn formats_a_leap_day() {
        // 2024-02-29T12:34:56Z
        assert_eq!(from_unix_seconds(1_709_210_096), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn formats_a_recent_date() {
        // 2026-09-09T00:00:00Z
        assert_eq!(from_unix_seconds(1_788_912_000), "2026-09-09T00:00:00Z");
    }

    #[test]
    fn produces_a_fixed_width_string() {
        assert_eq!(now_rfc3339().len(), 20);
    }

    // --- slice: play with friends ---
    #[test]
    fn reads_back_what_it_writes_and_what_a_service_prints() {
        for seconds in [0, 1_709_210_096, 1_788_912_000, 1_790_373_600] {
            assert_eq!(parse_rfc3339(&from_unix_seconds(seconds)), Some(seconds));
        }
        // The expiry of the relay example in the plan: 2026-09-25T22:00:00Z.
        assert_eq!(parse_rfc3339("2026-09-25T22:00:00Z"), Some(1_790_373_600));
        // Fractions and offsets, which a service written elsewhere may print.
        assert_eq!(parse_rfc3339("2026-09-25T22:00:00.123456Z"), Some(1_790_373_600));
        assert_eq!(parse_rfc3339("2026-09-26T00:00:00+02:00"), Some(1_790_373_600));
        assert_eq!(parse_rfc3339("2026-09-25T20:30:00-01:30"), Some(1_790_373_600));
        for broken in ["", "2026-09-25", "2026-13-01T00:00:00Z", "yesterday", "1969-12-31T23:59:59Z"] {
            assert_eq!(parse_rfc3339(broken), None, "{broken}");
        }
    }
}
