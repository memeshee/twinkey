//! Substrate side of the verifier.
//!
//! History is read HERE, from the archive node: `chain_getBlockHash`,
//! `System.Events` via `state_getStorage` (through subxt's block-scoped events
//! API), `state_call` for the runtime address mapping. Nothing historical is
//! ever asked of the EVM endpoint.

use serde::Serialize;
use serde_json::{json, Value};
use subxt::{OnlineClient, PolkadotConfig};

use crate::error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct Chain {
    pub http_url: String,
    pub ws_url: String,
    http: reqwest::Client,
    client: OnlineClient<PolkadotConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviveEvent {
    pub index: u32,
    pub phase: String,
    pub pallet: String,
    pub variant: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    /// 0x-hex of the raw event payload (`data` field of ContractEmitted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// EVM log topics carried inside the event (0x-hex, 32 bytes each).
    pub topics: Vec<String>,
    /// Record-level topics (usually empty; kept for completeness).
    pub record_topics: Vec<String>,
    pub fields: Value,
    pub field_bytes: String,
    #[serde(skip)]
    pub data_bytes: Vec<u8>,
    #[serde(skip)]
    pub topic_bytes: Vec<Vec<u8>>,
}

impl Chain {
    pub async fn connect(http_url: String, http: reqwest::Client) -> Result<Self, String> {
        let ws_url = to_ws(&http_url);
        let client = OnlineClient::<PolkadotConfig>::from_insecure_url(&ws_url)
            .await
            .map_err(|e| format!("cannot connect to Substrate RPC {ws_url}: {e}"))?;
        Ok(Self { http_url, ws_url, http, client })
    }

    /// Raw JSON-RPC over HTTP. Used for everything except event decoding, where
    /// subxt gives us metadata-driven SCALE decoding for free.
    pub async fn rpc(&self, method: &str, params: Value) -> ApiResult<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let resp = self
            .http
            .post(&self.http_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| ApiError::upstream("substrate", format!("{method}: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::upstream("substrate", format!("{method}: body: {e}")))?;
        if !status.is_success() {
            return Err(ApiError::upstream(
                "substrate",
                format!("{method}: HTTP {status}: {}", truncate(&text, 300)),
            ));
        }
        let parsed: Value = serde_json::from_str(&text).map_err(|e| {
            ApiError::upstream(
                "substrate",
                format!("{method}: invalid JSON: {e}: {}", truncate(&text, 300)),
            )
        })?;
        if let Some(err) = parsed.get("error") {
            return Err(ApiError::upstream("substrate", format!("{method}: {err}")));
        }
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn chain_name(&self) -> ApiResult<String> {
        let v = self.rpc("system_chain", json!([])).await?;
        v.as_str()
            .map(str::to_string)
            .ok_or_else(|| ApiError::upstream("substrate", "system_chain: not a string"))
    }

    pub async fn header(&self) -> ApiResult<Value> {
        self.rpc("chain_getHeader", json!([])).await
    }

    pub async fn head_number(&self) -> ApiResult<u64> {
        let h = self.header().await?;
        let s = h
            .get("number")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::upstream("substrate", "chain_getHeader: no number"))?;
        parse_hex_u64(s)
            .ok_or_else(|| ApiError::upstream("substrate", format!("chain_getHeader: bad number {s}")))
    }

    pub async fn runtime_version(&self) -> ApiResult<Value> {
        self.rpc("state_getRuntimeVersion", json!([])).await
    }

    pub async fn block_hash(&self, number: u64) -> ApiResult<Option<String>> {
        let v = self.rpc("chain_getBlockHash", json!([number])).await?;
        Ok(v.as_str().map(str::to_string))
    }

    /// Runtime API call at `latest` (archive node, but this is current state).
    pub async fn state_call(&self, method: &str, data_hex: &str) -> ApiResult<Vec<u8>> {
        let v = self
            .rpc("state_call", json!([method, data_hex, null]))
            .await?;
        let s = v
            .as_str()
            .ok_or_else(|| ApiError::upstream("substrate", format!("state_call {method}: not a string")))?;
        hex::decode(s.trim_start_matches("0x"))
            .map_err(|e| ApiError::upstream("substrate", format!("state_call {method}: bad hex: {e}")))
    }

    /// The chain's own SS58 -> H160 mapping (`ReviveApi_address`). We never derive
    /// this locally: the mapping is not a truncation/hash of the public key.
    pub async fn revive_address(&self, account_id: &[u8; 32]) -> ApiResult<String> {
        let out = self
            .state_call("ReviveApi_address", &format!("0x{}", hex::encode(account_id)))
            .await?;
        if out.len() < 20 {
            return Err(ApiError::upstream(
                "substrate",
                format!("ReviveApi_address returned {} bytes, expected 20", out.len()),
            ));
        }
        Ok(format!("0x{}", hex::encode(&out[out.len() - 20..])))
    }

    /// Fetch every `Revive` event at `number` by reading System.Events at that
    /// block hash. Errors (missing block, RPC failure) bubble up as ApiError.
    pub async fn revive_events(&self, number: u64) -> ApiResult<(String, Vec<ReviveEvent>)> {
        let at = self
            .client
            .at_block(number)
            .await
            .map_err(|e| ApiError::upstream("substrate", format!("at_block({number}): {e}")))?;
        let block_hash = format!("0x{}", hex::encode(at.block_ref().hash().as_bytes()));

        let events = at
            .events()
            .fetch()
            .await
            .map_err(|e| ApiError::upstream("substrate", format!("events at {number}: {e}")))?;

        let mut out = Vec::new();
        for ev in events.iter() {
            let ev = ev.map_err(|e| {
                ApiError::upstream("substrate", format!("SCALE decode of event at {number}: {e}"))
            })?;
            // The pallet is named "Revive" in the runtime metadata (capital R).
            if !ev.pallet_name().eq_ignore_ascii_case("revive") {
                continue;
            }
            let variant = ev.event_name().to_string();
            let field_bytes = ev.field_bytes().to_vec();
            let record_topics: Vec<String> = ev
                .topics()
                .iter()
                .map(|t| format!("0x{}", hex::encode(t.as_bytes())))
                .collect();

            let mut ev_out = ReviveEvent {
                index: ev.index(),
                phase: format!("{:?}", ev.phase()),
                pallet: ev.pallet_name().to_string(),
                variant: variant.clone(),
                deployer: None,
                contract: None,
                data: None,
                topics: Vec::new(),
                record_topics,
                fields: json!({ "raw": format!("0x{}", hex::encode(&field_bytes)) }),
                field_bytes: format!("0x{}", hex::encode(&field_bytes)),
                data_bytes: Vec::new(),
                topic_bytes: Vec::new(),
            };

            match variant.as_str() {
                // Instantiated { deployer: H160, contract: H160 }
                "Instantiated" => {
                    if field_bytes.len() != 40 {
                        return Err(ApiError::upstream(
                            "substrate",
                            format!("Instantiated fields are {} bytes, expected 40", field_bytes.len()),
                        ));
                    }
                    let deployer = format!("0x{}", hex::encode(&field_bytes[0..20]));
                    let contract = format!("0x{}", hex::encode(&field_bytes[20..40]));
                    ev_out.deployer = Some(deployer.clone());
                    ev_out.contract = Some(contract.clone());
                    ev_out.fields = json!({ "deployer": deployer, "contract": contract });
                }
                // ContractEmitted { contract: H160, data: Vec<u8>, topics: Vec<H256> }
                "ContractEmitted" => {
                    let mut cur = Cursor::new(&field_bytes);
                    let contract = format!("0x{}", hex::encode(cur.take(20)?));
                    let data = cur.take_vec()?;
                    let topics = cur.take_h256_vec()?;
                    let topics_hex: Vec<String> =
                        topics.iter().map(|t| format!("0x{}", hex::encode(t))).collect();
                    ev_out.contract = Some(contract.clone());
                    ev_out.data = Some(format!("0x{}", hex::encode(&data)));
                    ev_out.topics = topics_hex.clone();
                    ev_out.data_bytes = data.clone();
                    ev_out.topic_bytes = topics.clone();
                    ev_out.fields = json!({
                        "contract": contract,
                        "data": format!("0x{}", hex::encode(&data)),
                        "topics": topics_hex,
                    });
                }
                // EthExtrinsicRevert { dispatch_error: DispatchError } - keep the raw
                // SCALE bytes; the variant name plus the bytes is the useful signal.
                other => {
                    ev_out.fields = json!({
                        "variant": other,
                        "raw": format!("0x{}", hex::encode(&field_bytes)),
                    });
                }
            }
            out.push(ev_out);
        }
        Ok((block_hash, out))
    }

    /// `chain_getBlock` by hash. Returns None when the hash is not a block.
    pub async fn block_by_hash(&self, hash: &str) -> ApiResult<Option<Value>> {
        let v = self.rpc("chain_getBlock", json!([hash])).await;
        match v {
            Ok(Value::Null) => Ok(None),
            Ok(v) => Ok(Some(v)),
            Err(e) => {
                // A well-formed 32-byte hash that is not a block comes back as an
                // RPC error on some nodes; treat "unknown block" as not-found and
                // anything else as an upstream failure.
                let s = format!("{e:?}");
                if s.to_lowercase().contains("unknown") {
                    Ok(None)
                } else {
                    Err(e)
                }
            }
        }
    }
}

/// SCALE cursor with bounds checks: malformed bytes become a 503, never a panic.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize) -> ApiResult<&'a [u8]> {
        if self.pos + n > self.bytes.len() {
            return Err(ApiError::upstream(
                "substrate",
                format!(
                    "SCALE decode overflow: need {n} bytes at offset {}, only {} left",
                    self.pos,
                    self.bytes.len().saturating_sub(self.pos)
                ),
            ));
        }
        let out = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn compact(&mut self) -> ApiResult<u64> {
        let first = self.take(1)?[0];
        match first & 0b11 {
            0 => Ok((first >> 2) as u64),
            1 => {
                let b = self.take(2)?;
                Ok((u16::from_le_bytes([b[0], b[1]]) >> 2) as u64)
            }
            2 => {
                let b = self.take(4)?;
                Ok((u32::from_le_bytes([b[0], b[1], b[2], b[3]]) >> 2) as u64)
            }
            _ => {
                let len = (first >> 2) as usize + 4;
                let b = self.take(len)?;
                let mut arr = [0u8; 8];
                if len > 8 {
                    return Err(ApiError::upstream("substrate", "SCALE compact length too large"));
                }
                arr[..len].copy_from_slice(b);
                Ok(u64::from_le_bytes(arr))
            }
        }
    }

    fn take_vec(&mut self) -> ApiResult<Vec<u8>> {
        let n = self.compact()? as usize;
        Ok(self.take(n)?.to_vec())
    }

    fn take_h256_vec(&mut self) -> ApiResult<Vec<Vec<u8>>> {
        let n = self.compact()? as usize;
        // Guard against a bogus length claiming gigabytes.
        if n > 1024 {
            return Err(ApiError::upstream(
                "substrate",
                format!("SCALE topics length {n} is implausible"),
            ));
        }
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.take(32)?.to_vec());
        }
        Ok(out)
    }
}

pub fn parse_hex_u64(s: &str) -> Option<u64> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()
}

/// subxt's RPC transport only speaks ws/wss; derive it from the http URL.
pub fn to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_string()
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}
