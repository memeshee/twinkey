//! TwinKey verifier service.
//!
//! Reads HISTORY from the Portaldot V3 Substrate archive node (System.Events at a
//! block hash) and CURRENT state from the EVM JSON-RPC at `latest` — never the
//! other way round, because the EVM endpoint discards old state.

mod abi;
mod chain;
mod error;
mod evm;
mod ss58;

use std::{
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use blake2::{digest::consts::U32, Blake2b, Digest};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use chain::{Chain, ReviveEvent};
use error::{ApiError, ApiResult};
use evm::Evm;

const DEFAULT_SIGNER: &str = "5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7";

#[derive(Clone)]
struct AppState {
    chain: Chain,
    evm: Evm,
    signer_ss58: String,
    signer_pubkey: [u8; 32],
    tx_scan_blocks: u64,
}

#[derive(Debug, Clone, Serialize)]
struct Check {
    name: String,
    ok: bool,
    detail: String,
}

fn check(name: impl Into<String>, ok: bool, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok, detail: detail.into() }
}

fn short(addr: &str) -> String {
    if addr.len() <= 12 {
        addr.to_string()
    } else {
        format!("{}…{}", &addr[..10], &addr[addr.len() - 4..])
    }
}

fn parse_number(raw: &str) -> ApiResult<u64> {
    let s = raw.trim();
    let parsed = if let Some(hex) = s.strip_prefix("0x") {
        u64::from_str_radix(hex, 16)
    } else {
        s.parse::<u64>()
    };
    parsed.map_err(|_| {
        ApiError::bad_request(format!("'{raw}' is not a block number (decimal or 0x-hex)"))
    })
}

fn validate_hash(raw: &str) -> ApiResult<String> {
    let h = raw.trim().to_lowercase();
    if !h.starts_with("0x") || h.len() != 66 || !h[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "expected a 32-byte 0x-prefixed hash (66 characters)",
        ));
    }
    Ok(h)
}

fn blake2_256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&out);
    hash
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

async fn health(State(st): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let chain_name = st.chain.chain_name().await?;
    let runtime = st.chain.runtime_version().await?;
    let header = st.chain.header().await?;
    let head_hash = header
        .get("parentHash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let head_block = st.chain.head_number().await?;
    let evm_block = st.evm.block_number().await?;

    Ok(Json(json!({
        "ok": true,
        "service": "twinkey-verifier",
        "chain": chain_name,
        "spec_name": runtime.get("specName").cloned().unwrap_or(Value::Null),
        "spec_version": runtime.get("specVersion").cloned().unwrap_or(Value::Null),
        "head_block": head_block,
        "head_parent_hash": head_hash,
        "evm_block": evm_block,
        "signer_ss58": st.signer_ss58,
        "substrate_rpc": st.chain.http_url,
        "substrate_ws": st.chain.ws_url,
        "subxt_backend": st.chain.backend,
        "subxt_backend_error": st.chain.backend_error,
        "substrate_methods": st.chain.methods,
        "evm_rpc": st.evm.url,
        "read_policy": "history: Substrate archive at block hash; current state: EVM eth_call/eth_getCode at 'latest' only",
    })))
}

/// `GET /diagnostics` — why the verifier works or does not work *on this host*.
///
/// Probes the three things that decide it, live: which RPC methods the node
/// advertises to this instance, whether legacy `chain_getBlockHash` resolves a
/// height, and whether `archive_v1_hashByHeight` — the call subxt's archive
/// backend makes when asked to turn a number into a hash — succeeds here.
/// When the archive backend is unavailable subxt silently falls through to
/// chainHead, which cannot do number -> hash at all, and every historical read
/// dies with "The ChainHead V1 RPCs do not support obtaining a block hash from
/// a number". That is exactly what happened on Render while the identical
/// binary worked on a laptop, so the answer is now observable instead of guessed.
async fn diagnostics(State(st): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    const PROBE_BLOCK: u64 = 90990;

    let head = st.chain.head_number().await?;
    let legacy = match st.chain.block_hash(PROBE_BLOCK).await {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "error": e.message, "detail": e.detail }),
    };
    // The node accepts a JSON number and rejects the spec's string form, so both
    // are recorded: it tells a future reader which shape this chain wants.
    let archive_numeric = match st.chain.rpc("archive_v1_hashByHeight", json!([PROBE_BLOCK])).await {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "error": e.message, "detail": e.detail }),
    };
    let archive_string =
        match st.chain.rpc("archive_v1_hashByHeight", json!([PROBE_BLOCK.to_string()])).await {
            Ok(v) => json!({ "ok": true, "result": v }),
            Err(e) => json!({ "ok": false, "error": e.message, "detail": e.detail }),
        };

    Ok(Json(json!({
        "ok": true,
        "service": "twinkey-verifier",
        "probe_block": PROBE_BLOCK,
        "head_block": head,
        "subxt_backend": st.chain.backend,
        "subxt_backend_error": st.chain.backend_error,
        "substrate_rpc": st.chain.http_url,
        "substrate_methods": st.chain.methods,
        "chain_getBlockHash": legacy,
        "archive_v1_hashByHeight_numeric": archive_numeric,
        "archive_v1_hashByHeight_string": archive_string,
        "read_policy": "history is read at an explicitly resolved block hash; no component is ever asked to map a number to a hash",
    })))
}

// ---------------------------------------------------------------------------
// Shared block view used by /verify/block and /verify/tx
// ---------------------------------------------------------------------------

async fn block_view(
    st: &AppState,
    number: u64,
    focus_extrinsic: Option<u32>,
) -> ApiResult<Value> {
    let hash = match st.chain.block_hash(number).await? {
        Some(h) => h,
        None => {
            return Err(ApiError::not_found(
                "block_not_found",
                format!("no block at height {number}: height is out of range on this chain"),
            ))
        }
    };

    let (decoded_hash, events) = st.chain.revive_events(number).await?;
    // Trust the events API's block hash over the lookup (they must agree; report
    // both if they ever don't).
    let mut summary: Vec<String> = Vec::new();
    summary.push(format!(
        "block {number} ({}) contains {} Revive event(s)",
        short(&decoded_hash),
        events.len()
    ));

    // Current EVM state for every distinct contract seen in this block.
    let mut contracts: Vec<String> = Vec::new();
    for ev in &events {
        if let Some(c) = &ev.contract {
            if !contracts.iter().any(|x| x.eq_ignore_ascii_case(c)) {
                contracts.push(c.clone());
            }
        }
    }
    contracts.sort();

    let mut current_state = serde_json::Map::new();
    for contract in &contracts {
        let code = st.evm.code(contract).await?;
        let code_len = code.len().saturating_sub(2) / 2;
        let read = st.evm.read_probe(contract).await?;
        let read_json = match &read {
            Some(r) => json!({
                "ok": true,
                "decoded": format!("(uint256 {}, address {}, uint256 {})", r.value, r.last_caller, r.call_count),
                "value": r.value,
                "value_hex": r.value_hex,
                "last_caller": r.last_caller,
                "call_count": r.call_count,
                "raw": r.raw,
            }),
            None => json!({ "ok": false, "error": "eth_call read() reverted or returned no data" }),
        };
        current_state.insert(
            contract.clone(),
            json!({
                "code_len_bytes": code_len,
                "has_code": code_len > 0,
                "read": read_json,
                "read_at": "latest",
            }),
        );
        summary.push(format!(
            "current EVM state: {} has {} bytes of runtime code; read() = {}",
            short(contract),
            code_len,
            match &read {
                Some(r) => format!(
                    "(value={}, lastCaller={}, callCount={})",
                    r.value,
                    short(&r.last_caller),
                    r.call_count
                ),
                None => "reverted".to_string(),
            }
        ));
    }

    for ev in &events {
        let prefix = match (&focus_extrinsic, ev.phase.as_str()) {
            (Some(i), p) if p == format!("ApplyExtrinsic({i})") => format!("[extrinsic {i}] "),
            _ => String::new(),
        };
        match ev.variant.as_str() {
            "Instantiated" => summary.push(format!(
                "{prefix}contract {} was instantiated at block {number} by mapped H160 {}",
                short(ev.contract.as_deref().unwrap_or("?")),
                short(ev.deployer.as_deref().unwrap_or("?"))
            )),
            "ContractEmitted" => {
                let contract = ev.contract.as_deref().unwrap_or("?");
                let topic0 = ev.topics.first().map(String::as_str).unwrap_or("(none)");
                let decoded = abi::decode_log(&ev.topic_bytes, &ev.data_bytes);
                match &decoded {
                    Ok(log) => summary.push(format!(
                        "{prefix}{} emitted at block {number} by {}: topic0 {} = {}; caller {}, value {}, callCount {}",
                        "Revive.ContractEmitted",
                        short(contract),
                        short(topic0),
                        log.signature,
                        short(&log.caller),
                        log.value.clone().unwrap_or_else(|| "-".into()),
                        log.call_count
                            .clone()
                            .or_else(|| log.new_value.clone())
                            .unwrap_or_else(|| "-".into()),
                    )),
                    Err(e) => summary.push(format!(
                        "{prefix}Revive.ContractEmitted by {}: topic0 {} ({})",
                        short(contract),
                        short(topic0),
                        e
                    )),
                }
            }
            "EthExtrinsicRevert" => summary.push(format!(
                "{prefix}Revive.EthExtrinsicRevert: the EVM extrinsic reverted on chain"
            )),
            other => summary.push(format!("{prefix}Revive.{other}")),
        }
    }
    if let Some(i) = focus_extrinsic {
        let belonging = events
            .iter()
            .filter(|e| e.phase == format!("ApplyExtrinsic({i})"))
            .count();
        summary.push(format!(
            "hash resolved to an extrinsic at index {i} in block {number}; it produced {belonging} Revive event(s)"
        ));
    }

    Ok(json!({
        "ok": true,
        "block_number": number,
        "block_hash": decoded_hash,
        "lookup_hash": hash,
        "revive_event_count": events.len(),
        "revive_events": events,
        "current_state": current_state,
        "focus_extrinsic": focus_extrinsic,
        "summary": summary,
        "sources": {
            "history": format!("substrate {} (archive, events read at block hash)", st.chain.http_url),
            "current_state": format!("evm {} at 'latest' only", st.evm.url),
        },
    }))
}

// ---------------------------------------------------------------------------
// GET /verify/block/:number
// ---------------------------------------------------------------------------

async fn verify_block(
    State(st): State<Arc<AppState>>,
    Path(number): Path<String>,
) -> ApiResult<Json<Value>> {
    let n = parse_number(&number)?;
    Ok(Json(block_view(&st, n, None).await?))
}

// ---------------------------------------------------------------------------
// GET /verify/tx/:hash
// ---------------------------------------------------------------------------

async fn verify_tx(
    State(st): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> ApiResult<Json<Value>> {
    let hash = validate_hash(&hash)?;

    // 1. Block hash? Then this is exactly /verify/block.
    if let Some(block) = st.chain.block_by_hash(&hash).await? {
        let number_hex = block
            .get("block")
            .and_then(|b| b.get("header"))
            .and_then(|h| h.get("number"))
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::upstream("substrate", "chain_getBlock: no block.header.number"))?;
        let number = chain::parse_hex_u64(number_hex)
            .ok_or_else(|| ApiError::upstream("substrate", "chain_getBlock: bad block number"))?;
        let mut view = block_view(&st, number, None).await?;
        if let Some(obj) = view.as_object_mut() {
            obj.insert("resolved".into(), json!({ "kind": "block", "block_number": number }));
            if let Some(summary) = obj.get_mut("summary").and_then(Value::as_array_mut) {
                summary.insert(
                    0,
                    json!(format!("{hash} is the hash of block {number}")),
                );
            }
        }
        return Ok(Json(view));
    }

    // 2. Otherwise scan a bounded window of recent blocks for the extrinsic hash.
    let head = st.chain.head_number().await?;
    let start = head.saturating_sub(st.tx_scan_blocks);
    for n in (start..=head).rev() {
        let Some(bh) = st.chain.block_hash(n).await? else { continue };
        let Some(block) = st.chain.block_by_hash(&bh).await? else { continue };
        if let Some(exts) = block
            .get("block")
            .and_then(|b| b.get("extrinsics"))
            .and_then(Value::as_array)
        {
            for (i, ext) in exts.iter().enumerate() {
                let Some(hex_str) = ext.as_str() else { continue };
                let Ok(bytes) = hex::decode(hex_str.trim_start_matches("0x")) else { continue };
                if format!("0x{}", hex::encode(blake2_256(&bytes))) == hash {
                    let mut view = block_view(&st, n, Some(i as u32)).await?;
                    if let Some(obj) = view.as_object_mut() {
                        obj.insert(
                            "resolved".into(),
                            json!({ "kind": "extrinsic", "block_number": n, "extrinsic_index": i }),
                        );
                        if let Some(summary) = obj.get_mut("summary").and_then(Value::as_array_mut) {
                            summary.insert(
                                0,
                                json!(format!(
                                    "{hash} is extrinsic #{i} in block {n} ({})",
                                    short(&bh)
                                )),
                            );
                        }
                    }
                    return Ok(Json(view));
                }
            }
        }
    }

    Err(ApiError::not_found(
        "tx_not_found",
        format!(
            "{hash} is neither a block hash nor an extrinsic in the last {} blocks (scanned {start}..={head}); raise TX_SCAN_BLOCKS for a deeper search",
            st.tx_scan_blocks
        ),
    )
    .with_detail(json!({
        "scanned_from": start,
        "scanned_to": head,
        "hint": "block hashes are resolved exactly; extrinsic hashes need a bounded scan because the RPC has no tx index"
    }))
    .with_summary(vec![
        format!("{hash} is not the hash of a block on this chain"),
        format!("scanned blocks {start}..={head} for an extrinsic with that hash and found none"),
        "a deeper search needs TX_SCAN_BLOCKS raised (each block costs two RPC calls)".to_string(),
    ]))
}

// ---------------------------------------------------------------------------
// GET /parity/:number
// ---------------------------------------------------------------------------

async fn parity(
    State(st): State<Arc<AppState>>,
    Path(number): Path<String>,
) -> ApiResult<Json<Value>> {
    let n = parse_number(&number)?;
    let (block_hash, events) = st.chain.revive_events(n).await?;
    let emitted: Vec<&ReviveEvent> = events
        .iter()
        .filter(|e| e.variant == "ContractEmitted")
        .collect();

    // The signer's H160 comes from the chain's own runtime API, never computed locally.
    let signer_h160 = st.chain.revive_address(&st.signer_pubkey).await?;

    let mut checks: Vec<Check> = Vec::new();
    let mut records: Vec<Value> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    if emitted.is_empty() {
        checks.push(check(
            "contract_emitted_present",
            false,
            format!("no Revive.ContractEmitted event at block {n}"),
        ));
    }

    for ev in &emitted {
        let contract = ev.contract.clone().unwrap_or_default();
        let code = st.evm.code(&contract).await?;
        let code_len = code.len().saturating_sub(2) / 2;
        let read = st.evm.read_probe(&contract).await?;
        let decoded = abi::decode_log(&ev.topic_bytes, &ev.data_bytes);

        // (a) the emitting contract still has code at 'latest'
        checks.push(check(
            format!("contract_has_code[{}]", short(&contract)),
            code_len > 0,
            format!(
                "eth_getCode({}, 'latest') returned {code_len} bytes{}",
                short(&contract),
                if code_len > 0 { "" } else { " — the contract is gone" }
            ),
        ));

        match &decoded {
            Ok(log) => {
                // (b) caller in the event == H160 mapped from the signing SS58 account
                let ok_caller = log.caller.eq_ignore_ascii_case(&signer_h160);
                checks.push(check(
                    format!("caller_is_mapped_signer[{}]", short(&contract)),
                    ok_caller,
                    format!(
                        "event caller {} vs H160 {} mapped from SS58 {} by ReviveApi_address{}",
                        log.caller,
                        signer_h160,
                        st.signer_ss58,
                        if ok_caller { " (match)" } else { " — MISMATCH" }
                    ),
                ));

                match &read {
                    Some(r) => {
                        // (c) current EVM state is consistent with the emitted event:
                        //     callCount may only grow, and while it is unchanged the
                        //     value must equal what was emitted.
                        let ev_count: u128 = log
                            .call_count
                            .as_deref()
                            .unwrap_or("0")
                            .parse()
                            .unwrap_or(0);
                        let cur_count: u128 = r.call_count.parse().unwrap_or(0);
                        let cur_value = r.value.clone();
                        // ValueSet carries `value`; ValueAdded carries the resulting
                        // `newValue`, which is the same kind of observation.
                        let ev_value = log.value.clone().or_else(|| log.new_value.clone());

                        let count_ok = cur_count >= ev_count;
                        let (value_ok, value_detail) = match &ev_value {
                            Some(v) if cur_value == *v => (
                                true,
                                format!(
                                    "current value {cur_value} equals the value emitted at block {n}"
                                ),
                            ),
                            Some(v) if cur_count > ev_count => (
                                true,
                                format!(
                                    "current value {cur_value} differs from {v} emitted at block {n}, but callCount advanced {ev_count} -> {cur_count}, so a later call superseded it; the emission and its increment are intact"
                                ),
                            ),
                            Some(v) => (
                                false,
                                format!(
                                    "current value {cur_value} differs from {v} emitted at block {n} while callCount is unchanged ({cur_count}) — DIVERGENCE"
                                ),
                            ),
                            None => (true, "event carries no value to compare (ValueAdded)".into()),
                        };

                        checks.push(check(
                            format!("state_consistent_with_event[{}]", short(&contract)),
                            count_ok && value_ok,
                            format!(
                                "eth_call read() at latest = (value {}, lastCaller {}, callCount {}); {value_detail}",
                                r.value,
                                short(&r.last_caller),
                                r.call_count
                            ),
                        ));

                        if !count_ok {
                            notes.push(format!(
                                "callCount now {cur_count} is lower than {ev_count} recorded at block {n} — the EVM state does not include this emission"
                            ));
                        }
                        if cur_count > ev_count {
                            notes.push(format!(
                                "state changed after block {n}: callCount {ev_count} -> {cur_count}, value {} -> {}",
                                ev_value.clone().unwrap_or_else(|| "-".into()),
                                cur_value
                            ));
                        }
                    }
                    None => {
                        checks.push(check(
                            format!("state_consistent_with_event[{}]", short(&contract)),
                            false,
                            "eth_call read() at 'latest' reverted, so current state cannot confirm the event"
                                .to_string(),
                        ));
                    }
                }

                records.push(json!({
                    "contract": contract,
                    "topic0": ev.topics.first(),
                    "event": log.event,
                    "signature": log.signature,
                    "caller": log.caller,
                    "value": log.value,
                    "amount": log.amount,
                    "new_value": log.new_value,
                    "call_count": log.call_count,
                    "emitted_at_block": n,
                    "current": read.as_ref().map(|r| json!({
                        "value": r.value,
                        "last_caller": r.last_caller,
                        "call_count": r.call_count,
                    })),
                }));
            }
            Err(e) => {
                checks.push(check(
                    format!("event_abi_known[{}]", short(&contract)),
                    false,
                    format!("{e} (topics: {:?})", ev.topics),
                ));
                records.push(json!({
                    "contract": contract,
                    "topic0": ev.topics.first(),
                    "decode_error": e,
                }));
            }
        }
    }

    let verdict = !checks.is_empty() && checks.iter().all(|c| c.ok);

    Ok(Json(json!({
        "ok": true,
        "verdict": verdict,
        "block_number": n,
        "block_hash": block_hash,
        "signer": {
            "ss58": st.signer_ss58,
            "public_key": format!("0x{}", hex::encode(st.signer_pubkey)),
            "h160": signer_h160,
            "source": "ReviveApi_address via state_call at latest (the runtime's own mapping)",
        },
        "checks": checks,
        "events": records,
        "notes": notes,
        "policy": {
            "history": "System.Events read from the Substrate archive node at this block hash",
            "current": "eth_getCode / eth_call at 'latest' only; historical eth_call fails with UnknownBlock: State already discarded",
        },
    })))
}

// ---------------------------------------------------------------------------
// Root: tiny index so a judge landing on / knows what to curl.
// ---------------------------------------------------------------------------

async fn index() -> impl IntoResponse {
    Json(json!({
        "service": "twinkey-verifier",
        "endpoints": [
            "GET /health",
            "GET /diagnostics",
            "GET /verify/block/:number",
            "GET /verify/tx/:hash",
            "GET /parity/:number"
        ],
        "example": "curl -s localhost:8088/parity/90995 | jq",
    }))
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8088);
    let substrate = std::env::var("SUBSTRATE_RPC")
        .unwrap_or_else(|_| "https://test-node-v3.portaldot.dev".to_string());
    let evm_url = std::env::var("EVM_RPC")
        .unwrap_or_else(|_| "https://test-evm-rpc-v3.portaldot.dev".to_string());
    let signer_ss58 = std::env::var("TWINKEY_SS58").unwrap_or_else(|_| DEFAULT_SIGNER.to_string());
    let tx_scan_blocks: u64 = std::env::var("TX_SCAN_BLOCKS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);

    let signer_pubkey = match ss58::decode_account_id(&signer_ss58) {
        Ok(pk) => pk,
        Err(e) => {
            eprintln!("invalid TWINKEY_SS58 '{signer_ss58}': {e}");
            std::process::exit(1);
        }
    };

    // A User-Agent is mandatory: both Portaldot endpoints answer 403 without one.
    let http = match reqwest::Client::builder()
        .user_agent("twinkey-verifier/0.1 (+https://github.com/twinkey)")
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot build HTTP client: {e}");
            std::process::exit(1);
        }
    };

    let chain = match Chain::connect(substrate.clone(), http.clone()).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("startup failed: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        chain,
        evm: Evm::new(evm_url.clone(), http),
        signer_ss58: signer_ss58.clone(),
        signer_pubkey,
        tx_scan_blocks,
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/diagnostics", get(diagnostics))
        .route("/verify/block/{number}", get(verify_block))
        .route("/verify/tx/{hash}", get(verify_tx))
        .route("/parity/{number}", get(parity))
        .with_state(state);

    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot bind 0.0.0.0:{port}: {e}");
            std::process::exit(1);
        }
    };

    println!("twinkey-verifier listening on http://0.0.0.0:{port}");
    println!("  substrate: {substrate} (history, archive)");
    println!("  evm:       {evm_url} (current state, 'latest' only)");
    println!("  signer:    {signer_ss58}");

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
    {
        eprintln!("server error: {e}");
    }
}
