use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;

/// AI agent insurance policy.
/// PDA: seeds = [POLICY_SEED, holder.key().as_ref(), &policy_id.to_le_bytes()],
/// where `POLICY_SEED` is `b"covantic_policy"` (see `constants.rs`).
#[account]
#[derive(InitSpace)]
pub struct InsurancePolicy {
    /// Schema version for forward-compatible deserialization.
    ///
    /// Enforced, not merely recorded: every instruction that reads a policy
    /// calls [`InsurancePolicy::assert_readable`] first, so a byte layout this
    /// program was not written for is refused before any state transition
    /// runs. Growing this account is therefore a two-step change — bump
    /// `CURRENT_VERSION` and add a `migrate_policy` instruction — rather than
    /// a field appended and hoped for.
    pub version: u8,

    /// Unique policy ID (from policy_counter)
    pub policy_id: u64,

    /// Policy holder wallet (paid the premium)
    pub holder: Pubkey,

    /// Agent address covered by this policy
    pub agent_address: Pubkey,

    /// Maximum coverage amount in USDC (6 decimals)
    pub coverage_amount: u64,

    /// Premium paid in USDC
    pub premium_paid: u64,

    /// Risk tier: 0=LOW, 1=MEDIUM, 2=HIGH
    pub risk_tier: u8,

    /// Unix timestamp when coverage started
    pub start_time: i64,

    /// Unix timestamp when coverage expires
    pub expiry_time: i64,

    /// Unix timestamp of claim submission (0 if not submitted)
    pub claim_submitted_at: i64,

    /// Current policy state
    /// 0 = Active, 1 = ClaimPending, 2 = ClaimPaid,
    /// 3 = Expired, 4 = Cancelled
    pub state: u8,

    /// Insurance trigger type
    /// 0=None, 1=Exploit, 2=OracleManip, 3=AgentError, 4=GovernanceAttack
    pub trigger_type: u8,

    /// Trigger transaction signature stored as Base58 UTF-8 bytes.
    ///
    /// Validated on write by [`InsurancePolicy::validate_trigger_signature`]:
    /// the bytes must be the Base58 encoding of exactly one 64-byte Solana
    /// signature, so every consumer can decode this field as a transaction
    /// identity rather than as an opaque blob. 88 Base58 characters is the
    /// most a 64-byte value can take.
    #[max_len(88)]
    pub trigger_tx_signature: Vec<u8>,

    /// Actual payout amount (<= coverage_amount)
    pub payout_amount: u64,

    /// PDA bump
    pub bump: u8,
}

impl InsurancePolicy {
    pub const CURRENT_VERSION: u8 = 1;
    pub const STATE_ACTIVE: u8 = 0;
    pub const STATE_CLAIM_PENDING: u8 = 1;
    pub const STATE_CLAIM_PAID: u8 = 2;
    pub const STATE_EXPIRED: u8 = 3;
    pub const STATE_CANCELLED: u8 = 4;

    /// Refuse a persisted policy this program was not written for.
    ///
    /// Anchor's typed loading checks the discriminator and the length, and
    /// nothing else: a version byte from a future layout, or a state or
    /// trigger byte outside the published taxonomy, deserialised happily and
    /// was then interpreted field by field by whichever consumer happened to
    /// load it. An unknown state matched neither `Active` nor `ClaimPending`,
    /// so nothing could advance it, while its coverage stayed counted in the
    /// vault. This is the single gate every consumer runs first.
    pub fn assert_readable(&self) -> Result<()> {
        require!(
            self.version == Self::CURRENT_VERSION,
            CovanticError::UnsupportedPolicyVersion
        );
        require!(
            self.state <= Self::STATE_CANCELLED,
            CovanticError::InvalidPolicyState
        );
        require!(
            self.trigger_type <= TRIGGER_GOVERNANCE_ATTACK,
            CovanticError::InvalidPolicyState
        );
        Ok(())
    }

    /// The payout lock the filed trigger carries. Errors on a policy with no
    /// claim filed, since `TRIGGER_NONE` has no lock to speak of.
    pub fn lock_period(&self) -> Result<i64> {
        match self.trigger_type {
            TRIGGER_EXPLOIT => Ok(LOCK_EXPLOIT),
            TRIGGER_ORACLE_MANIPULATION => Ok(LOCK_ORACLE_MANIPULATION),
            TRIGGER_AGENT_ERROR => Ok(LOCK_AGENT_ERROR),
            TRIGGER_GOVERNANCE_ATTACK => Ok(LOCK_GOVERNANCE_ATTACK),
            _ => Err(CovanticError::InvalidTriggerType.into()),
        }
    }

    /// Accept only the Base58 encoding of exactly one 64-byte signature.
    ///
    /// Both claim entrypoints used to check that the vector was non-empty and
    /// fit the buffer, and nothing more. The indexer then decoded whatever
    /// bytes landed here as UTF-8, the keeper re-encoded that string and asked
    /// an RPC for a transaction that could not exist, and the policy sat in
    /// `ClaimPending` with a claim nothing downstream could resolve. Checking
    /// the encoding here — rather than trusting each consumer to — is what
    /// makes the field mean what its documentation says.
    ///
    /// Decoded with eight 64-bit limbs rather than byte by byte: 88 digits
    /// over 8 limbs is a few hundred multiply-adds, which keeps the check
    /// cheap enough to run on every claim.
    pub fn validate_trigger_signature(bytes: &[u8]) -> Result<()> {
        require!(!bytes.is_empty(), CovanticError::TriggerTxRequired);
        require!(
            bytes.len() <= MAX_TRIGGER_TX_SIG_LEN,
            CovanticError::InvalidTriggerTxSignature
        );
        require!(
            decode_base58_64(bytes).is_some(),
            CovanticError::InvalidTriggerTxSignature
        );
        Ok(())
    }
}

const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58_digit(c: u8) -> Option<u64> {
    BASE58_ALPHABET
        .iter()
        .position(|&a| a == c)
        .map(|p| p as u64)
}

/// Decode `input` as Base58 and return the bytes only if they are exactly 64.
///
/// Canonical Base58 maps each leading `1` to one leading zero byte and the
/// rest of the digits to a big-endian integer with no leading zeros. A string
/// therefore encodes exactly 64 bytes when the count of leading `1`s plus the
/// significant bytes of the integer comes to 64 — which is the same as saying
/// the 64-byte big-endian buffer has precisely that many leading zero bytes.
pub fn decode_base58_64(input: &[u8]) -> Option<[u8; 64]> {
    let leading_ones = input.iter().take_while(|&&c| c == b'1').count();

    // Eight big-endian 64-bit limbs hold 512 bits, which is exactly 64 bytes;
    // any carry out of the top limb means the value does not fit.
    let mut limbs = [0u64; 8];
    for &c in input {
        let mut carry = base58_digit(c)? as u128;
        for limb in limbs.iter_mut().rev() {
            let v = (*limb as u128) * 58 + carry;
            *limb = v as u64;
            carry = v >> 64;
        }
        if carry != 0 {
            return None;
        }
    }

    let mut out = [0u8; 64];
    for (i, limb) in limbs.iter().enumerate() {
        out[i * 8..(i + 1) * 8].copy_from_slice(&limb.to_be_bytes());
    }

    let leading_zero_bytes = out.iter().take_while(|&&b| b == 0).count();
    if leading_zero_bytes != leading_ones {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real devnet transaction signature, 88 characters.
    const REAL_SIGNATURE: &str =
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

    #[test]
    fn accepts_a_real_signature() {
        let decoded = decode_base58_64(REAL_SIGNATURE.as_bytes()).expect("decodes");
        assert_ne!(decoded, [0u8; 64]);
        assert!(InsurancePolicy::validate_trigger_signature(REAL_SIGNATURE.as_bytes()).is_ok());
    }

    #[test]
    fn accepts_the_all_zero_signature_as_sixty_four_ones() {
        let ones = [b'1'; 64];
        assert_eq!(decode_base58_64(&ones), Some([0u8; 64]));
    }

    #[test]
    fn rejects_bytes_outside_the_alphabet() {
        // `0`, `O`, `I` and `l` are excluded from Base58 on purpose.
        let mut bad = REAL_SIGNATURE.as_bytes().to_vec();
        bad[10] = b'0';
        assert!(decode_base58_64(&bad).is_none());
        assert!(InsurancePolicy::validate_trigger_signature(&bad).is_err());
    }

    #[test]
    fn rejects_raw_signature_bytes() {
        // Sixty-four raw bytes — what the old PoC stored — are not Base58.
        let raw = [0x11u8; 64];
        assert!(decode_base58_64(&raw).is_none());
        assert!(InsurancePolicy::validate_trigger_signature(&raw).is_err());
    }

    #[test]
    fn rejects_a_value_that_is_not_exactly_sixty_four_bytes() {
        // An 88-char string of the largest digit overflows 512 bits.
        let huge = [b'z'; 88];
        assert!(decode_base58_64(&huge).is_none());
        // A prefix of `1`s that does not match the zero bytes is not canonical:
        // it would decode to 66 bytes, not 64.
        let mut padded = vec![b'1'; 2];
        padded.extend_from_slice(REAL_SIGNATURE.as_bytes());
        assert!(decode_base58_64(&padded).is_none());
        // A 32-byte pubkey in Base58 is a valid string of the wrong size.
        let pubkey = "11111111111111111111111111111111";
        assert!(decode_base58_64(pubkey.as_bytes()).is_none());
    }

    #[test]
    fn rejects_empty_and_oversized_input() {
        assert!(InsurancePolicy::validate_trigger_signature(&[]).is_err());
        let long = [b'1'; 89];
        assert!(InsurancePolicy::validate_trigger_signature(&long).is_err());
    }

    fn policy() -> InsurancePolicy {
        InsurancePolicy {
            version: InsurancePolicy::CURRENT_VERSION,
            policy_id: 1,
            holder: Pubkey::new_unique(),
            agent_address: Pubkey::new_unique(),
            coverage_amount: 1,
            premium_paid: 1,
            risk_tier: 0,
            start_time: 1,
            expiry_time: 2,
            claim_submitted_at: 0,
            state: InsurancePolicy::STATE_ACTIVE,
            trigger_type: TRIGGER_NONE,
            trigger_tx_signature: vec![],
            payout_amount: 0,
            bump: 255,
        }
    }

    #[test]
    fn a_current_policy_is_readable() {
        assert!(policy().assert_readable().is_ok());
    }

    #[test]
    fn an_unknown_version_is_refused() {
        let mut p = policy();
        p.version = 0;
        assert!(p.assert_readable().is_err());
        p.version = 2;
        assert!(p.assert_readable().is_err());
    }

    #[test]
    fn an_out_of_range_state_or_trigger_is_refused() {
        let mut p = policy();
        p.state = 5;
        assert!(p.assert_readable().is_err());
        let mut p = policy();
        p.trigger_type = 9;
        assert!(p.assert_readable().is_err());
    }

    #[test]
    fn lock_period_follows_the_trigger() {
        let mut p = policy();
        assert!(p.lock_period().is_err());
        p.trigger_type = TRIGGER_GOVERNANCE_ATTACK;
        assert_eq!(p.lock_period().unwrap(), LOCK_GOVERNANCE_ATTACK);
    }
}
