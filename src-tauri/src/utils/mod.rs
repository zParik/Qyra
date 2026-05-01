pub mod paths;
pub mod progress;

/// FNV-1a 64-bit hash — fast, non-cryptographic, collision-resistant enough
/// for cache keys and filename generation within a single session.
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Returns fnv1a(s) formatted as a zero-padded 16-character hex string.
pub fn fnv1a_hex(s: &str) -> String {
    format!("{:016x}", fnv1a(s))
}
