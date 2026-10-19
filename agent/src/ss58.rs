//! SS58 decoding (prefix 42 / any single-byte prefix) with checksum verification.
//!
//! We only need the 32-byte account id, but we verify the two-byte blake2b-512
//! checksum so a typo in the configured signer address is reported instead of
//! silently producing a wrong H160 comparison.

use blake2::{digest::consts::U64, Blake2b, Digest};

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_PREFIX: &[u8] = b"SS58PRE";

fn base58_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::new(); // big-endian accumulator
    for ch in s.bytes() {
        let val = ALPHABET
            .iter()
            .position(|c| *c == ch)
            .ok_or_else(|| format!("invalid base58 character '{}'", ch as char))?
            as u32;
        let mut carry = val;
        for b in bytes.iter_mut().rev() {
            let cur = (*b as u32) * 58 + carry;
            *b = (cur & 0xff) as u8;
            carry = cur >> 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // Leading '1's are leading zero bytes.
    let leading_ones = s.bytes().take_while(|c| *c == b'1').count();
    let mut out = vec![0u8; leading_ones];
    out.extend(bytes);
    Ok(out)
}

/// Decode an SS58 address into its 32-byte account id.
pub fn decode_account_id(ss58: &str) -> Result<[u8; 32], String> {
    let data = base58_decode(ss58)?;
    if data.len() < 3 {
        return Err("address too short".into());
    }
    // Single-byte network prefix (42 for Portaldot). Two-byte prefixes encode
    // values >= 64; reject those explicitly rather than mis-slicing.
    if data[0] >= 64 {
        return Err("two-byte SS58 prefixes are not supported".into());
    }
    if data.len() != 1 + 32 + 2 {
        return Err(format!(
            "expected 35 decoded bytes for a 32-byte account, got {}",
            data.len()
        ));
    }
    let payload = &data[..data.len() - 2];
    let checksum = &data[data.len() - 2..];

    let mut hasher = Blake2b::<U64>::new();
    hasher.update(SS58_PREFIX);
    hasher.update(payload);
    let hash = hasher.finalize();
    if &hash[..2] != checksum {
        return Err("SS58 checksum mismatch".into());
    }

    let mut id = [0u8; 32];
    id.copy_from_slice(&payload[1..33]);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_twinkey_account() {
        let id = decode_account_id("5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7").unwrap();
        assert_eq!(
            hex::encode(id),
            "38eb74935dffbc867c2fbeeac7170156b76f17c6aa1c382535125329ddb42133"
        );
    }

    #[test]
    fn rejects_bad_checksum() {
        assert!(decode_account_id("5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C8").is_err());
    }
}
