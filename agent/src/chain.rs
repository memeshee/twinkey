//! Substrate side of the verifier.
//!
//! History is read HERE, from the archive node: `chain_getBlockHash`,
//! `System.Events` via `state_getStorage` (through subxt's block-scoped events
//! API), `state_call` for the runtime address mapping. Nothing historical is
//! ever asked of the EVM endpoint.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use subxt::{
    backend::LegacyBackend,
    rpcs::RpcClient,
    utils::H256,
    OnlineClient, OnlineClientAtBlock, PolkadotConfig,
};
use tokio::sync::Mutex;

use crate::error::{ApiError, ApiResult};

/// What this host is told the node can do, captured once at startup.
///
/// subxt's default (`CombinedBackend`) chooses the chainHead backend as soon as
/// the node lists `chainHead_v1_*` — and chainHead cannot turn a block *number*
/// into a hash. That choice is made from the method list the node returns to
/// *this* machine, so it is not a property of the source code: a hosted egress
/// can be handed a different list than a laptop, which is exactly how the
/// verifier worked locally and failed on Render with
/// "The ChainHead V1 RPCs do not support obtaining a block hash from a number".
/// Recorded here so `/health` can show it instead of making us guess.
#[derive(Debug, Clone, Serialize)]
pub struct RpcMethods {
    pub count: usize,
    pub has_archive_v1: bool,
    pub has_chain_head_v1: bool,
    pub has_chain_get_block_hash: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for RpcMethods {
    fn default() -> Self {
        Self {
            count: 0,
            has_archive_v1: false,
            has_chain_head_v1: false,
            has_chain_get_block_hash: false,
            error: None,
        }
    }
}

/// How long a websocket client is reused before it is rebuilt from scratch.
///
/// The node closes idle websockets on its own schedule. The previous build held
/// one `OnlineClient` for the lifetime of the process; when the node dropped the
/// socket, every later read failed with "The background task closed connection
/// closed; restart required" and the process — still answering `/health` from
/// memory — never recovered. A judge clicking the parity pane then got a 503
/// from a service that looked alive. Rebuilding on a timer, and once more on the
/// first error, makes a dead socket a ~1 s hiccup instead of a permanent outage.
const CLIENT_TTL: Duration = Duration::from_secs(240);

struct ClientSlot {
    client: OnlineClient<PolkadotConfig>,
    backend: String,
    backend_error: Option<String>,
    built_at: Instant,
    /// Number of rebuilds since start: visible in `/ready`, so "it recovered" is
    /// an observable fact rather than a claim.
    rebuilds: u64,
}

#[derive(Clone)]
pub struct Chain {
    pub http_url: String,
    pub ws_url: String,
    /// Which subxt backend/transport was chosen at startup ("legacy/WS", ...).
    pub backend: String,
    /// Why the preferred (legacy/HTTP) transport was not used, if it was not.
    pub backend_error: Option<String>,
    pub methods: RpcMethods,
    http: reqwest::Client,
    slot: Arc<Mutex<ClientSlot>>,
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
        let methods = probe_methods(&http_url, &http).await;

        // Pin the backend instead of letting subxt autodetect it. subxt's default
        // (CombinedBackend) picks chainHead whenever the node lists
        // chainHead_v1_*, and chainHead answers `block_number_to_hash` with an
        // error rather than falling back — so on a host where the archive
        // backend is unavailable every historical read dies. The legacy backend
        // needs nothing but plain JSON-RPC and is identical on every host; the
        // combined one is kept as a fallback only, and `revive_events` never asks
        // either of them to map a number to a hash.
        let (client, backend, backend_error) = build_any(&ws_url).await?;
        let slot = ClientSlot {
            client,
            backend: backend.clone(),
            backend_error: backend_error.clone(),
            built_at: Instant::now(),
            rebuilds: 0,
        };
        Ok(Self {
            http_url,
            ws_url,
            backend,
            backend_error,
            methods,
            http,
            slot: Arc::new(Mutex::new(slot)),
        })
    }

    /// A client that is worth using: rebuilt if it is older than `CLIENT_TTL`.
    pub async fn client(&self) -> ApiResult<OnlineClient<PolkadotConfig>> {
        let fresh = {
            let slot = self.slot.lock().await;
            if slot.built_at.elapsed() < CLIENT_TTL {
                Some(slot.client.clone())
            } else {
                None
            }
        };
        match fresh {
            Some(c) => Ok(c),
            None => self.rebuild().await,
        }
    }

    /// Throw the current client away and connect again. Any error here is a real
    /// upstream outage: the caller surfaces it instead of pretending.
    pub async fn rebuild(&self) -> ApiResult<OnlineClient<PolkadotConfig>> {
        let (client, backend, backend_error) = build_any(&self.ws_url).await.map_err(|e| {
            ApiError::upstream("substrate", format!("reconnecting to {}: {e}", self.ws_url))
        })?;
        let mut slot = self.slot.lock().await;
        slot.client = client.clone();
        slot.backend = backend;
        slot.backend_error = backend_error;
        slot.built_at = Instant::now();
        slot.rebuilds += 1;
        Ok(client)
    }

    /// `(backend, age_seconds, rebuilds)` — what the outage dashboard needs.
    pub async fn client_status(&self) -> (String, u64, u64) {
        let slot = self.slot.lock().await;
        (
            slot.backend.clone(),
            slot.built_at.elapsed().as_secs(),
            slot.rebuilds,
        )
    }

    /// Never blocks: `None` while a rebuild is in flight. For liveness probes that
    /// must answer in microseconds even mid-reconnect.
    pub fn client_status_now(&self) -> Option<(String, u64, u64)> {
        match self.slot.try_lock() {
            Ok(slot) => Some((
                slot.backend.clone(),
                slot.built_at.elapsed().as_secs(),
                slot.rebuilds,
            )),
            Err(_) => None,
        }
    }

    /// Block-scoped reader with one reconnect-and-retry behind it.
    ///
    /// A websocket that died between two requests is indistinguishable from a
    /// chain error at the call site, so the recovery is done here once: rebuild,
    /// then retry. The retry is deliberately not repeated — if a fresh socket
    /// also fails, the node is genuinely unhappy and the error is the answer.
    pub async fn at_block(&self, want: H256) -> ApiResult<OnlineClientAtBlock<PolkadotConfig>> {
        let hash = format!("0x{}", hex::encode(want.as_bytes()));
        let client = self.client().await?;
        match client.at_block(want).await {
            Ok(at) => Ok(at),
            Err(first) => {
                let client = self.rebuild().await?;
                client.at_block(want).await.map_err(|second| {
                    ApiError::upstream(
                        "substrate",
                        format!("at_block({hash}): {first}; after reconnect: {second}"),
                    )
                })
            }
        }
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
    /// block hash. One reconnect is attempted before the error is returned.
    pub async fn revive_events(&self, number: u64) -> ApiResult<(String, Vec<ReviveEvent>)> {
        match self.revive_events_once(number).await {
            Ok(v) => Ok(v),
            Err(first) => {
                self.rebuild().await?;
                self.revive_events_once(number).await.map_err(|second| {
                    ApiError::upstream(
                        "substrate",
                        format!(
                            "revive events at {number}: {}; after reconnect: {}",
                            first.message, second.message
                        ),
                    )
                })
            }
        }
    }

    async fn revive_events_once(&self, number: u64) -> ApiResult<(String, Vec<ReviveEvent>)> {
        // Resolve number -> hash ourselves over plain JSON-RPC and hand subxt the
        // HASH. Only the number->hash lookup is backend-dependent: subxt's
        // chainHead backend refuses it outright ("The ChainHead V1 RPCs do not
        // support obtaining a block hash from a number"), which is what broke
        // /verify/block and /parity on Render while the same binary worked on a
        // laptop. `chain_getBlockHash` is a plain JSON-RPC call with no backend
        // choice attached, so this is deterministic everywhere.
        let hash_hex = self.block_hash(number).await?.ok_or_else(|| {
            ApiError::not_found(
                "block_not_found",
                format!("no block at height {number}: height is out of range on this chain"),
            )
        })?;
        let hash_bytes = hex::decode(hash_hex.trim_start_matches("0x")).map_err(|e| {
            ApiError::upstream(
                "substrate",
                format!("chain_getBlockHash({number}) returned non-hex '{hash_hex}': {e}"),
            )
        })?;
        if hash_bytes.len() != 32 {
            return Err(ApiError::upstream(
                "substrate",
                format!(
                    "chain_getBlockHash({number}) returned {} bytes, expected 32",
                    hash_bytes.len()
                ),
            ));
        }
        let want = H256::from_slice(&hash_bytes);

        let at = self.at_block(want).await?;
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

/// Ask the node which RPC methods it exposes *to this host*. Best-effort: a
/// failure is recorded, never fatal, because the service does not depend on any
/// of these answers.
async fn probe_methods(http_url: &str, http: &reqwest::Client) -> RpcMethods {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "rpc_methods", "params": [] });
    let resp = match http.post(http_url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return RpcMethods { error: Some(format!("rpc_methods: {e}")), ..Default::default() }
        }
    };
    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return RpcMethods { error: Some(format!("rpc_methods body: {e}")), ..Default::default() }
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return RpcMethods {
                error: Some(format!("rpc_methods: invalid JSON: {e}: {}", truncate(&text, 200))),
                ..Default::default()
            }
        }
    };
    if let Some(err) = parsed.get("error") {
        return RpcMethods { error: Some(format!("rpc_methods: {err}")), ..Default::default() };
    }
    let methods: Vec<String> = parsed
        .get("result")
        .and_then(|r| r.get("methods"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    RpcMethods {
        count: methods.len(),
        has_archive_v1: methods.iter().any(|m| m.starts_with("archive_v1_")),
        has_chain_head_v1: methods.iter().any(|m| m.starts_with("chainHead_v1_")),
        has_chain_get_block_hash: methods.iter().any(|m| m == "chain_getBlockHash"),
        error: None,
    }
}

/// subxt with the legacy backend pinned, so the number->hash / storage / header
/// calls are the same on every host and no backend autodetection sits between us
/// and the node. The transport has to be ws/wss: subxt 0.51's RPC client rejects
/// an `https://` URL outright ("Invalid URL: `https` not supported, expects 'ws'
/// or 'wss'"), so the JSON-RPC-over-WS upgrade is unavoidable — everything else
/// still goes over plain HTTP via `reqwest`.
async fn build_legacy(url: &str) -> Result<OnlineClient<PolkadotConfig>, String> {
    let rpc = RpcClient::from_insecure_url(url)
        .await
        .map_err(|e| format!("subxt rpc client over {url}: {e}"))?;
    let backend = LegacyBackend::builder().build(rpc);
    OnlineClient::<PolkadotConfig>::from_backend(Arc::new(backend))
        .await
        .map_err(|e| format!("subxt legacy backend over {url}: {e}"))
}

/// Legacy backend first, subxt autodetection only as a fallback.
async fn build_any(url: &str) -> Result<(OnlineClient<PolkadotConfig>, String, Option<String>), String> {
    match build_legacy(url).await {
        Ok(c) => Ok((c, "legacy/WS".to_string(), None)),
        Err(e1) => match OnlineClient::<PolkadotConfig>::from_insecure_url(url).await {
            Ok(c) => Ok((c, "combined/WS (fallback)".to_string(), Some(e1))),
            Err(e2) => Err(format!(
                "cannot connect to Substrate RPC {url}: legacy: {e1}; combined: {e2}"
            )),
        },
    }
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
