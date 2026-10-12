# Solana services section

`@red-cup-engineering/solana-services-section` observes public Solana mainnet
addresses without credentials, signing material, transactions, or mutations.

The public reader admits a bounded address roster, verifies the provider's
mainnet genesis hash, reads every address in one finalized
`getMultipleAccounts` call, and reconciles that response's shared context slot
with `getBlock`. A successful report preserves decimal-string lamports,
account existence, empty account data, the context slot and API version, the
reconciled block boundary, and provider/attempt/failure evidence. SPL token
balances are explicitly outside the observation and reported as unobserved.

```js
import { observePublicNativeBalances } from
  "@red-cup-engineering/solana-services-section/public-native-balance-observation";

const report = await observePublicNativeBalances([
  "11111111111111111111111111111111",
]);

if (report.checked) console.log(report.accounts[0].lamports);
else console.error(report.code, report.failures);
```

The canonical provider order is Solana's official public mainnet endpoint,
followed by PublicNode. Provider endpoints must be credential-free HTTPS URLs
without user information, query parameters, or fragments. The defaults are
rate-limited public infrastructure and are appropriate only for bounded
read-only observation.
