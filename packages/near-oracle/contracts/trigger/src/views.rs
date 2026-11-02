use crate::*;

#[near(serializers = [json])]
pub struct ContractInfo {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: U64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub paused: bool,
    pub derivation_path: String,
    pub oracle_address: String,
    pub covantic_program: String,
    pub max_daily_coverage: U64,
    pub max_daily_operations: u32,
    pub daily_coverage_used: U64,
    pub daily_operations_used: u32,
    pub intent_count: u32,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub account_id: AccountId,
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: U64,
    pub invalid_reasons: Vec<String>,
}

#[near(serializers = [json])]
pub struct PayoutView {
    pub payout_amount: U64,
    pub bundle_hash: String,
    pub attempts: u8,
}

#[near]
impl Contract {
    pub fn get_contract_info(&self) -> ContractInfo {
        let (daily_coverage_used, daily_operations_used) = self.window_usage();
        ContractInfo {
            requires_tee: self.requires_tee,
            attestation_expiration_time_ms: U64::from(self.attestation_expiration_time_ms),
            owner_id: self.owner_id.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
            paused: self.paused,
            derivation_path: self.derivation_path.clone(),
            oracle_address: base58(&self.oracle_address),
            covantic_program: base58(&self.covantic_program),
            max_daily_coverage: U64(self.max_daily_coverage),
            max_daily_operations: self.max_daily_operations,
            daily_coverage_used: U64(daily_coverage_used),
            daily_operations_used,
            intent_count: self.intents.len(),
        }
    }

    pub fn get_approved_measurements(&self) -> Vec<FullMeasurementsHex> {
        self.approved_measurements.iter().cloned().collect()
    }

    pub fn get_approved_ppids(&self) -> Vec<Ppid> {
        self.approved_ppids.iter().cloned().collect()
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents.get(&account_id).map(|agent| AgentView {
            account_id: account_id.clone(),
            measurements: agent.measurements.clone(),
            ppid: agent.ppid.clone(),
            valid_until_ms: U64::from(agent.valid_until_ms),
            invalid_reasons: self
                .invalid_reasons(&account_id, agent)
                .into_iter()
                .map(str::to_string)
                .collect(),
        })
    }

    /// The signed payout recorded for a policy, by base58 policy key.
    pub fn get_payout(&self, policy: String) -> Option<PayoutView> {
        self.payouts
            .get(&decode_pubkey(&policy, "policy"))
            .map(|record| PayoutView {
                payout_amount: U64(record.payout_amount),
                bundle_hash: hex::encode(record.bundle_hash),
                attempts: record.attempts,
            })
    }

    /// The signing log, oldest first.
    pub fn get_intents(&self, from_index: u32, limit: u32) -> Vec<IntentRecord> {
        self.intents
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }
}
