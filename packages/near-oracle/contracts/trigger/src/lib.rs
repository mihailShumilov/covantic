//! NEAR agent contract that controls the Covantic oracle key.
//!
//! The oracle key exists only as threshold shares in the MPC network, and this
//! contract is the only account that can request a signature for it. Worker
//! registration and attestation follow the Shade Agent contract template.
//! `update_contract` and `update_mpc_contract_id` were removed from it, and the
//! oracle address and Covantic program id are fixed at init, so the owner
//! cannot repoint the signer or replace the guardrails in place.

use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    env::{self, block_timestamp_ms},
    ext_contract,
    json_types::{Base64VecU8, U64},
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet, LookupMap, Vector},
};
use shade_attestation::{
    attestation::{AcceptedDstackAttestation, DstackAttestation},
    measurements::{FullMeasurements, FullMeasurementsHex, create_mock_full_measurements_hex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

pub mod errors;
pub mod guardrails;
mod internal;
pub mod message;
mod owner;
pub mod views;

use errors::ContractError;
use guardrails::{Action, GuardrailConfig};
use internal::events::{self, Event};
use message::Pubkey;

pub type Ppid = HexBytes<16>;

const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
/// The MPC contract's Ed25519 domain on testnet and mainnet.
const ED25519_DOMAIN_ID: u64 = 1;
/// Bounds the serialized rolling windows, and so the gas of every request.
const MAX_WINDOW_ENTRIES: usize = 256;
/// A signature can fail to land, so a payout may be signed again with the same
/// terms. Solana still pays once: the evidence record is `init` and the policy
/// leaves `ClaimPending`.
const MAX_PAYOUT_ATTEMPTS: u8 = 3;
const SIGN_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const STORAGE_BYTES_TO_REGISTER: u128 = 486;

#[near(serializers = [borsh])]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct PayoutRecord {
    pub payout_amount: u64,
    pub bundle_hash: [u8; 32],
    pub attempts: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentStatus {
    Requested,
    Signed,
    SignFailed,
}

/// The log entry for one request sent to the MPC signer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct IntentRecord {
    pub id: u32,
    pub action: String,
    /// Base58 policy key. For an attestation, the agent key.
    pub subject: String,
    pub trigger_type: u8,
    pub evidence_hash: String,
    pub solana_tx_message_hash: String,
    pub payout_amount: U64,
    pub worker: AccountId,
    pub timestamp_ms: U64,
    pub status: IntentStatus,
}

/// What the worker claims the message does. It is checked against the parsed
/// message rather than trusted.
#[near(serializers = [json])]
pub struct SignIntent {
    pub trigger_type: u8,
    /// sha256 of the canonical evidence bundle, hex.
    pub evidence_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct SignatureResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub enum MpcPayload {
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct MpcSignRequest {
    pub payload_v2: MpcPayload,
    pub path: String,
    pub domain_id: u64,
}

#[allow(dead_code)]
#[ext_contract(mpc_contract)]
trait MpcContract {
    fn sign(&self, request: MpcSignRequest);
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
    Payouts,
    Intents,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub agents: IterableMap<AccountId, Agent>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,

    pub paused: bool,
    pub derivation_path: String,
    pub oracle_address: Pubkey,
    pub covantic_program: Pubkey,
    /// Rolling 24 hour limit on the sum of payout amounts, USDC base units.
    /// SPEC section 5 calls this declared coverage. It uses the parsed payout
    /// amount instead, because a declared value would be worker-supplied.
    pub max_daily_coverage: u64,
    /// Rolling 24 hour limit on claims and attestations, which move no funds
    /// but spend the oracle address's SOL and can hold a policy in ClaimPending.
    pub max_daily_operations: u32,
    pub payouts: LookupMap<Pubkey, PayoutRecord>,
    pub intents: Vector<IntentRecord>,
    payout_window: Vec<(u64, u64)>,
    operation_window: Vec<u64>,
}

fn decode_pubkey(value: &str, field: &str) -> Pubkey {
    bs58::decode(value)
        .into_vec()
        .ok()
        .and_then(|bytes| Pubkey::try_from(bytes).ok())
        .unwrap_or_else(|| env::panic_str(&format!("{field} is not a base58 public key")))
}

fn decode_hash(value: &str) -> Result<[u8; 32], ContractError> {
    hex::decode(value)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or(ContractError::IntentMismatch("evidence_hash is not 32 hex bytes"))
}

fn base58(key: &Pubkey) -> String {
    bs58::encode(key).into_string()
}

#[near]
impl Contract {
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
        derivation_path: String,
        oracle_address: String,
        covantic_program: String,
        max_daily_coverage: U64,
        max_daily_operations: u32,
    ) -> Self {
        let mut approved_measurements = IterableSet::new(StorageKey::ApprovedMeasurements);
        let mut approved_ppids = IterableSet::new(StorageKey::ApprovedPpids);
        // Local mode has no TEE to measure, so workers carry the mock values and
        // the whitelist is what admits them.
        if !requires_tee {
            approved_measurements.insert(create_mock_full_measurements_hex());
            approved_ppids.insert(Ppid::default());
        }
        Self {
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            owner_id,
            mpc_contract_id,
            approved_measurements,
            approved_ppids,
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
            paused: false,
            derivation_path,
            oracle_address: decode_pubkey(&oracle_address, "oracle_address"),
            covantic_program: decode_pubkey(&covantic_program, "covantic_program"),
            max_daily_coverage: max_daily_coverage.into(),
            max_daily_operations,
            payouts: LookupMap::new(StorageKey::Payouts),
            intents: Vector::new(StorageKey::Intents),
            payout_window: Vec::new(),
            operation_window: Vec::new(),
        }
    }

    /// Registers the calling worker. In TEE mode this requires a valid
    /// attestation for approved measurements. In local mode the caller must
    /// be whitelisted by the owner.
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        let predecessor = env::predecessor_account_id();
        if self.agents.get(&predecessor).is_none() {
            let storage_cost = env::storage_byte_cost()
                .checked_mul(STORAGE_BYTES_TO_REGISTER)
                .unwrap();
            require!(
                env::attached_deposit() >= storage_cost,
                format!(
                    "Attached deposit must be greater than storage cost {:?}",
                    storage_cost.exact_amount_display()
                )
            );
        }

        let (measurements, ppid, advisory_ids) = self.verify_attestation(attestation);
        let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;
        let (advisory_ids_truncated, number_of_advisory_ids) =
            events::summarize_advisory_ids(&advisory_ids);

        Event::AgentRegistered {
            account_id: &predecessor,
            measurements: &measurements,
            ppid: &ppid,
            advisory_ids_truncated,
            number_of_advisory_ids,
            current_time_ms: U64::from(block_timestamp_ms()),
            valid_until_ms: U64::from(valid_until_ms),
        }
        .emit();

        self.agents.insert(
            predecessor,
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );
        true
    }

    /// Requests an oracle signature over a raw Solana message.
    ///
    /// The sign deposit comes from the contract's balance, so workers can
    /// call this with a function-call access key, which cannot attach one.
    #[handle_result]
    pub fn request_signature(
        &mut self,
        payload: Base64VecU8,
        intent: SignIntent,
    ) -> Result<Promise, ContractError> {
        if self.paused {
            return Err(ContractError::ContractPaused);
        }
        self.require_valid_worker()?;

        let config = GuardrailConfig {
            oracle_address: self.oracle_address,
            covantic_program: self.covantic_program,
        };
        let action = guardrails::inspect(&payload.0, &config)?;
        let intent_id = self.apply_action(&action, &intent, &payload.0)?;

        let request = MpcSignRequest {
            payload_v2: MpcPayload::Eddsa(hex::encode(&payload.0)),
            path: self.derivation_path.clone(),
            domain_id: ED25519_DOMAIN_ID,
        };
        Ok(mpc_contract::ext(self.mpc_contract_id.clone())
            .with_static_gas(SIGN_GAS)
            .with_attached_deposit(SIGN_DEPOSIT)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(intent_id),
            ))
    }

    /// Records the MPC result and returns the signature to the caller.
    #[private]
    pub fn on_signed(
        &mut self,
        intent_id: u32,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> SignatureResponse {
        let status = match result {
            Ok(_) => IntentStatus::Signed,
            Err(_) => IntentStatus::SignFailed,
        };
        if let Some(record) = self.intents.get_mut(intent_id) {
            record.status = status;
        }
        match result {
            Ok(response) => response,
            Err(_) => env::panic_str("MPC_SIGN_FAILED: the MPC contract returned no signature"),
        }
    }
}

impl Contract {
    pub(crate) fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Caller is not the owner");
    }

    pub(crate) fn invalid_reasons(&self, account_id: &AccountId, agent: &Agent) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if agent.valid_until_ms < block_timestamp_ms() {
            reasons.push("expired_attestation");
        }
        if !self.approved_measurements.contains(&agent.measurements) {
            reasons.push("measurements_not_approved");
        }
        if !self.approved_ppids.contains(&agent.ppid) {
            reasons.push("ppid_not_approved");
        }
        if !self.requires_tee && !self.whitelisted_agents_for_local.contains(account_id) {
            reasons.push("not_whitelisted_for_local");
        }
        reasons
    }

    fn require_valid_worker(&self) -> Result<(), ContractError> {
        let account_id = env::predecessor_account_id();
        let agent = self
            .agents
            .get(&account_id)
            .ok_or(ContractError::WorkerNotRegistered)?;
        let reasons = self.invalid_reasons(&account_id, agent);
        if reasons.is_empty() {
            Ok(())
        } else {
            Err(ContractError::WorkerInvalid(reasons.join(",")))
        }
    }

    fn apply_action(
        &mut self,
        action: &Action,
        intent: &SignIntent,
        payload: &[u8],
    ) -> Result<u32, ContractError> {
        let evidence_hash = decode_hash(&intent.evidence_hash)?;
        let now_ms = block_timestamp_ms();

        let (name, subject, trigger_type, payout_amount) = match action {
            Action::SubmitClaim {
                policy,
                trigger_type,
            } => {
                if intent.trigger_type != *trigger_type {
                    return Err(ContractError::IntentMismatch("trigger type differs"));
                }
                self.count_operation(now_ms)?;
                ("oracle_submit_claim", *policy, *trigger_type, 0)
            }
            Action::Payout {
                policy,
                payout_amount,
                bundle_hash,
            } => {
                if evidence_hash != *bundle_hash {
                    return Err(ContractError::IntentMismatch("bundle hash differs"));
                }
                if intent.trigger_type != guardrails::TRIGGER_ORACLE_MANIPULATION {
                    return Err(ContractError::IntentMismatch("trigger type differs"));
                }
                self.count_payout(policy, *payout_amount, bundle_hash, now_ms)?;
                (
                    "verify_and_payout_v2",
                    *policy,
                    guardrails::TRIGGER_ORACLE_MANIPULATION,
                    *payout_amount,
                )
            }
            Action::Attestation { agent } => {
                if intent.trigger_type != 0 {
                    return Err(ContractError::IntentMismatch("attestation has no trigger"));
                }
                self.count_operation(now_ms)?;
                ("upsert_attestation", *agent, 0, 0)
            }
        };

        let id = self.intents.len();
        let record = IntentRecord {
            id,
            action: name.to_string(),
            subject: base58(&subject),
            trigger_type,
            evidence_hash: intent.evidence_hash.clone(),
            solana_tx_message_hash: hex::encode(env::sha256_array(payload)),
            payout_amount: U64(payout_amount),
            worker: env::predecessor_account_id(),
            timestamp_ms: U64(now_ms),
            status: IntentStatus::Requested,
        };
        log!("EVENT_JSON:{}", events::intent_requested(&record));
        self.intents.push(record);
        Ok(id)
    }

    fn count_payout(
        &mut self,
        policy: &Pubkey,
        payout_amount: u64,
        bundle_hash: &[u8; 32],
        now_ms: u64,
    ) -> Result<(), ContractError> {
        // A retry of the same payout is not new exposure, so it is not counted again.
        if let Some(record) = self.payouts.get_mut(policy) {
            if record.payout_amount != payout_amount || record.bundle_hash != *bundle_hash {
                return Err(ContractError::PolicyAlreadyPaid(base58(policy)));
            }
            if record.attempts >= MAX_PAYOUT_ATTEMPTS {
                return Err(ContractError::PayoutRetriesExhausted(base58(policy)));
            }
            record.attempts += 1;
            return Ok(());
        }

        self.payout_window
            .retain(|(timestamp, _)| now_ms.saturating_sub(*timestamp) < DAY_MS);
        let used = self
            .payout_window
            .iter()
            .fold(0u64, |total, (_, amount)| total.saturating_add(*amount));
        let total = used.saturating_add(payout_amount);
        if total > self.max_daily_coverage || self.payout_window.len() >= MAX_WINDOW_ENTRIES {
            return Err(ContractError::DailyCapExceeded {
                used,
                requested: payout_amount,
                cap: self.max_daily_coverage,
            });
        }

        self.payout_window.push((now_ms, payout_amount));
        self.payouts.insert(
            *policy,
            PayoutRecord {
                payout_amount,
                bundle_hash: *bundle_hash,
                attempts: 1,
            },
        );
        Ok(())
    }

    fn count_operation(&mut self, now_ms: u64) -> Result<(), ContractError> {
        self.operation_window
            .retain(|timestamp| now_ms.saturating_sub(*timestamp) < DAY_MS);
        let used = self.operation_window.len();
        let limit = self.max_daily_operations;
        if used >= limit as usize || used >= MAX_WINDOW_ENTRIES {
            return Err(ContractError::DailyOperationLimitExceeded {
                used: used as u32,
                limit,
            });
        }
        self.operation_window.push(now_ms);
        Ok(())
    }

    pub(crate) fn window_usage(&self) -> (u64, u32) {
        let now_ms = block_timestamp_ms();
        let live = |timestamp: u64| now_ms.saturating_sub(timestamp) < DAY_MS;
        let payouts = self
            .payout_window
            .iter()
            .filter(|(timestamp, _)| live(*timestamp))
            .fold(0u64, |total, (_, amount)| total.saturating_add(*amount));
        let operations = self
            .operation_window
            .iter()
            .filter(|timestamp| live(**timestamp))
            .count();
        (payouts, operations as u32)
    }
}

#[cfg(test)]
mod tests;
