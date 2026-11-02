use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

use super::guardrails::TRIGGER_ORACLE_MANIPULATION;
use super::guardrails::test_support::*;
use super::*;

const CAP: u64 = 1_000;
const OPERATIONS: u32 = 2;
const HASH: [u8; 32] = [5; 32];
const NOW_NS: u64 = 1_700_000_000_000_000_000;
const HOUR_NS: u64 = 3_600 * 1_000_000_000;

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}

fn worker() -> AccountId {
    "worker.testnet".parse().unwrap()
}

fn set_context(predecessor: AccountId, timestamp_ns: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id("trigger.testnet".parse().unwrap())
        .predecessor_account_id(predecessor)
        .block_timestamp(timestamp_ns);
    testing_env!(builder.build());
}

fn contract() -> Contract {
    set_context("trigger.testnet".parse().unwrap(), NOW_NS);
    let mut contract = Contract::new(
        false,
        U64(DAY_MS * 7),
        owner(),
        "v1.signer-prod.testnet".parse().unwrap(),
        "covantic-oracle-v1".to_string(),
        base58(&ORACLE),
        base58(&COVANTIC),
        U64(CAP),
        OPERATIONS,
    );
    set_context(owner(), NOW_NS);
    let measurements = create_mock_full_measurements_hex();
    contract.whitelist_agent_for_local(worker());
    contract.agents.insert(
        worker(),
        Agent {
            measurements,
            ppid: Ppid::default(),
            valid_until_ms: NOW_NS / 1_000_000 + DAY_MS,
        },
    );
    set_context(worker(), NOW_NS);
    contract
}

fn intent(trigger_type: u8, hash: [u8; 32]) -> SignIntent {
    SignIntent {
        trigger_type,
        evidence_hash: hex::encode(hash),
    }
}

fn request(contract: &mut Contract, message: Vec<u8>, intent: SignIntent) -> Result<(), String> {
    contract
        .request_signature(Base64VecU8(message), intent)
        .map(|_| ())
        .map_err(|error| error.code().to_string())
}

fn payout(contract: &mut Contract, policy: Pubkey, amount: u64, hash: [u8; 32]) -> Result<(), String> {
    let message = build(&[ORACLE], &[payout_ix(policy, amount, hash)]);
    request(contract, message, intent(TRIGGER_ORACLE_MANIPULATION, hash))
}

fn claim(contract: &mut Contract) -> Result<(), String> {
    let message = build(&[ORACLE], &[submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)]);
    request(contract, message, intent(TRIGGER_ORACLE_MANIPULATION, HASH))
}

#[test]
fn a_registered_worker_gets_a_payout_signed_and_logged() {
    let mut contract = contract();
    assert_eq!(payout(&mut contract, POLICY, 100, HASH), Ok(()));

    let log = contract.get_intents(0, 10);
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].action, "verify_and_payout_v2");
    assert_eq!(log[0].subject, base58(&POLICY));
    assert_eq!(log[0].trigger_type, TRIGGER_ORACLE_MANIPULATION);
    assert_eq!(log[0].evidence_hash, hex::encode(HASH));
    assert_eq!(log[0].payout_amount.0, 100);
    assert_eq!(log[0].worker, worker());
    assert_eq!(log[0].status, IntentStatus::Requested);
    assert_eq!(log[0].solana_tx_message_hash.len(), 64);
    assert_eq!(contract.get_contract_info().daily_coverage_used.0, 100);
}

#[test]
fn g1_refuses_an_unregistered_caller() {
    let mut contract = contract();
    set_context("stranger.testnet".parse().unwrap(), NOW_NS);
    assert_eq!(
        payout(&mut contract, POLICY, 100, HASH),
        Err("G1_WORKER_NOT_REGISTERED".to_string())
    );
}

#[test]
fn g1_refuses_an_expired_registration() {
    let mut contract = contract();
    set_context(worker(), NOW_NS + 25 * HOUR_NS);
    assert_eq!(
        payout(&mut contract, POLICY, 100, HASH),
        Err("G1_WORKER_INVALID".to_string())
    );
}

#[test]
fn g1_refuses_a_worker_whose_measurements_were_revoked() {
    let mut contract = contract();
    set_context(owner(), NOW_NS);
    contract.remove_measurements(create_mock_full_measurements_hex());
    set_context(worker(), NOW_NS);
    assert_eq!(
        payout(&mut contract, POLICY, 100, HASH),
        Err("G1_WORKER_INVALID".to_string())
    );
}

#[test]
fn g5_refuses_a_second_payout_with_different_terms() {
    let mut contract = contract();
    assert_eq!(payout(&mut contract, POLICY, 100, HASH), Ok(()));
    assert_eq!(
        payout(&mut contract, POLICY, 101, HASH),
        Err("G5_POLICY_ALREADY_PAID".to_string())
    );
    assert_eq!(
        payout(&mut contract, POLICY, 100, [6; 32]),
        Err("G5_POLICY_ALREADY_PAID".to_string())
    );
}

#[test]
fn g5_allows_bounded_retries_of_the_same_payout_without_counting_them_twice() {
    let mut contract = contract();
    for _ in 0..MAX_PAYOUT_ATTEMPTS {
        assert_eq!(payout(&mut contract, POLICY, 100, HASH), Ok(()));
    }
    assert_eq!(contract.get_contract_info().daily_coverage_used.0, 100);
    assert_eq!(
        payout(&mut contract, POLICY, 100, HASH),
        Err("G5_PAYOUT_RETRIES_EXHAUSTED".to_string())
    );
}

#[test]
fn g6_allows_exactly_the_cap_and_refuses_one_more() {
    let mut contract = contract();
    assert_eq!(payout(&mut contract, POLICY, CAP, HASH), Ok(()));
    assert_eq!(
        payout(&mut contract, [40; 32], 1, HASH),
        Err("G6_DAILY_CAP_EXCEEDED".to_string())
    );
}

#[test]
fn g6_refuses_a_single_payout_above_the_cap() {
    let mut contract = contract();
    assert_eq!(
        payout(&mut contract, POLICY, CAP + 1, HASH),
        Err("G6_DAILY_CAP_EXCEEDED".to_string())
    );
    assert!(contract.get_payout(base58(&POLICY)).is_none());
}

#[test]
fn g6_does_not_overflow_on_a_huge_amount() {
    let mut contract = contract();
    assert_eq!(payout(&mut contract, POLICY, CAP, HASH), Ok(()));
    assert_eq!(
        payout(&mut contract, [40; 32], u64::MAX, HASH),
        Err("G6_DAILY_CAP_EXCEEDED".to_string())
    );
}

#[test]
fn g6_window_rolls_after_24_hours() {
    let mut contract = contract();
    assert_eq!(payout(&mut contract, POLICY, CAP, HASH), Ok(()));
    set_context(worker(), NOW_NS + 23 * HOUR_NS);
    assert_eq!(
        payout(&mut contract, [40; 32], 1, HASH),
        Err("G6_DAILY_CAP_EXCEEDED".to_string())
    );

    set_context(owner(), NOW_NS + 24 * HOUR_NS);
    contract.agents.get_mut(&worker()).unwrap().valid_until_ms = u64::MAX;
    set_context(worker(), NOW_NS + 24 * HOUR_NS);
    assert_eq!(payout(&mut contract, [40; 32], 1, HASH), Ok(()));
}

#[test]
fn g6_limits_claims_and_attestations() {
    let mut contract = contract();
    assert_eq!(claim(&mut contract), Ok(()));
    let attestation = build(&[ORACLE], &[attestation_ix([30; 32])]);
    assert_eq!(request(&mut contract, attestation, intent(0, HASH)), Ok(()));
    assert_eq!(
        claim(&mut contract),
        Err("G6_DAILY_OPERATION_LIMIT_EXCEEDED".to_string())
    );
}

#[test]
fn g7_refuses_while_paused_and_resumes_after() {
    let mut contract = contract();
    set_context(owner(), NOW_NS);
    contract.set_paused(true);
    set_context(worker(), NOW_NS);
    assert_eq!(
        payout(&mut contract, POLICY, 100, HASH),
        Err("G7_CONTRACT_PAUSED".to_string())
    );

    set_context(owner(), NOW_NS);
    contract.set_paused(false);
    set_context(worker(), NOW_NS);
    assert_eq!(payout(&mut contract, POLICY, 100, HASH), Ok(()));
}

#[test]
#[should_panic(expected = "Caller is not the owner")]
fn g7_only_the_owner_can_pause() {
    let mut contract = contract();
    contract.set_paused(true);
}

#[test]
#[should_panic(expected = "Caller is not the owner")]
fn g7_only_the_owner_can_change_limits() {
    let mut contract = contract();
    contract.set_limits(U64(u64::MAX), u32::MAX);
}

#[test]
fn refuses_a_payout_intent_with_a_different_bundle_hash() {
    let mut contract = contract();
    let message = build(&[ORACLE], &[payout_ix(POLICY, 100, HASH)]);
    assert_eq!(
        request(&mut contract, message, intent(TRIGGER_ORACLE_MANIPULATION, [6; 32])),
        Err("INTENT_MISMATCH".to_string())
    );
}

#[test]
fn refuses_a_claim_intent_with_a_different_trigger() {
    let mut contract = contract();
    let message = build(&[ORACLE], &[submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)]);
    assert_eq!(
        request(&mut contract, message, intent(1, HASH)),
        Err("INTENT_MISMATCH".to_string())
    );
}

#[test]
fn refuses_a_malformed_evidence_hash() {
    let mut contract = contract();
    let message = build(&[ORACLE], &[payout_ix(POLICY, 100, HASH)]);
    let bad = SignIntent {
        trigger_type: TRIGGER_ORACLE_MANIPULATION,
        evidence_hash: "not-hex".to_string(),
    };
    assert_eq!(request(&mut contract, message, bad), Err("INTENT_MISMATCH".to_string()));
}

#[test]
fn a_refused_request_is_not_logged_or_counted() {
    let mut contract = contract();
    let _ = payout(&mut contract, POLICY, CAP + 1, HASH);
    let info = contract.get_contract_info();
    assert_eq!(info.intent_count, 0);
    assert_eq!(info.daily_coverage_used.0, 0);
}

#[test]
#[should_panic(expected = "Whitelisting agents is not supported for TEE")]
fn tee_mode_has_no_local_whitelist() {
    let mut contract = contract();
    contract.requires_tee = true;
    set_context(owner(), NOW_NS);
    contract.whitelist_agent_for_local(worker());
}

#[test]
fn tee_mode_starts_with_nothing_approved() {
    set_context("trigger.testnet".parse().unwrap(), NOW_NS);
    let contract = Contract::new(
        true,
        U64(DAY_MS),
        owner(),
        "v1.signer-prod.testnet".parse().unwrap(),
        "path".to_string(),
        base58(&ORACLE),
        base58(&COVANTIC),
        U64(CAP),
        OPERATIONS,
    );
    assert!(contract.get_approved_measurements().is_empty());
    assert!(contract.get_approved_ppids().is_empty());
}

#[test]
#[should_panic(expected = "oracle_address is not a base58 public key")]
fn init_refuses_a_bad_oracle_address() {
    set_context("trigger.testnet".parse().unwrap(), NOW_NS);
    let _ = Contract::new(
        false,
        U64(DAY_MS),
        owner(),
        "v1.signer-prod.testnet".parse().unwrap(),
        "path".to_string(),
        "short".to_string(),
        base58(&COVANTIC),
        U64(CAP),
        OPERATIONS,
    );
}
