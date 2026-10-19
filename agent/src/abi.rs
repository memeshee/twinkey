//! TwinKeyProbe ABI: just the two events and the `read()` tuple we need.
//!
//!     event ValueSet(address indexed caller, uint256 indexed value, uint256 callCount)
//!     event ValueAdded(address indexed caller, uint256 amount, uint256 newValue)
//!     function read() external view returns (uint256 value, address lastCaller, uint256 callCount)

use serde::Serialize;

pub const VALUE_SET_TOPIC: &str =
    "c0e9036d619701c94569e1462d8120ef4a6d2b15a70d27cc942fd29ae2cc0e59";
pub const VALUE_ADDED_TOPIC: &str =
    "804c807c54b57d3c86f6030ac7bf3c3488e8b77f71bf64d3c9284d6b91fe27e1";
pub const READ_SELECTOR: &str = "57de26a4";

#[derive(Debug, Clone, Serialize)]
pub struct DecodedLog {
    /// "ValueSet" | "ValueAdded"
    pub event: &'static str,
    pub signature: &'static str,
    pub caller: String,
    pub value: Option<String>,
    pub amount: Option<String>,
    pub new_value: Option<String>,
    pub call_count: Option<String>,
}

/// Strip 0x and return the 20-byte address encoded in a 32-byte topic word.
pub fn topic_address(topic: &[u8]) -> String {
    let start = topic.len().saturating_sub(20);
    format!("0x{}", hex::encode(&topic[start..]))
}

/// Decimal string for a 32-byte big-endian unsigned integer (no bigint crate needed).
pub fn u256_dec(bytes: &[u8]) -> String {
    let mut n = bytes.to_vec();
    // Trim leading zeros for iteration efficiency; keep at least one byte.
    while n.len() > 1 && n[0] == 0 {
        n.remove(0);
    }
    let mut digits: Vec<u8> = Vec::new();
    loop {
        let mut rem: u32 = 0;
        let mut all_zero = true;
        for b in n.iter_mut() {
            let cur = (rem << 8) | (*b as u32);
            *b = (cur / 10) as u8;
            rem = cur % 10;
            if *b != 0 {
                all_zero = false;
            }
        }
        digits.push(rem as u8);
        if all_zero {
            break;
        }
    }
    digits.iter().rev().map(|d| (b'0' + d) as char).collect()
}

fn hex_addr(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Decode a TwinKeyProbe log given its EVM topics (hex strings without 0x) and data bytes.
pub fn decode_log(topics: &[Vec<u8>], data: &[u8]) -> Result<DecodedLog, String> {
    if topics.is_empty() {
        return Err("event has no topics; cannot match the TwinKeyProbe ABI".into());
    }
    let topic0 = hex::encode(&topics[0]);
    match topic0.as_str() {
        VALUE_SET_TOPIC => {
            if topics.len() != 3 {
                return Err(format!("ValueSet expects 3 topics, got {}", topics.len()));
            }
            if data.len() != 32 {
                return Err(format!("ValueSet expects 32 data bytes, got {}", data.len()));
            }
            Ok(DecodedLog {
                event: "ValueSet",
                signature: "ValueSet(address indexed caller, uint256 indexed value, uint256 callCount)",
                caller: topic_address(&topics[1]),
                value: Some(u256_dec(&topics[2])),
                amount: None,
                new_value: None,
                call_count: Some(u256_dec(data)),
            })
        }
        VALUE_ADDED_TOPIC => {
            if topics.len() != 2 {
                return Err(format!("ValueAdded expects 2 topics, got {}", topics.len()));
            }
            if data.len() != 64 {
                return Err(format!("ValueAdded expects 64 data bytes, got {}", data.len()));
            }
            Ok(DecodedLog {
                event: "ValueAdded",
                signature: "ValueAdded(address indexed caller, uint256 amount, uint256 newValue)",
                caller: topic_address(&topics[1]),
                value: None,
                amount: Some(u256_dec(&data[..32])),
                new_value: Some(u256_dec(&data[32..])),
                call_count: None,
            })
        }
        other => Err(format!("topic0 0x{other} is not a TwinKeyProbe event")),
    }
}

/// The three words returned by `read()`.
#[derive(Debug, Clone, Serialize)]
pub struct ReadResult {
    pub value: String,
    pub value_hex: String,
    pub last_caller: String,
    pub call_count: String,
    pub raw: String,
}

pub fn decode_read(ret: &[u8]) -> Result<ReadResult, String> {
    if ret.len() < 96 {
        return Err(format!(
            "read() returned {} bytes, expected 96 (uint256,address,uint256)",
            ret.len()
        ));
    }
    Ok(ReadResult {
        value: u256_dec(&ret[0..32]),
        value_hex: format!("0x{}", hex::encode(&ret[0..32])),
        last_caller: hex_addr(&ret[44..64]),
        call_count: u256_dec(&ret[64..96]),
        raw: format!("0x{}", hex::encode(&ret[..96])),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u256_decimal() {
        assert_eq!(u256_dec(&[0u8; 32]), "0");
        let mut w = [0u8; 32];
        w[31] = 42;
        assert_eq!(u256_dec(&w), "42");
        assert_eq!(
            u256_dec(&hex::decode("00000000000000000000000000000000000000000000000000000000000f4240").unwrap()),
            "1000000"
        );
    }

    #[test]
    fn decodes_value_set() {
        let topics = vec![
            hex::decode(VALUE_SET_TOPIC).unwrap(),
            hex::decode("000000000000000000000000e70fd7e24a9eee0d3a7302866e0e1e9597f4d934").unwrap(),
            hex::decode("000000000000000000000000000000000000000000000000000000000000002a").unwrap(),
        ];
        let data = hex::decode("0000000000000000000000000000000000000000000000000000000000000001").unwrap();
        let log = decode_log(&topics, &data).unwrap();
        assert_eq!(log.event, "ValueSet");
        assert_eq!(log.caller, "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934");
        assert_eq!(log.value.as_deref(), Some("42"));
        assert_eq!(log.call_count.as_deref(), Some("1"));
    }
}
