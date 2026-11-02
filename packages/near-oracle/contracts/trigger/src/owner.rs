use crate::*;

#[near]
impl Contract {
    /// Stops all signing. Owner only.
    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
    }

    /// Changes the rolling 24 hour limits. Owner only.
    pub fn set_limits(&mut self, max_daily_coverage: U64, max_daily_operations: u32) {
        self.require_owner();
        self.max_daily_coverage = max_daily_coverage.into();
        self.max_daily_operations = max_daily_operations;
    }

    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.require_owner();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
    }

    pub fn update_owner_id(&mut self, owner_id: AccountId) {
        self.require_owner();
        self.owner_id = owner_id;
    }

    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        self.approved_measurements.insert(measurements);
    }

    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        require!(
            self.approved_measurements.remove(&measurements),
            "Measurements not in approved list"
        );
    }

    pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner();
        for id in ppids {
            require!(self.approved_ppids.remove(&id), "PPID not in approved list");
        }
    }

    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        require!(self.agents.remove(&account_id).is_some(), "Agent not registered");
        Event::AgentRemoved {
            account_id: &account_id,
            reasons: vec!["manual_removal".to_string()],
        }
        .emit();
    }

    /// Local mode only. The whitelisted account must still register.
    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        require!(!self.requires_tee, "Whitelisting agents is not supported for TEE");
        self.require_owner();
        self.whitelisted_agents_for_local.insert(account_id);
    }

    pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
        require!(!self.requires_tee, "Whitelisting agents is not supported for TEE");
        self.require_owner();
        require!(
            self.whitelisted_agents_for_local.remove(&account_id),
            "Agent not in whitelist for local"
        );
    }
}
