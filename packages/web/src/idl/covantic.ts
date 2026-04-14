import type { Idl } from '@coral-xyz/anchor';

/**
 * Anchor IDL for the Covantic insurance program.
 * Discriminators are sha256("global|account|event:name")[0..8].
 * Address matches the on-chain program ID on devnet.
 */
export const COVANTIC_IDL = {
  address: '91TyFjPEKeKevThuZmfvYzFpzHhchVLtPYf5nLiUzoV7',
  metadata: {
    name: 'covantic',
    version: '0.1.0',
    spec: '0.1.0',
    description: 'AI Agent Insurance Protocol on Solana',
  },
  instructions: [
    {
      name: 'initialize',
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237],
      accounts: [
        { name: 'admin', writable: true, signer: true },
        {
          name: 'config',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 99, 111, 110, 102, 105, 103] }] },
        },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'usdc_mint' },
        { name: 'vault_token_account', writable: true },
        { name: 'system_program', address: '11111111111111111111111111111111' },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { name: 'associated_token_program', address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' },
        { name: 'rent', address: 'SysvarRent111111111111111111111111111111111' },
      ],
      args: [{ name: 'oracle_authority', type: 'pubkey' }],
    },
    {
      name: 'create_policy',
      discriminator: [27, 81, 33, 27, 196, 103, 246, 53],
      accounts: [
        { name: 'holder', writable: true, signer: true },
        {
          name: 'config',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 99, 111, 110, 102, 105, 103] }] },
        },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'policy', writable: true },
        { name: 'holder_token_account', writable: true },
        { name: 'vault_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { name: 'system_program', address: '11111111111111111111111111111111' },
      ],
      args: [
        { name: 'coverage_amount', type: 'u64' },
        { name: 'duration_seconds', type: 'i64' },
        { name: 'risk_tier', type: 'u8' },
        { name: 'agent_address', type: 'pubkey' },
      ],
    },
    {
      name: 'cancel_policy',
      discriminator: [244, 58, 241, 221, 106, 151, 94, 116],
      accounts: [
        { name: 'holder', writable: true, signer: true },
        { name: 'policy', writable: true },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'vault_token_account', writable: true },
        { name: 'holder_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      ],
      args: [],
    },
    {
      name: 'submit_claim',
      discriminator: [163, 108, 111, 46, 220, 82, 77, 212],
      accounts: [
        { name: 'holder', signer: true },
        { name: 'policy', writable: true },
      ],
      args: [
        { name: 'trigger_type', type: 'u8' },
        { name: 'trigger_tx_signature', type: 'bytes' },
      ],
    },
    {
      name: 'oracle_submit_claim',
      discriminator: [69, 18, 72, 170, 189, 116, 218, 79],
      accounts: [
        { name: 'oracle', signer: true },
        {
          name: 'config',
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 99, 111, 110, 102, 105, 103] }] },
        },
        { name: 'policy', writable: true },
      ],
      args: [
        { name: 'trigger_type', type: 'u8' },
        { name: 'trigger_tx_signature', type: 'bytes' },
      ],
    },
    {
      name: 'verify_and_payout',
      discriminator: [31, 127, 176, 128, 240, 238, 14, 91],
      accounts: [
        { name: 'oracle', writable: true, signer: true },
        {
          name: 'config',
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 99, 111, 110, 102, 105, 103] }] },
        },
        { name: 'policy', writable: true },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'vault_token_account', writable: true },
        { name: 'holder_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      ],
      args: [{ name: 'payout_amount', type: 'u64' }],
    },
    {
      name: 'expire_policy',
      discriminator: [149, 24, 43, 100, 240, 50, 39, 124],
      accounts: [
        { name: 'cranker', signer: true },
        { name: 'policy', writable: true },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
      ],
      args: [],
    },
    {
      name: 'stake',
      discriminator: [206, 176, 202, 18, 200, 209, 179, 108],
      accounts: [
        { name: 'staker', writable: true, signer: true },
        {
          name: 'config',
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 99, 111, 110, 102, 105, 103] }] },
        },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'staker_position', writable: true },
        { name: 'staker_token_account', writable: true },
        { name: 'vault_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { name: 'system_program', address: '11111111111111111111111111111111' },
      ],
      args: [{ name: 'amount', type: 'u64' }],
    },
    {
      name: 'request_unstake',
      discriminator: [44, 154, 110, 253, 160, 202, 54, 34],
      accounts: [
        { name: 'staker', signer: true },
        { name: 'staker_position', writable: true },
      ],
      args: [],
    },
    {
      name: 'execute_unstake',
      discriminator: [136, 166, 210, 104, 134, 184, 142, 230],
      accounts: [
        { name: 'staker', writable: true, signer: true },
        { name: 'staker_position', writable: true },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'vault_token_account', writable: true },
        { name: 'staker_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      ],
      args: [],
    },
    {
      name: 'claim_rewards',
      discriminator: [4, 144, 132, 71, 116, 23, 151, 80],
      accounts: [
        { name: 'staker', writable: true, signer: true },
        { name: 'staker_position', writable: true },
        {
          name: 'vault',
          writable: true,
          pda: { seeds: [{ kind: 'const', value: [99, 111, 118, 97, 110, 116, 105, 99, 95, 118, 97, 117, 108, 116] }] },
        },
        { name: 'vault_token_account', writable: true },
        { name: 'staker_token_account', writable: true },
        { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: 'ProtocolConfig', discriminator: [207, 91, 250, 28, 152, 179, 215, 209] },
    { name: 'InsuranceVault', discriminator: [131, 200, 252, 180, 131, 202, 30, 144] },
    { name: 'InsurancePolicy', discriminator: [171, 170, 55, 125, 71, 125, 63, 48] },
    { name: 'StakerPosition', discriminator: [202, 156, 49, 48, 230, 210, 246, 197] },
  ],
  events: [
    { name: 'PolicyCreated', discriminator: [59, 189, 65, 121, 86, 157, 108, 10] },
    { name: 'ClaimSubmitted', discriminator: [95, 1, 120, 227, 177, 240, 174, 52] },
    { name: 'ClaimPaid', discriminator: [212, 155, 88, 118, 128, 99, 132, 42] },
    { name: 'PolicyCancelled', discriminator: [33, 213, 35, 84, 4, 212, 181, 237] },
    { name: 'PolicyExpiredEvent', discriminator: [1, 178, 124, 200, 124, 152, 195, 216] },
    { name: 'Staked', discriminator: [11, 146, 45, 205, 230, 58, 213, 240] },
    { name: 'UnstakeRequested', discriminator: [21, 253, 177, 85, 129, 206, 42, 152] },
    { name: 'Unstaked', discriminator: [27, 179, 156, 215, 47, 71, 195, 7] },
    { name: 'RewardsClaimed', discriminator: [75, 98, 88, 18, 219, 112, 88, 121] },
  ],
  errors: [
    { code: 6000, name: 'CoverageTooLow', msg: 'Coverage amount below minimum (1 USDC)' },
    { code: 6001, name: 'CoverageTooHigh', msg: 'Coverage amount exceeds maximum (1,000,000 USDC)' },
    { code: 6002, name: 'DurationTooShort', msg: 'Policy duration below minimum (1 hour)' },
    { code: 6003, name: 'DurationTooLong', msg: 'Policy duration exceeds maximum (30 days)' },
    { code: 6004, name: 'InvalidRiskTier', msg: 'Invalid risk tier (must be 0=LOW, 1=MEDIUM, or 2=HIGH)' },
    { code: 6005, name: 'PolicyNotActive', msg: 'Policy is not in Active state' },
    { code: 6006, name: 'PolicyExpired', msg: 'Policy has expired' },
    { code: 6007, name: 'PolicyNotExpired', msg: 'Policy has not expired yet' },
    { code: 6008, name: 'MaxPoliciesReached', msg: 'Maximum policies per wallet reached (10)' },
    { code: 6009, name: 'IncorrectPremium', msg: 'Incorrect premium amount' },
    { code: 6010, name: 'ClaimAlreadySubmitted', msg: 'Claim already submitted for this policy' },
    { code: 6011, name: 'InvalidTriggerType', msg: 'Invalid trigger type' },
    { code: 6012, name: 'TriggerTxRequired', msg: 'Trigger transaction signature is required' },
    { code: 6013, name: 'LockPeriodNotElapsed', msg: 'Lock period has not elapsed' },
    { code: 6014, name: 'PayoutExceedsCoverage', msg: 'Payout exceeds coverage amount' },
    { code: 6015, name: 'PolicyNotClaimPending', msg: 'Policy is not in ClaimPending state' },
    { code: 6016, name: 'InsufficientVaultBalance', msg: 'Insufficient vault balance for payout' },
    { code: 6017, name: 'ProtocolPaused', msg: 'Protocol is paused — no new policies or stakes' },
    { code: 6018, name: 'SolvencyTooLow', msg: 'Solvency ratio too low for this risk tier' },
    { code: 6019, name: 'ZeroStakeAmount', msg: 'Stake amount must be greater than zero' },
    { code: 6020, name: 'UnstakeCooldownNotElapsed', msg: 'Unstake cooldown period not elapsed (48 hours)' },
    { code: 6021, name: 'NoUnstakeRequest', msg: 'No unstake request found' },
    { code: 6022, name: 'NoRewardsToClaim', msg: 'No pending rewards to claim' },
    { code: 6023, name: 'UnauthorizedOracle', msg: 'Unauthorized: only oracle authority can verify claims' },
    { code: 6024, name: 'UnauthorizedAdmin', msg: 'Unauthorized: only admin can modify config' },
    { code: 6025, name: 'UnauthorizedHolder', msg: 'Unauthorized: only policy holder can perform this action' },
    { code: 6026, name: 'InvalidTokenAccount', msg: 'Invalid token account: wrong owner or mint' },
    { code: 6027, name: 'MathOverflow', msg: 'Arithmetic overflow' },
  ],
  types: [
    {
      name: 'ProtocolConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'admin', type: 'pubkey' },
          { name: 'oracle_authority', type: 'pubkey' },
          { name: 'usdc_mint', type: 'pubkey' },
          { name: 'policy_counter', type: 'u64' },
          { name: 'paused', type: 'bool' },
          { name: 'premium_multiplier_bps', type: 'u16' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
    {
      name: 'InsuranceVault',
      type: {
        kind: 'struct',
        fields: [
          { name: 'authority', type: 'pubkey' },
          { name: 'total_staked', type: 'u64' },
          { name: 'total_coverage', type: 'u64' },
          { name: 'total_premiums_collected', type: 'u64' },
          { name: 'total_claims_paid', type: 'u64' },
          { name: 'staker_count', type: 'u32' },
          { name: 'solvency_ratio', type: 'u16' },
          { name: 'total_staker_rewards', type: 'u64' },
          { name: 'reserve_fund', type: 'u64' },
          { name: 'protocol_treasury', type: 'u64' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
    {
      name: 'InsurancePolicy',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
          { name: 'agent_address', type: 'pubkey' },
          { name: 'coverage_amount', type: 'u64' },
          { name: 'premium_paid', type: 'u64' },
          { name: 'risk_tier', type: 'u8' },
          { name: 'start_time', type: 'i64' },
          { name: 'expiry_time', type: 'i64' },
          { name: 'claim_submitted_at', type: 'i64' },
          { name: 'state', type: 'u8' },
          { name: 'trigger_type', type: 'u8' },
          { name: 'trigger_tx_signature', type: 'bytes' },
          { name: 'payout_amount', type: 'u64' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
    {
      name: 'StakerPosition',
      type: {
        kind: 'struct',
        fields: [
          { name: 'staker', type: 'pubkey' },
          { name: 'amount_staked', type: 'u64' },
          { name: 'share_bps', type: 'u16' },
          { name: 'rewards_claimed', type: 'u64' },
          { name: 'rewards_pending', type: 'u64' },
          { name: 'deposited_at', type: 'i64' },
          { name: 'unstake_requested_at', type: 'i64' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
    {
      name: 'PolicyCreated',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
          { name: 'agent_address', type: 'pubkey' },
          { name: 'coverage_amount', type: 'u64' },
          { name: 'premium_paid', type: 'u64' },
          { name: 'risk_tier', type: 'u8' },
          { name: 'start_time', type: 'i64' },
          { name: 'expiry_time', type: 'i64' },
        ],
      },
    },
    {
      name: 'ClaimSubmitted',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
          { name: 'trigger_type', type: 'u8' },
          { name: 'submitted_at', type: 'i64' },
        ],
      },
    },
    {
      name: 'ClaimPaid',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
          { name: 'payout_amount', type: 'u64' },
          { name: 'trigger_type', type: 'u8' },
          { name: 'paid_at', type: 'i64' },
        ],
      },
    },
    {
      name: 'PolicyCancelled',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
          { name: 'refund_amount', type: 'u64' },
        ],
      },
    },
    {
      name: 'PolicyExpiredEvent',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policy_id', type: 'u64' },
          { name: 'holder', type: 'pubkey' },
        ],
      },
    },
    {
      name: 'Staked',
      type: {
        kind: 'struct',
        fields: [
          { name: 'staker', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'total_staked', type: 'u64' },
        ],
      },
    },
    {
      name: 'UnstakeRequested',
      type: {
        kind: 'struct',
        fields: [
          { name: 'staker', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'available_at', type: 'i64' },
        ],
      },
    },
    {
      name: 'Unstaked',
      type: {
        kind: 'struct',
        fields: [
          { name: 'staker', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'rewards', type: 'u64' },
        ],
      },
    },
    {
      name: 'RewardsClaimed',
      type: {
        kind: 'struct',
        fields: [
          { name: 'staker', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
        ],
      },
    },
  ],
} as const satisfies Idl;

export type CovanticIdl = typeof COVANTIC_IDL;
