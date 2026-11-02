//! Typed refusals. Each code is stable so the demo log and tests can match it.

use near_sdk::{FunctionError, env};
use std::fmt;

use crate::message::ParseError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    /// G1: the caller is not a registered worker.
    WorkerNotRegistered,
    /// G1: the worker's registration is expired or no longer approved.
    WorkerInvalid(String),
    /// G2: the fee payer is not the derived oracle address.
    FeePayerNotOracle,
    /// G2: the message asks for more than the one oracle signature.
    ExtraSignerRequired,
    /// G2: the instruction's oracle account is not the derived address.
    OracleAccountMismatch,
    /// G3: an instruction targets a program outside the allowlist.
    ProgramNotAllowed(String),
    /// G3: a ComputeBudget instruction is unknown or above its bound.
    ComputeBudgetNotAllowed,
    /// G4: the Covantic instruction is not an allowed one.
    InstructionNotAllowed(String),
    /// G4: the transaction must carry exactly one Covantic instruction.
    CovanticInstructionCount(usize),
    /// G4: the instruction's accounts or data do not match its layout.
    InstructionLayoutInvalid(&'static str),
    /// G4: only the oracle-manipulation trigger is enabled.
    TriggerTypeNotAllowed(u8),
    /// G5: this policy already has a signed payout with different terms.
    PolicyAlreadyPaid(String),
    /// G5: the bounded retries for this payout are used up.
    PayoutRetriesExhausted(String),
    /// G6: the payout would pass the rolling 24 hour total.
    DailyCapExceeded { used: u64, requested: u64, cap: u64 },
    /// G6: the rolling 24 hour limit on non-payout signatures is reached.
    DailyOperationLimitExceeded { used: u32, limit: u32 },
    /// G7: signing is paused by the owner.
    ContractPaused,
    /// The message is not one this contract can read.
    MalformedMessage(ParseError),
    /// The intent does not match what the message actually does.
    IntentMismatch(&'static str),
}

impl ContractError {
    /// Stable error code, one per refusal.
    pub fn code(&self) -> &'static str {
        match self {
            Self::WorkerNotRegistered => "G1_WORKER_NOT_REGISTERED",
            Self::WorkerInvalid(_) => "G1_WORKER_INVALID",
            Self::FeePayerNotOracle => "G2_FEE_PAYER_NOT_ORACLE",
            Self::ExtraSignerRequired => "G2_EXTRA_SIGNER_REQUIRED",
            Self::OracleAccountMismatch => "G2_ORACLE_ACCOUNT_MISMATCH",
            Self::ProgramNotAllowed(_) => "G3_PROGRAM_NOT_ALLOWED",
            Self::ComputeBudgetNotAllowed => "G3_COMPUTE_BUDGET_NOT_ALLOWED",
            Self::InstructionNotAllowed(_) => "G4_INSTRUCTION_NOT_ALLOWED",
            Self::CovanticInstructionCount(_) => "G4_COVANTIC_INSTRUCTION_COUNT",
            Self::InstructionLayoutInvalid(_) => "G4_INSTRUCTION_LAYOUT_INVALID",
            Self::TriggerTypeNotAllowed(_) => "G4_TRIGGER_TYPE_NOT_ALLOWED",
            Self::PolicyAlreadyPaid(_) => "G5_POLICY_ALREADY_PAID",
            Self::PayoutRetriesExhausted(_) => "G5_PAYOUT_RETRIES_EXHAUSTED",
            Self::DailyCapExceeded { .. } => "G6_DAILY_CAP_EXCEEDED",
            Self::DailyOperationLimitExceeded { .. } => "G6_DAILY_OPERATION_LIMIT_EXCEEDED",
            Self::ContractPaused => "G7_CONTRACT_PAUSED",
            Self::MalformedMessage(_) => "MESSAGE_MALFORMED",
            Self::IntentMismatch(_) => "INTENT_MISMATCH",
        }
    }
}

impl From<ParseError> for ContractError {
    fn from(error: ParseError) -> Self {
        Self::MalformedMessage(error)
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.code();
        match self {
            Self::WorkerInvalid(reasons) => write!(formatter, "{code}: {reasons}"),
            Self::ProgramNotAllowed(program) => write!(formatter, "{code}: {program}"),
            Self::InstructionNotAllowed(discriminator) => {
                write!(formatter, "{code}: {discriminator}")
            }
            Self::CovanticInstructionCount(count) => {
                write!(formatter, "{code}: found {count}, need exactly 1")
            }
            Self::InstructionLayoutInvalid(reason) => write!(formatter, "{code}: {reason}"),
            Self::TriggerTypeNotAllowed(trigger) => write!(formatter, "{code}: {trigger}"),
            Self::PolicyAlreadyPaid(policy) => write!(formatter, "{code}: {policy}"),
            Self::PayoutRetriesExhausted(policy) => write!(formatter, "{code}: {policy}"),
            Self::DailyCapExceeded {
                used,
                requested,
                cap,
            } => write!(formatter, "{code}: used {used}, requested {requested}, cap {cap}"),
            Self::DailyOperationLimitExceeded { used, limit } => {
                write!(formatter, "{code}: used {used} of {limit}")
            }
            Self::MalformedMessage(error) => write!(formatter, "{code}: {error:?}"),
            Self::IntentMismatch(reason) => write!(formatter, "{code}: {reason}"),
            _ => write!(formatter, "{code}"),
        }
    }
}

impl FunctionError for ContractError {
    fn panic(&self) -> ! {
        env::panic_str(&self.to_string())
    }
}
