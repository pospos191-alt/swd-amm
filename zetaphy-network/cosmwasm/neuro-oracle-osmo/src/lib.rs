//! ZETAPHY Neuro oracle mirror on Osmosis (osmo-test-5), item 18 of docs/future/crosschain-assist.md.
//!
//! ZETAPHY's NeuroOracleSender.pushIbc() sends an ICS-20 transfer of 1 azetaphy with the memo
//!   {"wasm":{"contract":"<this>","msg":{"mirror":{"src_chain":77390,"items":[{"key":"<64 hex>","round":1,
//!    "flagged":true,"reason":2,"enforced_from":…,"held_from":…}]}}}}
//! Osmosis' ibc-hooks executes `msg` on this contract with a sender DERIVED from (Osmosis' channel, the packet's
//! sender = the NeuroOracleSender's zetaphy1… address): sha256(sha256("ibc-wasm-hook-intermediary") || "channel/sender")
//! (zetaphy-network/src/neurooracle.js ibcHooksSender; check with `osmosisd q ibc-hooks wasm-sender`). Only that
//! sender may write. Trust: Osmosis' IBC light client of ZETAPHY + the sender contract (which reads the registry
//! itself). A key keeps the newest state by the registry's round, as the EVM NeuroOracle does.
use cosmwasm_std::{
    entry_point, from_json, to_json_binary, to_json_vec, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: String,
    pub hook_sender: String,
    pub src_chain: u64,
    pub paused: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Mirror {
    pub round: u32,
    pub flagged: bool,
    pub reason: u8,
    pub enforced_from: u64,
    pub held_from: u64,
    pub mirrored_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Item {
    pub key: String,
    pub round: u32,
    pub flagged: bool,
    pub reason: u8,
    pub enforced_from: u64,
    pub held_from: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InstantiateMsg {
    pub admin: String,
    pub hook_sender: String,
    pub src_chain: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    Mirror { src_chain: u64, items: Vec<Item> },
    SetHookSender { hook_sender: String },
    SetAdmin { admin: String },
    Pause {},
    Unpause {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    Flag { key: String },
    Rounds { keys: Vec<String> },
    Config {},
    Stats {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FlagResponse {
    pub flagged: bool,
    pub enforced: bool,
    pub reason: u8,
    pub round: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StatsResponse {
    pub keys: u64,
    pub flagged_now: u64,
    pub messages: u64,
    pub paused: bool,
}

const CONFIG: &[u8] = b"config";
const STATS: &[u8] = b"stats";
const MAX_ITEMS: usize = 32;

fn key_of(k: &str) -> Vec<u8> {
    [b"k:".as_slice(), k.as_bytes()].concat()
}

fn valid_key(k: &str) -> bool {
    k.len() == 64 && k.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn load<T: for<'de> Deserialize<'de>>(s: &dyn Storage, k: &[u8]) -> StdResult<Option<T>> {
    s.get(k).map(|v| from_json(v)).transpose()
}

fn save<T: Serialize>(s: &mut dyn Storage, k: &[u8], v: &T) -> StdResult<()> {
    s.set(k, &to_json_vec(v)?);
    Ok(())
}

fn config(s: &dyn Storage) -> StdResult<Config> {
    load(s, CONFIG)?.ok_or_else(|| StdError::generic_err("not instantiated"))
}

fn stats(s: &dyn Storage) -> StdResult<(u64, u64, u64)> {
    Ok(load(s, STATS)?.unwrap_or((0, 0, 0)))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(deps: DepsMut, _env: Env, _info: MessageInfo, msg: InstantiateMsg) -> StdResult<Response> {
    deps.api.addr_validate(&msg.admin)?;
    deps.api.addr_validate(&msg.hook_sender)?;
    save(deps.storage, CONFIG, &Config { admin: msg.admin, hook_sender: msg.hook_sender, src_chain: msg.src_chain, paused: false })?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> StdResult<Response> {
    let mut cfg = config(deps.storage)?;
    match msg {
        ExecuteMsg::Mirror { src_chain, items } => {
            if info.sender.as_str() != cfg.hook_sender {
                return Err(StdError::generic_err("not the ibc-hooks sender of ZETAPHY's NeuroOracleSender"));
            }
            if cfg.paused {
                return Err(StdError::generic_err("paused"));
            }
            if src_chain != cfg.src_chain {
                return Err(StdError::generic_err("wrong source chain"));
            }
            if items.len() > MAX_ITEMS {
                return Err(StdError::generic_err("too many items"));
            }
            let (mut keys, mut flagged_now, mut messages) = stats(deps.storage)?;
            let mut applied = 0u32;
            for it in items {
                if !valid_key(&it.key) {
                    return Err(StdError::generic_err("key: 64 lowercase hex"));
                }
                let k = key_of(&it.key);
                let m: Mirror = load(deps.storage, &k)?.unwrap_or_default();
                let newer = it.round > m.round
                    || (it.round == m.round && m.mirrored_at != 0 && it.flagged && m.flagged
                        && (it.enforced_from < m.enforced_from || it.held_from < m.held_from));
                if it.round == 0 || !newer {
                    continue;
                }
                if m.mirrored_at == 0 {
                    keys += 1;
                }
                if it.flagged && !m.flagged {
                    flagged_now += 1;
                } else if !it.flagged && m.flagged {
                    flagged_now -= 1;
                }
                let f = it.flagged;
                save(deps.storage, &k, &Mirror {
                    round: it.round,
                    flagged: f,
                    reason: if f { it.reason } else { 0 },
                    enforced_from: if f { it.enforced_from } else { 0 },
                    held_from: if f { it.held_from } else { 0 },
                    mirrored_at: env.block.time.seconds(),
                })?;
                applied += 1;
            }
            messages += 1;
            save(deps.storage, STATS, &(keys, flagged_now, messages))?;
            Ok(Response::new().add_attribute("action", "mirror").add_attribute("applied", applied.to_string()))
        }
        ExecuteMsg::SetHookSender { hook_sender } => {
            only_admin(&cfg, &info)?;
            deps.api.addr_validate(&hook_sender)?;
            cfg.hook_sender = hook_sender;
            save(deps.storage, CONFIG, &cfg)?;
            Ok(Response::new().add_attribute("action", "set_hook_sender"))
        }
        ExecuteMsg::SetAdmin { admin } => {
            only_admin(&cfg, &info)?;
            deps.api.addr_validate(&admin)?;
            cfg.admin = admin;
            save(deps.storage, CONFIG, &cfg)?;
            Ok(Response::new().add_attribute("action", "set_admin"))
        }
        ExecuteMsg::Pause {} => {
            only_admin(&cfg, &info)?;
            cfg.paused = true;
            save(deps.storage, CONFIG, &cfg)?;
            Ok(Response::new().add_attribute("action", "pause"))
        }
        ExecuteMsg::Unpause {} => {
            only_admin(&cfg, &info)?;
            cfg.paused = false;
            save(deps.storage, CONFIG, &cfg)?;
            Ok(Response::new().add_attribute("action", "unpause"))
        }
    }
}

fn only_admin(cfg: &Config, info: &MessageInfo) -> StdResult<()> {
    if info.sender.as_str() != cfg.admin {
        return Err(StdError::generic_err("not the admin"));
    }
    Ok(())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    let cfg = config(deps.storage)?;
    match msg {
        QueryMsg::Flag { key } => {
            let m: Mirror = load(deps.storage, &key_of(&key))?.unwrap_or_default();
            let on = !cfg.paused && m.flagged;
            to_json_binary(&FlagResponse { flagged: on, enforced: on && env.block.time.seconds() >= m.enforced_from, reason: if on { m.reason } else { 0 }, round: m.round })
        }
        QueryMsg::Rounds { keys } => {
            let mut out = Vec::with_capacity(keys.len());
            for k in keys.iter().take(200) {
                out.push(load::<Mirror>(deps.storage, &key_of(k))?.map(|m| m.round).unwrap_or(0));
            }
            to_json_binary(&out)
        }
        QueryMsg::Config {} => to_json_binary(&cfg),
        QueryMsg::Stats {} => {
            let (keys, flagged_now, messages) = stats(deps.storage)?;
            to_json_binary(&StatsResponse { keys, flagged_now, messages, paused: cfg.paused })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::Addr;

    const K: &str = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";

    fn item(round: u32, flagged: bool, enforced_from: u64) -> Item {
        Item { key: K.into(), round, flagged, reason: 2, enforced_from, held_from: enforced_from }
    }

    fn setup() -> (cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, Addr, Addr) {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let hook = deps.api.addr_make("hook");
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), InstantiateMsg { admin: admin.to_string(), hook_sender: hook.to_string(), src_chain: 77390 }).unwrap();
        (deps, admin, hook)
    }

    fn flag(deps: Deps, env: &Env) -> FlagResponse {
        from_json(query(deps, env.clone(), QueryMsg::Flag { key: K.into() }).unwrap()).unwrap()
    }

    #[test]
    fn only_the_hook_sender_writes_newest_round_wins() {
        let (mut deps, admin, hook) = setup();
        let env = mock_env();
        let now = env.block.time.seconds();
        let mirror = |items| ExecuteMsg::Mirror { src_chain: 77390, items };
        assert!(execute(deps.as_mut(), env.clone(), message_info(&admin, &[]), mirror(vec![item(1, true, now)])).is_err());
        assert!(execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), ExecuteMsg::Mirror { src_chain: 1, items: vec![] }).is_err());
        execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), mirror(vec![item(1, true, now + 100)])).unwrap();
        assert_eq!(flag(deps.as_ref(), &env), FlagResponse { flagged: true, enforced: false, reason: 2, round: 1 });
        // cleared at round 2, then the old round-1 flag arrives late: stays cleared
        execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), mirror(vec![item(2, false, 0)])).unwrap();
        execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), mirror(vec![item(1, true, now)])).unwrap();
        assert_eq!(flag(deps.as_ref(), &env), FlagResponse { flagged: false, enforced: false, reason: 0, round: 2 });
        let st: StatsResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::Stats {}).unwrap()).unwrap();
        assert_eq!((st.keys, st.flagged_now, st.messages), (1, 0, 3));
        let r: Vec<u32> = from_json(query(deps.as_ref(), env, QueryMsg::Rounds { keys: vec![K.into(), "00".repeat(32)] }).unwrap()).unwrap();
        assert_eq!(r, vec![2, 0]);
    }

    #[test]
    fn enforced_after_its_time_paused_hides_and_refuses_bad_keys() {
        let (mut deps, admin, hook) = setup();
        let mut env = mock_env();
        let now = env.block.time.seconds();
        execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), ExecuteMsg::Mirror { src_chain: 77390, items: vec![item(1, true, now + 10)] }).unwrap();
        env.block.time = env.block.time.plus_seconds(10);
        assert!(flag(deps.as_ref(), &env).enforced);
        assert!(execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), ExecuteMsg::Pause {}).is_err());
        execute(deps.as_mut(), env.clone(), message_info(&admin, &[]), ExecuteMsg::Pause {}).unwrap();
        assert!(!flag(deps.as_ref(), &env).flagged);
        assert!(execute(deps.as_mut(), env.clone(), message_info(&hook, &[]), ExecuteMsg::Mirror { src_chain: 77390, items: vec![item(2, true, now)] }).is_err());
        execute(deps.as_mut(), env.clone(), message_info(&admin, &[]), ExecuteMsg::Unpause {}).unwrap();
        let bad = Item { key: "XYZ".into(), ..item(3, true, now) };
        assert!(execute(deps.as_mut(), env, message_info(&hook, &[]), ExecuteMsg::Mirror { src_chain: 77390, items: vec![bad] }).is_err());
    }

    #[test]
    fn the_memo_from_zetaphy_parses_as_execute_msg() {
        // what NeuroOracleSender.ibcMemo builds (wasm.msg)
        let msg = format!(r#"{{"mirror":{{"src_chain":77390,"items":[{{"key":"{K}","round":1,"flagged":true,"reason":2,"enforced_from":1800000000,"held_from":1799999400}}]}}}}"#);
        let m: ExecuteMsg = from_json(msg.as_bytes()).unwrap();
        assert_eq!(m, ExecuteMsg::Mirror { src_chain: 77390, items: vec![Item { key: K.into(), round: 1, flagged: true, reason: 2, enforced_from: 1800000000, held_from: 1799999400 }] });
    }
}
