# Updating agent metadata

Registered agents can change the public metadata SAID serves for them without a new on-chain transaction. The on-chain `metadataUri` for platform-registered agents points at `https://api.saidprotocol.com/api/cards/:wallet.json`, so updating the stored card updates what the chain resolves to.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agents/:wallet/metadata/message` | Returns the exact message to sign for a given set of changes |
| `PATCH` | `/api/agents/:wallet` | Applies the changes |

## Updatable fields

| Field | Type | Rules |
|---|---|---|
| `name` | string | 1–50 chars, no `<>`/control chars, no reserved/impersonation terms; cannot be cleared |
| `description` | string \| null | ≤ 1000 chars |
| `twitter` | string \| null | Handle; `@` and `x.com/` prefixes are stripped |
| `github` | string \| null | Username; `github.com/` prefix is stripped |
| `website`, `image`, `mcpEndpoint`, `a2aEndpoint` | string \| null | `http(s)` URL, ≤ 500 chars |
| `skills` | string[] | ≤ 50 items, each ≤ 50 chars (served as `capabilities` on the card) |
| `serviceTypes` | string[] | ≤ 20 items |

Send `null` to clear a field. Fields not included are left untouched. Anything else in `changes` (e.g. `isVerified`, `owner`, `registrationSource`, `reputationScore`, `x402Wallet`) is rejected with `400`.

## Auth option 1: wallet signature

The signer must be the agent wallet or the owner wallet recorded at registration.

```bash
# 1. Get the message to sign
curl -s -X POST https://api.saidprotocol.com/api/agents/$WALLET/metadata/message \
  -H 'content-type: application/json' \
  -d '{"signer":"'$WALLET'","changes":{"name":"Atlas","website":"https://atlas.example"}}'
# → { "message": "SAID:update:<wallet>:<timestamp>:<sha256 of changes>", "timestamp": ..., "changes": {...normalised...} }

# 2. Sign `message` with the wallet (ed25519 detached signature, bs58-encoded)

# 3. Apply
curl -s -X PATCH https://api.saidprotocol.com/api/agents/$WALLET \
  -H 'content-type: application/json' \
  -d '{"signer":"'$WALLET'","signature":"<bs58>","timestamp":<timestamp>,"changes":{"name":"Atlas","website":"https://atlas.example"}}'
```

The message embeds a hash of the changes, so a signature only authorises those exact changes, and only for 5 minutes.

Signing in TypeScript:

```ts
import nacl from 'tweetnacl';
import bs58 from 'bs58';
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
```

Wallet adapters: `await wallet.signMessage(new TextEncoder().encode(message))`, then bs58-encode the bytes.

## Auth option 2: platform key

Platforms that registered the agent through `/api/platforms/:platform/register` can update it with the same `X-Platform-Key` header and no signature:

```bash
curl -s -X PATCH https://api.saidprotocol.com/api/agents/$WALLET \
  -H "X-Platform-Key: $PLATFORM_KEY" -H 'content-type: application/json' \
  -d '{"changes":{"description":"Updated by the platform"}}'
```

The key must belong to the platform recorded as the agent's `registrationSource`; any other key returns `403`.

## Layer-2 verification

If the agent holds a Layer-2 endpoint verification and the update moves `mcpEndpoint` or `a2aEndpoint` off the URL that verification was earned against, `layer2Verified` is reset and the response carries `layer2Reset: true`. Re-run the Layer-2 challenge against the new endpoint to restore it.

## Response

```json
{
  "success": true,
  "authorisedBy": "agent" | "owner" | "platform:<source>",
  "updated": ["name", "website"],
  "agent": { "wallet": "...", "name": "Atlas", "website": "https://atlas.example", "layer2Verified": true, "updatedAt": "..." }
}
```

| Status | Meaning |
|---|---|
| `400` | Invalid or unknown field, stale timestamp, missing auth fields |
| `401` | Signature does not verify for these changes |
| `403` | Signer is not the agent/owner, or platform key does not match `registrationSource` |
| `404` | Agent not registered |
