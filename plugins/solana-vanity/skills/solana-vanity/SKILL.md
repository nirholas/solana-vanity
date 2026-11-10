---
name: solana-vanity
description: Price a Solana vanity pattern, grind a matching keypair locally, delegate a hard grind without exposing the key, appraise an address, or verify a proof-of-grind certificate. Use when the user wants a Solana address that starts or ends with chosen Base58 characters.
---

# Solana vanity addresses

The `solana-vanity` npm package ships a CLI and a stdio MCP server. Four of the six MCP tools need no network.

## MCP tools (server `solana-vanity`, started with `npx -y solana-vanity mcp`)

- `vanity_quote`: exact difficulty, expected attempts, rarity tier and ETA. Args: `prefix`, `suffix`, `ignoreCase`, `attemptsPerSecond`. Pure maths.
- `vanity_appraise`: score an existing address. Args: `address`, optional `prefixLen`, `suffixLen`, `ignoreCase`.
- `vanity_grind`: grind a keypair on the host machine. Args: `prefix`, `suffix`, `ignoreCase`, `cores`, `timeBudgetMs` (capped by `SOLANA_VANITY_MAX_GRIND_MS`, default 120000). Returns the address and the secret key, which crosses the MCP transport into the conversation.
- `vanity_split_key_grind`: delegate a hard pattern to a remote API. The secret half of the key is generated locally and never sent. Args: `prefix`, `suffix`, `ignoreCase`, `api`, `maxRounds` (1 to 50, default 5).
- `vanity_verify_certificate`: verify a signed proof-of-grind certificate. Args: `certificate`, optional `api` (issuer base URL for the key ring).
- `vanity_leading_characters`: exact leading-character probability table for Base58, to pick a cheap prefix.

Base58 has no `0`, `O`, `I` or `l`. A pattern must give a prefix, a suffix, or both.

## CLI

    npx -y solana-vanity quote --prefix AGNT --rate 120000
    npx -y solana-vanity grind --prefix AGNT --out wallet.json
    npx -y solana-vanity grind --prefix AGNT --mnemonic --words 12
    npx -y solana-vanity delegate --prefix AGNT --api <url>
    npx -y solana-vanity appraise <address> --suffix-len 4
    npx -y solana-vanity verify certificate.json --api <url>
    npx -y solana-vanity serve --port 8787

Other flags on `grind`: `--suffix`, `--ignore-case`, `--cores <n>`, `--json`. `delegate` and `verify --api` use the API at `SOLANA_VANITY_API` (default `https://solana-vanity.dev`); everything else is offline.

## Workflow

1. Run `vanity_quote` first. If the ETA is more than a couple of minutes, shorten the pattern, set `ignoreCase`, or choose a cheaper leading character from `vanity_leading_characters`.
2. For anything valuable, prefer `vanity_split_key_grind` or the CLI `delegate` command, so the full key is never held by a third party or printed into the chat.
3. For a throwaway key, `vanity_grind` or `grind --out wallet.json` works. The `.json` is in Solana CLI keypair format.
4. Confirm the result with `vanity_appraise` on the returned address.

## Safety

Never paste a secret key into a chat, issue or commit. Prefer writing it to a file with `--out` and restricting its permissions.
