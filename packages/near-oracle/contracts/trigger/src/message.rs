//! Minimal parser for a legacy Solana transaction message.
//!
//! The contract signs raw message bytes, so this parser and the Solana runtime
//! must read those bytes the same way. Any input Solana would interpret
//! differently is a guardrail bypass, which is why the rules below follow the
//! runtime's: canonical compact-u16 lengths, in-range indices, no trailing
//! bytes and no duplicate account keys. Anything else is rejected, including
//! every versioned message.

pub type Pubkey = [u8; 32];

const PUBKEY_LEN: usize = 32;
const HEADER_LEN: usize = 3;
/// Bit set on the first byte of a versioned message.
const VERSION_PREFIX: u8 = 0x80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    VersionedMessage,
    Truncated,
    InvalidCompactU16,
    TrailingBytes,
    InvalidHeader,
    DuplicateAccountKey,
    ProgramIndexOutOfRange,
    AccountIndexOutOfRange,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Instruction<'a> {
    pub program_id_index: u8,
    pub accounts: &'a [u8],
    pub data: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub struct Message<'a> {
    pub num_required_signatures: u8,
    pub num_readonly_signed: u8,
    pub num_readonly_unsigned: u8,
    pub account_keys: Vec<Pubkey>,
    pub recent_blockhash: Pubkey,
    pub instructions: Vec<Instruction<'a>>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], ParseError> {
        let end = self.offset.checked_add(len).ok_or(ParseError::Truncated)?;
        let slice = self.bytes.get(self.offset..end).ok_or(ParseError::Truncated)?;
        self.offset = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, ParseError> {
        Ok(self.take(1)?[0])
    }

    /// Reads a compact-u16 with the same rules as Solana's `short_vec`: at most
    /// three bytes, no value above `u16::MAX`, and no non-canonical encoding.
    fn compact_u16(&mut self) -> Result<usize, ParseError> {
        let mut value: u32 = 0;
        for position in 0..3 {
            let byte = self.byte()?;
            if position > 0 && byte == 0 {
                return Err(ParseError::InvalidCompactU16);
            }
            if position == 2 && byte & 0x80 != 0 {
                return Err(ParseError::InvalidCompactU16);
            }
            value |= u32::from(byte & 0x7f) << (position * 7);
            if byte & 0x80 == 0 {
                return u16::try_from(value)
                    .map(usize::from)
                    .map_err(|_| ParseError::InvalidCompactU16);
            }
        }
        Err(ParseError::InvalidCompactU16)
    }
}

pub fn parse(bytes: &[u8]) -> Result<Message<'_>, ParseError> {
    let first = *bytes.first().ok_or(ParseError::Truncated)?;
    if first & VERSION_PREFIX != 0 {
        return Err(ParseError::VersionedMessage);
    }

    let mut reader = Reader { bytes, offset: 0 };
    let header = reader.take(HEADER_LEN)?;
    let (num_required_signatures, num_readonly_signed, num_readonly_unsigned) =
        (header[0], header[1], header[2]);

    let key_count = reader.compact_u16()?;
    let mut account_keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let key: Pubkey = reader
            .take(PUBKEY_LEN)?
            .try_into()
            .map_err(|_| ParseError::Truncated)?;
        if account_keys.contains(&key) {
            return Err(ParseError::DuplicateAccountKey);
        }
        account_keys.push(key);
    }

    let signed_and_unsigned =
        usize::from(num_required_signatures) + usize::from(num_readonly_unsigned);
    if num_required_signatures == 0
        || num_readonly_signed >= num_required_signatures
        || signed_and_unsigned > key_count
    {
        return Err(ParseError::InvalidHeader);
    }

    let recent_blockhash: Pubkey = reader
        .take(PUBKEY_LEN)?
        .try_into()
        .map_err(|_| ParseError::Truncated)?;

    let instruction_count = reader.compact_u16()?;
    let mut instructions = Vec::with_capacity(instruction_count);
    for _ in 0..instruction_count {
        let program_id_index = reader.byte()?;
        // Index zero is the fee payer, which the runtime never treats as a program.
        if program_id_index == 0 || usize::from(program_id_index) >= key_count {
            return Err(ParseError::ProgramIndexOutOfRange);
        }

        let account_count = reader.compact_u16()?;
        let accounts = reader.take(account_count)?;
        if accounts.iter().any(|&index| usize::from(index) >= key_count) {
            return Err(ParseError::AccountIndexOutOfRange);
        }

        let data_len = reader.compact_u16()?;
        let data = reader.take(data_len)?;
        instructions.push(Instruction {
            program_id_index,
            accounts,
            data,
        });
    }

    if reader.offset != bytes.len() {
        return Err(ParseError::TrailingBytes);
    }

    Ok(Message {
        num_required_signatures,
        num_readonly_signed,
        num_readonly_unsigned,
        account_keys,
        recent_blockhash,
        instructions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> Pubkey {
        [seed; 32]
    }

    /// One signer, one read-only program, one instruction.
    fn valid_message() -> Vec<u8> {
        let mut bytes = vec![1, 0, 1, 2];
        bytes.extend_from_slice(&key(1));
        bytes.extend_from_slice(&key(2));
        bytes.extend_from_slice(&key(9));
        bytes.extend_from_slice(&[1, 1, 1, 0, 2, 0xaa, 0xbb]);
        bytes
    }

    #[test]
    fn parses_a_legacy_message() {
        let bytes = valid_message();
        let message = parse(&bytes).unwrap();
        assert_eq!(message.num_required_signatures, 1);
        assert_eq!(message.account_keys, vec![key(1), key(2)]);
        assert_eq!(message.recent_blockhash, key(9));
        assert_eq!(message.instructions[0].program_id_index, 1);
        assert_eq!(message.instructions[0].accounts, &[0]);
        assert_eq!(message.instructions[0].data, &[0xaa, 0xbb]);
    }

    #[test]
    fn rejects_versioned_messages() {
        let mut bytes = valid_message();
        bytes.insert(0, 0x80);
        assert_eq!(parse(&bytes), Err(ParseError::VersionedMessage));
    }

    #[test]
    fn rejects_empty_input() {
        assert_eq!(parse(&[]), Err(ParseError::Truncated));
    }

    #[test]
    fn rejects_every_truncation() {
        let bytes = valid_message();
        for len in 1..bytes.len() {
            assert!(parse(&bytes[..len]).is_err(), "length {len} parsed");
        }
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bytes = valid_message();
        bytes.push(0);
        assert_eq!(parse(&bytes), Err(ParseError::TrailingBytes));
    }

    #[test]
    fn rejects_duplicate_keys() {
        let mut bytes = vec![1, 0, 1, 2];
        bytes.extend_from_slice(&key(1));
        bytes.extend_from_slice(&key(1));
        assert_eq!(parse(&bytes), Err(ParseError::DuplicateAccountKey));
    }

    #[test]
    fn rejects_zero_signers() {
        let mut bytes = valid_message();
        bytes[0] = 0;
        assert_eq!(parse(&bytes), Err(ParseError::InvalidHeader));
    }

    #[test]
    fn rejects_read_only_fee_payer() {
        let mut bytes = valid_message();
        bytes[1] = 1;
        assert_eq!(parse(&bytes), Err(ParseError::InvalidHeader));
    }

    #[test]
    fn rejects_header_counts_above_key_count() {
        let mut bytes = valid_message();
        bytes[2] = 2;
        assert_eq!(parse(&bytes), Err(ParseError::InvalidHeader));
    }

    #[test]
    fn rejects_fee_payer_as_program() {
        let mut bytes = valid_message();
        let index = 4 + 32 * 3 + 1;
        bytes[index] = 0;
        assert_eq!(parse(&bytes), Err(ParseError::ProgramIndexOutOfRange));
    }

    #[test]
    fn rejects_program_index_out_of_range() {
        let mut bytes = valid_message();
        let index = 4 + 32 * 3 + 1;
        bytes[index] = 2;
        assert_eq!(parse(&bytes), Err(ParseError::ProgramIndexOutOfRange));
    }

    #[test]
    fn rejects_account_index_out_of_range() {
        let mut bytes = valid_message();
        let index = 4 + 32 * 3 + 3;
        bytes[index] = 2;
        assert_eq!(parse(&bytes), Err(ParseError::AccountIndexOutOfRange));
    }

    #[test]
    fn compact_u16_matches_the_solana_encoding() {
        let read = |bytes: &[u8]| Reader { bytes, offset: 0 }.compact_u16();
        assert_eq!(read(&[0x00]), Ok(0));
        assert_eq!(read(&[0x7f]), Ok(127));
        assert_eq!(read(&[0x80, 0x01]), Ok(128));
        assert_eq!(read(&[0xff, 0x7f]), Ok(16_383));
        assert_eq!(read(&[0x80, 0x80, 0x01]), Ok(16_384));
        assert_eq!(read(&[0xff, 0xff, 0x03]), Ok(65_535));
    }

    #[test]
    fn compact_u16_rejects_non_canonical_and_oversized_values() {
        let read = |bytes: &[u8]| Reader { bytes, offset: 0 }.compact_u16();
        assert_eq!(read(&[0x80, 0x00]), Err(ParseError::InvalidCompactU16));
        assert_eq!(read(&[0x80, 0x80, 0x00]), Err(ParseError::InvalidCompactU16));
        assert_eq!(read(&[0xff, 0xff, 0x04]), Err(ParseError::InvalidCompactU16));
        assert_eq!(read(&[0x80, 0x80, 0x80]), Err(ParseError::InvalidCompactU16));
    }
}
