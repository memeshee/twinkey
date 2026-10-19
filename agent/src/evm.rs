//! EVM JSON-RPC client.
//!
//! DESIGN CONSTRAINT, and the reason this file only ever asks for "latest":
//! the EVM endpoint is NOT archival. `eth_call` / `eth_getBlockByNumber` at a
//! historical block fail with
//!
//!     UnknownBlock: State already discarded
//!
//! for anything older than roughly the last 256 blocks. History therefore comes
//! from the Substrate RPC (a full archive node) via System.Events, and the EVM
//! RPC is only ever asked about `latest`.

use serde_json::{json, Value};

use crate::abi::{self, ReadResult};
use crate::error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct Evm {
    pub url: String,
    http: reqwest::Client,
}

impl Evm {
    pub fn new(url: String, http: reqwest::Client) -> Self {
        Self { url, http }
    }

    async fn call(&self, method: &str, params: Value) -> ApiResult<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let resp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| ApiError::upstream("evm", format!("{method}: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::upstream("evm", format!("{method}: reading body: {e}")))?;

        if !status.is_success() {
            return Err(ApiError::upstream(
                "evm",
                format!("{method}: HTTP {status}: {}", truncate(&text, 300)),
            ));
        }

        let parsed: Value = serde_json::from_str(&text).map_err(|e| {
            ApiError::upstream("evm", format!("{method}: invalid JSON: {e}: {}", truncate(&text, 300)))
        })?;

        if let Some(err) = parsed.get("error") {
            return Err(ApiError::upstream("evm", format!("{method}: {err}")));
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| ApiError::upstream("evm", format!("{method}: response has no result")))
    }

    /// `eth_getCode` at latest. Returns the runtime bytecode as hex (0x-prefixed).
    pub async fn code(&self, address: &str) -> ApiResult<String> {
        let v = self.call("eth_getCode", json!([address, "latest"])).await?;
        v.as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| ApiError::upstream("evm", "eth_getCode: result is not a string"))
    }

    /// `eth_call read()` at latest. `Ok(None)` means the call reverted (a valid
    /// EVM answer, not an RPC failure); `Err` means the endpoint itself failed.
    pub async fn read_probe(&self, address: &str) -> ApiResult<Option<ReadResult>> {
        let call = json!({
            "to": address,
            "data": format!("0x{}", abi::READ_SELECTOR)
        });
        let v = match self.call("eth_call", json!([call, "latest"])).await {
            Ok(v) => v,
            Err(e) => {
                // A revert is reported by the node as a JSON-RPC error (-32000 /
                // execution reverted). Keep it as a per-contract observation.
                let msg = format!("{e:?}");
                if msg.contains("revert") || msg.contains("execution") {
                    return Ok(None);
                }
                return Err(e);
            }
        };
        let hex_str = v
            .as_str()
            .ok_or_else(|| ApiError::upstream("evm", "eth_call: result is not a string"))?;
        let bytes = hex::decode(hex_str.trim_start_matches("0x"))
            .map_err(|e| ApiError::upstream("evm", format!("eth_call: bad hex: {e}")))?;
        abi::decode_read(&bytes)
            .map(Some)
            .map_err(|e| ApiError::upstream("evm", format!("eth_call: {e}")))
    }

    pub async fn block_number(&self) -> ApiResult<u64> {
        let v = self.call("eth_blockNumber", json!([])).await?;
        let s = v
            .as_str()
            .ok_or_else(|| ApiError::upstream("evm", "eth_blockNumber: result is not a string"))?;
        u64::from_str_radix(s.trim_start_matches("0x"), 16)
            .map_err(|e| ApiError::upstream("evm", format!("eth_blockNumber: {e}")))
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}
