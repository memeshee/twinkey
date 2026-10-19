//! Probe: decode System.Events at a block and dump every pallet-revive event.
//! Not part of the service; kept as a debugging tool.

use subxt::{OnlineClient, PolkadotConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://test-node-v3.portaldot.dev".into());
    let block: u64 = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "90995".into())
        .parse()?;

    let api: OnlineClient<PolkadotConfig> = OnlineClient::from_insecure_url(&rpc).await?;
    println!("connected: {}", api.genesis_hash());

    let at = api.at_block(block).await?;
    println!("block: {block} hash: {:?}", at.block_ref().hash());

    let md = at.metadata();
    let pallet = md.pallets().find(|p| p.name().eq_ignore_ascii_case("revive"));
    if let Some(p) = pallet {
        println!("pallet revive found");
        for (i, ev) in p.event_variants().unwrap_or(&[]).iter().enumerate() {
            println!(
                "  variant {} = {} fields {:?}",
                i,
                ev.name,
                ev.fields
                    .iter()
                    .map(|f| (f.name.clone(), f.ty.id))
                    .collect::<Vec<_>>()
            );
        }
    } else {
        println!("no revive pallet in metadata");
    }

    let events = at.events().fetch().await?;
    println!("events: {}", events.len());
    for ev in events.iter() {
        let ev = ev?;
        if ev.pallet_name().eq_ignore_ascii_case("revive") {
            println!(
                "#{} phase={:?} {}::{} topics={:?} fields={}",
                ev.index(),
                ev.phase(),
                ev.pallet_name(),
                ev.event_name(),
                ev.topics()
                    .iter()
                    .map(|t| format!("{t:?}"))
                    .collect::<Vec<_>>(),
                hex::encode(ev.field_bytes())
            );
        } else {
            println!("#{} {}::{}", ev.index(), ev.pallet_name(), ev.event_name());
        }
    }
    Ok(())
}
