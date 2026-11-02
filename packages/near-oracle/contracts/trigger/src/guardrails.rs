//! Stateless guardrails: what a Solana message is allowed to do.
//!
//! `inspect` works out the single action a message performs, or refuses it.
//! Stateful checks (one payout per policy, rolling caps, pause and worker
//! validity) sit in `lib.rs`, because they need contract storage.

use crate::errors::ContractError;
use crate::message::{self, Instruction, Message, Pubkey};

pub const COMPUTE_BUDGET_PROGRAM: Pubkey = [
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
    197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
];

pub const DISCRIMINATOR_ORACLE_SUBMIT_CLAIM: [u8; 8] =
    [0x45, 0x12, 0x48, 0xaa, 0xbd, 0x74, 0xda, 0x4f];
pub const DISCRIMINATOR_VERIFY_AND_PAYOUT_V2: [u8; 8] =
    [0x62, 0x3d, 0xc0, 0x34, 0x32, 0x01, 0xb8, 0xde];
pub const DISCRIMINATOR_UPSERT_ATTESTATION: [u8; 8] =
    [0x2d, 0x05, 0x99, 0x03, 0xde, 0x01, 0xdd, 0x51];

pub const TRIGGER_ORACLE_MANIPULATION: u8 = 2;

const COMPUTE_BUDGET_SET_LIMIT: u8 = 2;
const COMPUTE_BUDGET_SET_PRICE: u8 = 3;
/// Bounds the fee a compromised worker could burn from the oracle address.
/// Limit times price is 0.06 SOL of priority fee per transaction at most.
pub const MAX_COMPUTE_UNIT_LIMIT: u32 = 600_000;
pub const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: u64 = 100_000;

const SUBMIT_CLAIM_ACCOUNTS: usize = 3;
const PAYOUT_ACCOUNTS: usize = 11;
const ATTESTATION_ACCOUNTS: usize = 4;
const POLICY_ACCOUNT_POSITION: usize = 2;

const DISCRIMINATOR_LEN: usize = 8;
const TRIGGER_TYPE_OFFSET: usize = DISCRIMINATOR_LEN;
const SIGNATURE_LEN_OFFSET: usize = TRIGGER_TYPE_OFFSET + 1;
const SIGNATURE_OFFSET: usize = SIGNATURE_LEN_OFFSET + 4;
/// payout_amount, feed_id, trigger_block_time, executed_price, subject_quantity,
/// subject_decimals, bundle_hash.
const PAYOUT_DATA_LEN: usize = DISCRIMINATOR_LEN + 8 + 32 + 8 + 8 + 8 + 1 + 32;
const PAYOUT_AMOUNT_OFFSET: usize = DISCRIMINATOR_LEN;
const BUNDLE_HASH_OFFSET: usize = PAYOUT_DATA_LEN - 32;
/// agent, tier, valid_for_seconds, mandate_hash, envelope_flat_premium, then
/// price terms: feed_id, subject_mint, subject_decimals, max_subject_quantity.
const ATTESTATION_DATA_LEN: usize = DISCRIMINATOR_LEN + 32 + 1 + 8 + 32 + 8 + 32 + 32 + 1 + 8;
const ATTESTATION_AGENT_OFFSET: usize = DISCRIMINATOR_LEN;

/// What the contract checks a message against.
pub struct GuardrailConfig {
    pub oracle_address: Pubkey,
    pub covantic_program: Pubkey,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    SubmitClaim {
        policy: Pubkey,
        trigger_type: u8,
    },
    Payout {
        policy: Pubkey,
        payout_amount: u64,
        bundle_hash: [u8; 32],
    },
    Attestation {
        agent: Pubkey,
    },
}

/// Refuses a message unless it is one allowed action, signed only by the oracle.
pub fn inspect(bytes: &[u8], config: &GuardrailConfig) -> Result<Action, ContractError> {
    let message = message::parse(bytes)?;
    check_signers(&message, config)?;

    let mut covantic = None;
    let mut covantic_count = 0;
    for instruction in &message.instructions {
        let program = message.account_keys[usize::from(instruction.program_id_index)];
        if program == config.covantic_program {
            covantic_count += 1;
            covantic = Some(instruction);
        } else if program == COMPUTE_BUDGET_PROGRAM {
            check_compute_budget(instruction)?;
        } else {
            return Err(ContractError::ProgramNotAllowed(
                bs58::encode(program).into_string(),
            ));
        }
    }

    match covantic {
        Some(instruction) if covantic_count == 1 => decode(&message, instruction),
        _ => Err(ContractError::CovanticInstructionCount(covantic_count)),
    }
}

fn check_signers(message: &Message<'_>, config: &GuardrailConfig) -> Result<(), ContractError> {
    if message.account_keys.first() != Some(&config.oracle_address) {
        return Err(ContractError::FeePayerNotOracle);
    }
    if message.num_required_signatures != 1 {
        return Err(ContractError::ExtraSignerRequired);
    }
    Ok(())
}

fn check_compute_budget(instruction: &Instruction<'_>) -> Result<(), ContractError> {
    let within_bounds = match instruction.data {
        [COMPUTE_BUDGET_SET_LIMIT, value @ ..] => <[u8; 4]>::try_from(value)
            .is_ok_and(|bytes| u32::from_le_bytes(bytes) <= MAX_COMPUTE_UNIT_LIMIT),
        [COMPUTE_BUDGET_SET_PRICE, value @ ..] => <[u8; 8]>::try_from(value).is_ok_and(|bytes| {
            u64::from_le_bytes(bytes) <= MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS
        }),
        _ => false,
    };
    if within_bounds && instruction.accounts.is_empty() {
        Ok(())
    } else {
        Err(ContractError::ComputeBudgetNotAllowed)
    }
}

fn decode(message: &Message<'_>, instruction: &Instruction<'_>) -> Result<Action, ContractError> {
    let data = instruction.data;
    let discriminator: [u8; 8] = data
        .get(..DISCRIMINATOR_LEN)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ContractError::InstructionLayoutInvalid("data too short"))?;

    let (expected_accounts, action): (usize, fn(&Message<'_>, &Instruction<'_>) -> _) =
        match discriminator {
            DISCRIMINATOR_ORACLE_SUBMIT_CLAIM => (SUBMIT_CLAIM_ACCOUNTS, decode_submit_claim),
            DISCRIMINATOR_VERIFY_AND_PAYOUT_V2 => (PAYOUT_ACCOUNTS, decode_payout),
            DISCRIMINATOR_UPSERT_ATTESTATION => (ATTESTATION_ACCOUNTS, decode_attestation),
            other => return Err(ContractError::InstructionNotAllowed(hex::encode(other))),
        };

    if instruction.accounts.len() != expected_accounts {
        return Err(ContractError::InstructionLayoutInvalid("wrong account count"));
    }
    // The fee payer is index zero, so this binds the program's oracle account to it.
    if instruction.accounts[0] != 0 {
        return Err(ContractError::OracleAccountMismatch);
    }
    action(message, instruction)
}

fn policy_key(message: &Message<'_>, instruction: &Instruction<'_>) -> Pubkey {
    message.account_keys[usize::from(instruction.accounts[POLICY_ACCOUNT_POSITION])]
}

fn decode_submit_claim(
    message: &Message<'_>,
    instruction: &Instruction<'_>,
) -> Result<Action, ContractError> {
    let data = instruction.data;
    let trigger_type = *data
        .get(TRIGGER_TYPE_OFFSET)
        .ok_or(ContractError::InstructionLayoutInvalid("missing trigger type"))?;
    let signature_len: [u8; 4] = data
        .get(SIGNATURE_LEN_OFFSET..SIGNATURE_OFFSET)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ContractError::InstructionLayoutInvalid("missing signature length"))?;
    let expected_len = usize::try_from(u32::from_le_bytes(signature_len))
        .ok()
        .and_then(|len| len.checked_add(SIGNATURE_OFFSET))
        .ok_or(ContractError::InstructionLayoutInvalid("signature length overflow"))?;
    if data.len() != expected_len {
        return Err(ContractError::InstructionLayoutInvalid("wrong data length"));
    }
    if trigger_type != TRIGGER_ORACLE_MANIPULATION {
        return Err(ContractError::TriggerTypeNotAllowed(trigger_type));
    }
    Ok(Action::SubmitClaim {
        policy: policy_key(message, instruction),
        trigger_type,
    })
}

fn decode_payout(
    message: &Message<'_>,
    instruction: &Instruction<'_>,
) -> Result<Action, ContractError> {
    let data = instruction.data;
    if data.len() != PAYOUT_DATA_LEN {
        return Err(ContractError::InstructionLayoutInvalid("wrong data length"));
    }
    let amount: [u8; 8] = data[PAYOUT_AMOUNT_OFFSET..PAYOUT_AMOUNT_OFFSET + 8]
        .try_into()
        .map_err(|_| ContractError::InstructionLayoutInvalid("bad payout amount"))?;
    let bundle_hash: [u8; 32] = data[BUNDLE_HASH_OFFSET..]
        .try_into()
        .map_err(|_| ContractError::InstructionLayoutInvalid("bad bundle hash"))?;
    Ok(Action::Payout {
        policy: policy_key(message, instruction),
        payout_amount: u64::from_le_bytes(amount),
        bundle_hash,
    })
}

fn decode_attestation(
    _message: &Message<'_>,
    instruction: &Instruction<'_>,
) -> Result<Action, ContractError> {
    let data = instruction.data;
    if data.len() != ATTESTATION_DATA_LEN {
        return Err(ContractError::InstructionLayoutInvalid("wrong data length"));
    }
    let agent: Pubkey = data[ATTESTATION_AGENT_OFFSET..ATTESTATION_AGENT_OFFSET + 32]
        .try_into()
        .map_err(|_| ContractError::InstructionLayoutInvalid("bad agent key"))?;
    Ok(Action::Attestation { agent })
}

#[cfg(test)]
pub mod test_support {
    //! Builds legacy Solana messages for the guardrail tests.

    use super::*;

    pub const ORACLE: Pubkey = [1; 32];
    pub const COVANTIC: Pubkey = [2; 32];
    pub const POLICY: Pubkey = [3; 32];
    pub const OTHER_SIGNER: Pubkey = [4; 32];
    pub const SYSTEM_PROGRAM: Pubkey = [0; 32];
    pub const TOKEN_PROGRAM: Pubkey = [6; 32];

    pub fn config() -> GuardrailConfig {
        GuardrailConfig {
            oracle_address: ORACLE,
            covantic_program: COVANTIC,
        }
    }

    pub struct Ix {
        pub program: Pubkey,
        pub accounts: Vec<Pubkey>,
        pub data: Vec<u8>,
    }

    fn compact(mut value: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    /// Serialises a message with `signers` first, then every other key.
    pub fn build(signers: &[Pubkey], instructions: &[Ix]) -> Vec<u8> {
        let mut keys: Vec<Pubkey> = signers.to_vec();
        for instruction in instructions {
            for key in instruction.accounts.iter().chain([&instruction.program]) {
                if !keys.contains(key) {
                    keys.push(*key);
                }
            }
        }
        let index = |key: &Pubkey| keys.iter().position(|k| k == key).unwrap() as u8;

        let mut bytes = vec![signers.len() as u8, 0, 0];
        compact(keys.len(), &mut bytes);
        keys.iter().for_each(|key| bytes.extend_from_slice(key));
        bytes.extend_from_slice(&[9; 32]);
        compact(instructions.len(), &mut bytes);
        for instruction in instructions {
            bytes.push(index(&instruction.program));
            compact(instruction.accounts.len(), &mut bytes);
            bytes.extend(instruction.accounts.iter().map(index));
            compact(instruction.data.len(), &mut bytes);
            bytes.extend_from_slice(&instruction.data);
        }
        bytes
    }

    pub fn submit_claim_ix(trigger_type: u8) -> Ix {
        let mut data = DISCRIMINATOR_ORACLE_SUBMIT_CLAIM.to_vec();
        data.push(trigger_type);
        data.extend_from_slice(&88u32.to_le_bytes());
        data.extend_from_slice(&[b'1'; 88]);
        Ix {
            program: COVANTIC,
            accounts: vec![ORACLE, [10; 32], POLICY],
            data,
        }
    }

    pub fn payout_ix(policy: Pubkey, amount: u64, bundle_hash: [u8; 32]) -> Ix {
        let mut data = DISCRIMINATOR_VERIFY_AND_PAYOUT_V2.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&[7; 32]);
        data.extend_from_slice(&[0; 8 + 8 + 8 + 1]);
        data.extend_from_slice(&bundle_hash);
        let mut accounts = vec![ORACLE, [10; 32], policy];
        accounts.extend((11u8..19).map(|seed| [seed; 32]));
        Ix {
            program: COVANTIC,
            accounts,
            data,
        }
    }

    pub fn attestation_ix(agent: Pubkey) -> Ix {
        let mut data = DISCRIMINATOR_UPSERT_ATTESTATION.to_vec();
        data.extend_from_slice(&agent);
        data.resize(ATTESTATION_DATA_LEN, 0);
        Ix {
            program: COVANTIC,
            accounts: vec![ORACLE, [10; 32], [20; 32], SYSTEM_PROGRAM],
            data,
        }
    }

    pub fn compute_budget_ix(data: Vec<u8>) -> Ix {
        Ix {
            program: COMPUTE_BUDGET_PROGRAM,
            accounts: vec![],
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn inspect_ixs(instructions: &[Ix]) -> Result<Action, ContractError> {
        inspect(&build(&[ORACLE], instructions), &config())
    }

    fn set_limit(units: u32) -> Vec<u8> {
        let mut data = vec![COMPUTE_BUDGET_SET_LIMIT];
        data.extend_from_slice(&units.to_le_bytes());
        data
    }

    fn set_price(micro_lamports: u64) -> Vec<u8> {
        let mut data = vec![COMPUTE_BUDGET_SET_PRICE];
        data.extend_from_slice(&micro_lamports.to_le_bytes());
        data
    }

    #[test]
    fn allows_a_claim_with_compute_budget() {
        let action = inspect_ixs(&[
            compute_budget_ix(set_limit(MAX_COMPUTE_UNIT_LIMIT)),
            compute_budget_ix(set_price(MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS)),
            submit_claim_ix(TRIGGER_ORACLE_MANIPULATION),
        ]);
        assert_eq!(
            action,
            Ok(Action::SubmitClaim {
                policy: POLICY,
                trigger_type: TRIGGER_ORACLE_MANIPULATION,
            })
        );
    }

    #[test]
    fn allows_a_payout_and_reads_its_amount_and_hash() {
        let action = inspect_ixs(&[payout_ix(POLICY, 1_000_000, [5; 32])]);
        assert_eq!(
            action,
            Ok(Action::Payout {
                policy: POLICY,
                payout_amount: 1_000_000,
                bundle_hash: [5; 32],
            })
        );
    }

    #[test]
    fn allows_an_attestation() {
        let action = inspect_ixs(&[attestation_ix([30; 32])]);
        assert_eq!(action, Ok(Action::Attestation { agent: [30; 32] }));
    }

    #[test]
    fn g2_refuses_a_fee_payer_other_than_the_oracle() {
        let message = build(&[OTHER_SIGNER], &[submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)]);
        assert_eq!(inspect(&message, &config()), Err(ContractError::FeePayerNotOracle));
    }

    #[test]
    fn g2_refuses_a_second_required_signer() {
        let message = build(
            &[ORACLE, OTHER_SIGNER],
            &[submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)],
        );
        assert_eq!(inspect(&message, &config()), Err(ContractError::ExtraSignerRequired));
    }

    #[test]
    fn g2_refuses_an_oracle_account_that_is_not_the_fee_payer() {
        let mut instruction = submit_claim_ix(TRIGGER_ORACLE_MANIPULATION);
        instruction.accounts[0] = OTHER_SIGNER;
        assert_eq!(inspect_ixs(&[instruction]), Err(ContractError::OracleAccountMismatch));
    }

    #[test]
    fn g3_refuses_a_system_program_transfer() {
        let transfer = Ix {
            program: SYSTEM_PROGRAM,
            accounts: vec![ORACLE, OTHER_SIGNER],
            data: vec![2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        };
        let action = inspect_ixs(&[transfer, submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)]);
        assert_eq!(action.unwrap_err().code(), "G3_PROGRAM_NOT_ALLOWED");
    }

    #[test]
    fn g3_refuses_a_token_program_instruction() {
        let transfer = Ix {
            program: TOKEN_PROGRAM,
            accounts: vec![OTHER_SIGNER, ORACLE],
            data: vec![3, 1, 0, 0, 0, 0, 0, 0, 0],
        };
        assert_eq!(inspect_ixs(&[transfer]).unwrap_err().code(), "G3_PROGRAM_NOT_ALLOWED");
    }

    #[test]
    fn g3_refuses_a_compute_budget_above_its_bounds() {
        for data in [
            set_limit(MAX_COMPUTE_UNIT_LIMIT + 1),
            set_price(MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS + 1),
        ] {
            let action = inspect_ixs(&[
                compute_budget_ix(data),
                submit_claim_ix(TRIGGER_ORACLE_MANIPULATION),
            ]);
            assert_eq!(action, Err(ContractError::ComputeBudgetNotAllowed));
        }
    }

    #[test]
    fn g3_refuses_an_unknown_compute_budget_instruction() {
        let action = inspect_ixs(&[
            compute_budget_ix(vec![1, 0, 0, 1, 0]),
            submit_claim_ix(TRIGGER_ORACLE_MANIPULATION),
        ]);
        assert_eq!(action, Err(ContractError::ComputeBudgetNotAllowed));
    }

    #[test]
    fn g4_refuses_a_covantic_instruction_outside_the_list() {
        let mut instruction = submit_claim_ix(TRIGGER_ORACLE_MANIPULATION);
        instruction.data[..8].copy_from_slice(&[0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63]);
        assert_eq!(
            inspect_ixs(&[instruction]).unwrap_err().code(),
            "G4_INSTRUCTION_NOT_ALLOWED"
        );
    }

    #[test]
    fn g4_refuses_two_covantic_instructions() {
        let action = inspect_ixs(&[
            payout_ix(POLICY, 1, [5; 32]),
            payout_ix([40; 32], 1, [5; 32]),
        ]);
        assert_eq!(action, Err(ContractError::CovanticInstructionCount(2)));
    }

    #[test]
    fn g4_refuses_a_message_with_no_covantic_instruction() {
        let action = inspect_ixs(&[compute_budget_ix(set_limit(1))]);
        assert_eq!(action, Err(ContractError::CovanticInstructionCount(0)));
    }

    #[test]
    fn g4_refuses_triggers_other_than_oracle_manipulation() {
        for trigger in [1, 3, 4] {
            assert_eq!(
                inspect_ixs(&[submit_claim_ix(trigger)]),
                Err(ContractError::TriggerTypeNotAllowed(trigger))
            );
        }
    }

    #[test]
    fn g4_refuses_wrong_account_counts() {
        let mut instruction = payout_ix(POLICY, 1, [5; 32]);
        instruction.accounts.pop();
        assert_eq!(
            inspect_ixs(&[instruction]),
            Err(ContractError::InstructionLayoutInvalid("wrong account count"))
        );
    }

    #[test]
    fn g4_refuses_extra_instruction_data() {
        let mut payout = payout_ix(POLICY, 1, [5; 32]);
        payout.data.push(0);
        let mut claim = submit_claim_ix(TRIGGER_ORACLE_MANIPULATION);
        claim.data.push(0);
        let mut attestation = attestation_ix([30; 32]);
        attestation.data.push(0);
        for instruction in [payout, claim, attestation] {
            assert_eq!(
                inspect_ixs(&[instruction]),
                Err(ContractError::InstructionLayoutInvalid("wrong data length"))
            );
        }
    }

    #[test]
    fn refuses_a_versioned_message() {
        let mut message = build(&[ORACLE], &[submit_claim_ix(TRIGGER_ORACLE_MANIPULATION)]);
        message.insert(0, 0x80);
        assert_eq!(inspect(&message, &config()).unwrap_err().code(), "MESSAGE_MALFORMED");
    }

    #[test]
    fn discriminators_match_the_committed_idl() {
        let idl = include_str!("../../../idl/covantic.json");
        for (name, discriminator) in [
            ("oracle_submit_claim", DISCRIMINATOR_ORACLE_SUBMIT_CLAIM),
            ("verify_and_payout_v2", DISCRIMINATOR_VERIFY_AND_PAYOUT_V2),
            ("upsert_attestation", DISCRIMINATOR_UPSERT_ATTESTATION),
        ] {
            let parsed: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(idl).unwrap();
            let instruction = parsed["instructions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|instruction| instruction["name"] == name)
                .unwrap();
            let expected: Vec<u8> = instruction["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(expected, discriminator, "{name}");
        }
    }
}
