import type { Idl } from "@coral-xyz/anchor";

/**
 * Anchor IDL for the Covantic insurance program.
 * Discriminators are sha256("global|account|event:name")[0..8].
 * Address matches the on-chain program ID on devnet.
 */
export const COVANTIC_IDL = {
  "address": "HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL",
  "metadata": {
    "name": "covantic",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AI Agent Insurance Protocol on Solana"
  },
  "docs": [
    "Covantic — AI Agent Insurance Protocol on Solana.",
    "Parametric insurance for AI agents performing DeFi operations."
  ],
  "instructions": [
    {
      "name": "cancel_policy",
      "docs": [
        "Cancel a policy with partial refund."
      ],
      "discriminator": [
        244,
        58,
        241,
        221,
        106,
        151,
        94,
        116
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "Policy holder"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "policy",
          "docs": [
            "The policy to cancel"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "account",
                "path": "policy.policy_id",
                "account": "InsurancePolicy"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "config",
          "docs": [
            "Protocol config (for usdc_mint check on token accounts)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account (must belong to vault and be USDC mint)"
          ],
          "writable": true
        },
        {
          "name": "holder_token_account",
          "docs": [
            "Holder USDC token account (must belong to policy holder and be USDC mint)"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claim_rewards",
      "docs": [
        "Claim accumulated staker rewards."
      ],
      "discriminator": [
        4,
        144,
        132,
        71,
        116,
        23,
        151,
        80
      ],
      "accounts": [
        {
          "name": "staker",
          "docs": [
            "Staker"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "staker_position",
          "docs": [
            "Staker position"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  115,
                  116,
                  97,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "staker"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account (must belong to vault)"
          ],
          "writable": true
        },
        {
          "name": "staker_token_account",
          "docs": [
            "Staker USDC token account (must belong to staker and match mint)"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "create_policy",
      "docs": [
        "Create an insurance policy.",
        "Holder pays premium, receives a Policy PDA. The risk tier comes from",
        "the oracle-signed RiskAttestation PDA for the agent — buyers cannot",
        "self-select a tier."
      ],
      "discriminator": [
        27,
        81,
        33,
        27,
        196,
        103,
        246,
        53
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "Policy holder (signer and payer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol config (for policy_counter and multiplier)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "attestation",
          "docs": [
            "Oracle-signed risk attestation — tier comes from this account, not",
            "from caller input. PDA seeds bind it to `agent_address`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "agent_address"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "New policy PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "account",
                "path": "config.policy_counter",
                "account": "ProtocolConfig"
              }
            ]
          }
        },
        {
          "name": "holder_token_account",
          "docs": [
            "Holder's USDC token account"
          ],
          "writable": true
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault's USDC token account"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "coverage_amount",
          "type": "u64"
        },
        {
          "name": "duration_seconds",
          "type": "i64"
        },
        {
          "name": "agent_address",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "execute_unstake",
      "docs": [
        "Execute unstake after cooldown."
      ],
      "discriminator": [
        136,
        166,
        210,
        104,
        134,
        184,
        142,
        230
      ],
      "accounts": [
        {
          "name": "staker",
          "docs": [
            "Staker"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "staker_position",
          "docs": [
            "Staker position"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  115,
                  116,
                  97,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "staker"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account (must belong to vault)"
          ],
          "writable": true
        },
        {
          "name": "staker_token_account",
          "docs": [
            "Staker USDC token account (must belong to staker and match mint)"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "expire_policy",
      "docs": [
        "Mark expired policies (permissionless crank)."
      ],
      "discriminator": [
        149,
        24,
        43,
        100,
        240,
        50,
        39,
        124
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Anyone can crank expired policies"
          ],
          "signer": true
        },
        {
          "name": "policy",
          "docs": [
            "The policy to expire (validated via PDA seeds)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "policy.holder",
                "account": "InsurancePolicy"
              },
              {
                "kind": "account",
                "path": "policy.policy_id",
                "account": "InsurancePolicy"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault (to update coverage)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize protocol: creates config + vault.",
        "Called ONCE at deployment."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin who initializes the protocol"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol configuration PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "usdc_mint",
          "docs": [
            "USDC mint"
          ]
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account (ATA owned by vault PDA)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdc_mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associated_token_program",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle_authority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "oracle_submit_claim",
      "docs": [
        "Submit an insurance claim on behalf of a holder (oracle-signed path,",
        "used by the automated monitoring pipeline). Only the oracle authority",
        "configured in ProtocolConfig may call this."
      ],
      "discriminator": [
        69,
        18,
        72,
        170,
        189,
        116,
        218,
        79
      ],
      "accounts": [
        {
          "name": "oracle",
          "docs": [
            "Oracle authority — must match `config.oracle_authority`."
          ],
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol config (provides the oracle authority to check against)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "The policy being filed against. Seeds use the stored holder pubkey so",
            "the oracle does not need the holder keypair and cannot spoof the PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "policy.holder",
                "account": "InsurancePolicy"
              },
              {
                "kind": "account",
                "path": "policy.policy_id",
                "account": "InsurancePolicy"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "trigger_type",
          "type": "u8"
        },
        {
          "name": "trigger_tx_signature",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "request_unstake",
      "docs": [
        "Request unstake (starts 48h cooldown)."
      ],
      "discriminator": [
        44,
        154,
        110,
        253,
        160,
        202,
        54,
        34
      ],
      "accounts": [
        {
          "name": "staker",
          "docs": [
            "Staker"
          ],
          "signer": true
        },
        {
          "name": "staker_position",
          "docs": [
            "Staker position"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  115,
                  116,
                  97,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "staker"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "stake",
      "docs": [
        "Stake USDC into the insurance pool."
      ],
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
      ],
      "accounts": [
        {
          "name": "staker",
          "docs": [
            "Staker (signer and payer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol config"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "staker_position",
          "docs": [
            "Staker position PDA (init_if_needed for first-time stakers)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  115,
                  116,
                  97,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "staker"
              }
            ]
          }
        },
        {
          "name": "staker_token_account",
          "docs": [
            "Staker's USDC token account"
          ],
          "writable": true
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "submit_claim",
      "docs": [
        "Submit an insurance claim (holder-signed path, used by SDK/agent flow)."
      ],
      "discriminator": [
        163,
        108,
        111,
        46,
        220,
        82,
        77,
        212
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "Policy holder"
          ],
          "signer": true
        },
        {
          "name": "policy",
          "docs": [
            "The policy to submit a claim for"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "account",
                "path": "policy.policy_id",
                "account": "InsurancePolicy"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "trigger_type",
          "type": "u8"
        },
        {
          "name": "trigger_tx_signature",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "update_config",
      "docs": [
        "Admin-only: rotate admin / oracle authority, toggle pause, adjust",
        "the solvency-based premium multiplier. Each argument is optional."
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Current admin — must match config.admin"
          ],
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "new_admin",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "new_oracle_authority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "new_paused",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "new_premium_multiplier_bps",
          "type": {
            "option": "u16"
          }
        }
      ]
    },
    {
      "name": "upsert_attestation",
      "docs": [
        "Publish (or refresh) a risk attestation for an agent. Only the oracle",
        "authority may sign. `create_policy` requires a live attestation."
      ],
      "discriminator": [
        45,
        5,
        153,
        3,
        222,
        1,
        221,
        81
      ],
      "accounts": [
        {
          "name": "oracle",
          "docs": [
            "Oracle authority (signer + rent payer on first write)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol config — used to authorize the oracle signer."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "attestation",
          "docs": [
            "Risk attestation PDA — created on first publish, overwritten after."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "tier",
          "type": "u8"
        },
        {
          "name": "valid_for_seconds",
          "type": "i64"
        }
      ]
    },
    {
      "name": "verify_and_payout",
      "docs": [
        "Verify a claim and execute payout (oracle only)."
      ],
      "discriminator": [
        31,
        127,
        176,
        128,
        240,
        238,
        14,
        91
      ],
      "accounts": [
        {
          "name": "oracle",
          "docs": [
            "Oracle authority (signer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Protocol config (to verify oracle authority)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "The policy with a pending claim (validated via PDA seeds)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "policy.holder",
                "account": "InsurancePolicy"
              },
              {
                "kind": "account",
                "path": "policy.policy_id",
                "account": "InsurancePolicy"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Insurance vault"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  118,
                  97,
                  110,
                  116,
                  105,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vault_token_account",
          "docs": [
            "Vault USDC token account (must belong to vault and be USDC mint)"
          ],
          "writable": true
        },
        {
          "name": "holder_token_account",
          "docs": [
            "Holder USDC token account (must belong to policy holder and be USDC mint)"
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "payout_amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "InsurancePolicy",
      "discriminator": [
        171,
        170,
        55,
        125,
        71,
        125,
        63,
        48
      ]
    },
    {
      "name": "InsuranceVault",
      "discriminator": [
        131,
        200,
        252,
        180,
        131,
        202,
        30,
        144
      ]
    },
    {
      "name": "ProtocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "RiskAttestation",
      "discriminator": [
        111,
        39,
        223,
        244,
        0,
        0,
        96,
        114
      ]
    },
    {
      "name": "StakerPosition",
      "discriminator": [
        202,
        156,
        49,
        48,
        230,
        210,
        246,
        197
      ]
    }
  ],
  "events": [
    {
      "name": "AttestationUpserted",
      "discriminator": [
        104,
        52,
        15,
        209,
        99,
        107,
        153,
        93
      ]
    },
    {
      "name": "ClaimPaid",
      "discriminator": [
        212,
        155,
        88,
        118,
        128,
        99,
        132,
        42
      ]
    },
    {
      "name": "ClaimSubmitted",
      "discriminator": [
        95,
        1,
        120,
        227,
        177,
        240,
        174,
        52
      ]
    },
    {
      "name": "PolicyCancelled",
      "discriminator": [
        33,
        213,
        35,
        84,
        4,
        212,
        181,
        237
      ]
    },
    {
      "name": "PolicyCreated",
      "discriminator": [
        59,
        189,
        65,
        121,
        86,
        157,
        108,
        10
      ]
    },
    {
      "name": "PolicyExpiredEvent",
      "discriminator": [
        1,
        178,
        124,
        200,
        124,
        152,
        195,
        216
      ]
    },
    {
      "name": "RewardsClaimed",
      "discriminator": [
        75,
        98,
        88,
        18,
        219,
        112,
        88,
        121
      ]
    },
    {
      "name": "Staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "UnstakeRequested",
      "discriminator": [
        21,
        253,
        177,
        85,
        129,
        206,
        42,
        152
      ]
    },
    {
      "name": "Unstaked",
      "discriminator": [
        27,
        179,
        156,
        215,
        47,
        71,
        195,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "CoverageTooLow",
      "msg": "Coverage amount below minimum (1 USDC)"
    },
    {
      "code": 6001,
      "name": "CoverageTooHigh",
      "msg": "Coverage amount exceeds maximum (1,000,000 USDC)"
    },
    {
      "code": 6002,
      "name": "DurationTooShort",
      "msg": "Policy duration below minimum (1 hour)"
    },
    {
      "code": 6003,
      "name": "DurationTooLong",
      "msg": "Policy duration exceeds maximum (30 days)"
    },
    {
      "code": 6004,
      "name": "InvalidRiskTier",
      "msg": "Invalid risk tier (must be 0=LOW, 1=MEDIUM, or 2=HIGH)"
    },
    {
      "code": 6005,
      "name": "PolicyNotActive",
      "msg": "Policy is not in Active state"
    },
    {
      "code": 6006,
      "name": "PolicyExpired",
      "msg": "Policy has expired"
    },
    {
      "code": 6007,
      "name": "PolicyNotExpired",
      "msg": "Policy has not expired yet"
    },
    {
      "code": 6008,
      "name": "MaxPoliciesReached",
      "msg": "Maximum policies per wallet reached (10)"
    },
    {
      "code": 6009,
      "name": "IncorrectPremium",
      "msg": "Incorrect premium amount"
    },
    {
      "code": 6010,
      "name": "ClaimAlreadySubmitted",
      "msg": "Claim already submitted for this policy"
    },
    {
      "code": 6011,
      "name": "InvalidTriggerType",
      "msg": "Invalid trigger type"
    },
    {
      "code": 6012,
      "name": "TriggerTxRequired",
      "msg": "Trigger transaction signature is required"
    },
    {
      "code": 6013,
      "name": "InvalidTriggerTxSignature",
      "msg": "Trigger transaction signature length exceeds the on-chain buffer"
    },
    {
      "code": 6014,
      "name": "LockPeriodNotElapsed",
      "msg": "Lock period has not elapsed"
    },
    {
      "code": 6015,
      "name": "PayoutExceedsCoverage",
      "msg": "Payout exceeds coverage amount"
    },
    {
      "code": 6016,
      "name": "PolicyNotClaimPending",
      "msg": "Policy is not in ClaimPending state"
    },
    {
      "code": 6017,
      "name": "InsufficientVaultBalance",
      "msg": "Insufficient vault balance for payout"
    },
    {
      "code": 6018,
      "name": "ProtocolPaused",
      "msg": "Protocol is paused — no new policies or stakes"
    },
    {
      "code": 6019,
      "name": "SolvencyTooLow",
      "msg": "Solvency ratio too low for this risk tier"
    },
    {
      "code": 6020,
      "name": "ZeroStakeAmount",
      "msg": "Stake amount must be greater than zero"
    },
    {
      "code": 6021,
      "name": "UnstakeCooldownNotElapsed",
      "msg": "Unstake cooldown period not elapsed (48 hours)"
    },
    {
      "code": 6022,
      "name": "NoUnstakeRequest",
      "msg": "No unstake request found"
    },
    {
      "code": 6023,
      "name": "NoRewardsToClaim",
      "msg": "No pending rewards to claim"
    },
    {
      "code": 6024,
      "name": "UnauthorizedOracle",
      "msg": "Unauthorized: only oracle authority can verify claims"
    },
    {
      "code": 6025,
      "name": "UnauthorizedAdmin",
      "msg": "Unauthorized: only admin can modify config"
    },
    {
      "code": 6026,
      "name": "UnauthorizedHolder",
      "msg": "Unauthorized: only policy holder can perform this action"
    },
    {
      "code": 6027,
      "name": "InvalidTokenAccount",
      "msg": "Invalid token account: wrong owner or mint"
    },
    {
      "code": 6028,
      "name": "AttestationExpired",
      "msg": "Risk attestation has expired — re-assess the agent"
    },
    {
      "code": 6029,
      "name": "AttestationAgentMismatch",
      "msg": "Risk attestation agent does not match the policy's agent address"
    },
    {
      "code": 6030,
      "name": "InvalidAttestationValidity",
      "msg": "Invalid attestation validity window (must be > 0 and <= 1 hour)"
    },
    {
      "code": 6031,
      "name": "MathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "AttestationUpserted",
      "docs": [
        "Event: oracle published (or refreshed) a risk attestation for an agent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "issued_at",
            "type": "i64"
          },
          {
            "name": "expires_at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ClaimPaid",
      "docs": [
        "Event: claim verified and paid out"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy_id",
            "type": "u64"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "payout_amount",
            "type": "u64"
          },
          {
            "name": "trigger_type",
            "type": "u8"
          },
          {
            "name": "paid_at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ClaimSubmitted",
      "docs": [
        "Event: claim submitted"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy_id",
            "type": "u64"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "trigger_type",
            "type": "u8"
          },
          {
            "name": "submitted_at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "InsurancePolicy",
      "docs": [
        "AI agent insurance policy.",
        "PDA: seeds = [b\"policy\", holder.key().as_ref(), &policy_id.to_le_bytes()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Schema version for forward-compatible deserialization"
            ],
            "type": "u8"
          },
          {
            "name": "policy_id",
            "docs": [
              "Unique policy ID (from policy_counter)"
            ],
            "type": "u64"
          },
          {
            "name": "holder",
            "docs": [
              "Policy holder wallet (paid the premium)"
            ],
            "type": "pubkey"
          },
          {
            "name": "agent_address",
            "docs": [
              "Agent address covered by this policy"
            ],
            "type": "pubkey"
          },
          {
            "name": "coverage_amount",
            "docs": [
              "Maximum coverage amount in USDC (6 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "premium_paid",
            "docs": [
              "Premium paid in USDC"
            ],
            "type": "u64"
          },
          {
            "name": "risk_tier",
            "docs": [
              "Risk tier: 0=LOW, 1=MEDIUM, 2=HIGH"
            ],
            "type": "u8"
          },
          {
            "name": "start_time",
            "docs": [
              "Unix timestamp when coverage started"
            ],
            "type": "i64"
          },
          {
            "name": "expiry_time",
            "docs": [
              "Unix timestamp when coverage expires"
            ],
            "type": "i64"
          },
          {
            "name": "claim_submitted_at",
            "docs": [
              "Unix timestamp of claim submission (0 if not submitted)"
            ],
            "type": "i64"
          },
          {
            "name": "state",
            "docs": [
              "Current policy state",
              "0 = Active, 1 = ClaimPending, 2 = ClaimPaid,",
              "3 = Expired, 4 = Cancelled"
            ],
            "type": "u8"
          },
          {
            "name": "trigger_type",
            "docs": [
              "Insurance trigger type",
              "0=None, 1=Exploit, 2=OracleManip, 3=AgentError, 4=GovernanceAttack"
            ],
            "type": "u8"
          },
          {
            "name": "trigger_tx_signature",
            "docs": [
              "Trigger transaction signature stored as Base58 UTF-8 bytes.",
              "A Solana signature is 88 Base58 chars at most."
            ],
            "type": "bytes"
          },
          {
            "name": "payout_amount",
            "docs": [
              "Actual payout amount (<= coverage_amount)"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "InsuranceVault",
      "docs": [
        "Insurance pool vault.",
        "PDA: seeds = [b\"vault\"]",
        "ONE per protocol."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Schema version for forward-compatible deserialization"
            ],
            "type": "u8"
          },
          {
            "name": "authority",
            "docs": [
              "Authority PDA for signing CPI (transfers from vault)"
            ],
            "type": "pubkey"
          },
          {
            "name": "total_staked",
            "docs": [
              "Total USDC staked"
            ],
            "type": "u64"
          },
          {
            "name": "total_coverage",
            "docs": [
              "Sum of all active coverages"
            ],
            "type": "u64"
          },
          {
            "name": "total_premiums_collected",
            "docs": [
              "All premiums collected (lifetime)"
            ],
            "type": "u64"
          },
          {
            "name": "total_claims_paid",
            "docs": [
              "All claims paid (lifetime)"
            ],
            "type": "u64"
          },
          {
            "name": "staker_count",
            "docs": [
              "Number of stakers"
            ],
            "type": "u32"
          },
          {
            "name": "solvency_ratio",
            "docs": [
              "Solvency ratio in basis points:",
              "(total_staked * 10000) / total_coverage",
              "0 if total_coverage == 0"
            ],
            "type": "u16"
          },
          {
            "name": "total_staker_rewards",
            "docs": [
              "Remaining claimable staker rewards (premium share not yet paid out).",
              "Incremented on `create_policy` (staker share of premium) and",
              "decremented when stakers claim via `claim_rewards` or `execute_unstake`."
            ],
            "type": "u64"
          },
          {
            "name": "reward_per_stake_acc",
            "docs": [
              "Global accumulator for rewards-per-stake, scaled by REWARD_PER_STAKE_SCALE.",
              "New premiums update this by `delta * SCALE / total_staked`; each",
              "staker's snapshot lives in StakerPosition.reward_per_stake_snapshot."
            ],
            "type": "u128"
          },
          {
            "name": "reserve_fund",
            "docs": [
              "Reserve fund (20% of premiums)"
            ],
            "type": "u64"
          },
          {
            "name": "protocol_treasury",
            "docs": [
              "Protocol treasury (10% of premiums)"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "PolicyCancelled",
      "docs": [
        "Event: policy cancelled"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy_id",
            "type": "u64"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "refund_amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "PolicyCreated",
      "docs": [
        "Event: new policy created"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy_id",
            "type": "u64"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "agent_address",
            "type": "pubkey"
          },
          {
            "name": "coverage_amount",
            "type": "u64"
          },
          {
            "name": "premium_paid",
            "type": "u64"
          },
          {
            "name": "risk_tier",
            "type": "u8"
          },
          {
            "name": "start_time",
            "type": "i64"
          },
          {
            "name": "expiry_time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "PolicyExpiredEvent",
      "docs": [
        "Event: policy expired"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy_id",
            "type": "u64"
          },
          {
            "name": "holder",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "ProtocolConfig",
      "docs": [
        "Global protocol configuration.",
        "PDA: seeds = [b\"config\"]",
        "Created ONCE during initialization."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Protocol administrator (can modify parameters)"
            ],
            "type": "pubkey"
          },
          {
            "name": "oracle_authority",
            "docs": [
              "Oracle authority — only account allowed to call verify_and_payout"
            ],
            "type": "pubkey"
          },
          {
            "name": "usdc_mint",
            "docs": [
              "USDC mint address"
            ],
            "type": "pubkey"
          },
          {
            "name": "policy_counter",
            "docs": [
              "Global policy counter (auto-increment ID)"
            ],
            "type": "u64"
          },
          {
            "name": "paused",
            "docs": [
              "Is the protocol paused?"
            ],
            "type": "bool"
          },
          {
            "name": "premium_multiplier_bps",
            "docs": [
              "Solvency-based premium multiplier (bps). Default 10000 = 1.0x"
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "RewardsClaimed",
      "docs": [
        "Event: staker rewards claimed"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "RiskAttestation",
      "docs": [
        "Oracle-signed attestation of a risk tier for a specific agent.",
        "",
        "The backend's risk engine produces a score and tier, then the oracle",
        "authority signs an `UpsertAttestation` transaction that writes this",
        "account. Policy creation (`create_policy`) refuses to run without a",
        "live attestation, which prevents buyers from self-selecting a cheaper",
        "tier than their agent's on-chain behavior earns.",
        "",
        "PDA: `[ATTESTATION_SEED, agent.as_ref()]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "docs": [
              "Agent address this attestation covers. Must match `create_policy.agent_address`."
            ],
            "type": "pubkey"
          },
          {
            "name": "tier",
            "docs": [
              "Risk tier (0=LOW, 1=MEDIUM, 2=HIGH). EXTREME agents never receive an",
              "attestation — the oracle refuses to sign for them, so `create_policy`",
              "has no path to approve coverage."
            ],
            "type": "u8"
          },
          {
            "name": "issued_at",
            "docs": [
              "Unix timestamp when this attestation was minted."
            ],
            "type": "i64"
          },
          {
            "name": "expires_at",
            "docs": [
              "Unix timestamp after which this attestation is considered stale.",
              "`create_policy` rejects anything past this point."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Staked",
      "docs": [
        "Event: USDC staked to the pool"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "total_staked",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "StakerPosition",
      "docs": [
        "Staker position in the insurance pool.",
        "PDA: seeds = [b\"staker\", staker.key().as_ref()]",
        "One account per staker."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Schema version for forward-compatible deserialization"
            ],
            "type": "u8"
          },
          {
            "name": "staker",
            "docs": [
              "Staker wallet"
            ],
            "type": "pubkey"
          },
          {
            "name": "amount_staked",
            "docs": [
              "Staked amount in USDC"
            ],
            "type": "u64"
          },
          {
            "name": "share_bps",
            "docs": [
              "Pool share (basis points 0-10000) — informational only"
            ],
            "type": "u16"
          },
          {
            "name": "rewards_claimed",
            "docs": [
              "Total rewards already claimed"
            ],
            "type": "u64"
          },
          {
            "name": "rewards_pending",
            "docs": [
              "Accumulated unclaimed rewards (crystallized on stake/claim boundaries)"
            ],
            "type": "u64"
          },
          {
            "name": "reward_per_stake_snapshot",
            "docs": [
              "Snapshot of InsuranceVault.reward_per_stake_acc at the time",
              "rewards_pending was last crystallized."
            ],
            "type": "u128"
          },
          {
            "name": "deposited_at",
            "docs": [
              "Unix timestamp of deposit"
            ],
            "type": "i64"
          },
          {
            "name": "unstake_requested_at",
            "docs": [
              "Unix timestamp of unstake request (0 if not requested).",
              "Unstake only allowed 48 hours after this timestamp."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "UnstakeRequested",
      "docs": [
        "Event: unstake requested"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "available_at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "Unstaked",
      "docs": [
        "Event: unstake executed"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "rewards",
            "type": "u64"
          }
        ]
      }
    }
  ]
} as unknown as Idl;

export type Covantic = typeof COVANTIC_IDL;
