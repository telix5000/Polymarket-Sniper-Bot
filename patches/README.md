# Patch Package Notes

## Active Patches

### @polymarket/clob-client+4.22.8.patch

This patch fixes the API key derivation order to eliminate noisy 400 errors during authentication.

#### Fix: createOrDeriveApiKey() Order Reversal

**Purpose**: Fix API key derivation order to prevent noisy 400 errors when keys already exist

**Problem**: The `createOrDeriveApiKey()` method tries to create a new API key first, then falls back to deriving. When an API key already exists, `createApiKey()` fails with a 400 "Could not create api key" error, which is logged to the console before the method falls back to `deriveApiKey()`.

**Original Code**:
```javascript
createOrDeriveApiKey(nonce) {
    return this.createApiKey(nonce).then(response => {
        if (!response.key) {
            return this.deriveApiKey(nonce);
        }
        return response;
    });
}
```

**Patched Code** (conceptual async/await form):
```javascript
async createOrDeriveApiKey(nonce) {
    // Patched: Try deriveApiKey first (for existing keys)
    // then fall back to createApiKey (for new wallets)
    // This avoids noisy 400 errors when key already exists
    try {
        const derived = await this.deriveApiKey(nonce);
        if (derived && derived.key) {
            return derived;
        }
    } catch (e) {
        // Derivation failed - wallet may be new, try creating
    }
    return this.createApiKey(nonce);
}
```

**Note**: The actual patch modifies the transpiled `__awaiter(function* () { ... })` code in `dist/client.js`, but the logic is equivalent to the async/await form shown above.

**Result**: Existing wallets derive their API keys silently without 400 errors being logged. New wallets still get keys created correctly.

**References**:

- [Polymarket/clob-client#202](https://github.com/Polymarket/clob-client/issues/202)
- [Polymarket/clob-client#209](https://github.com/Polymarket/clob-client/issues/209)
- [IQAIcom/mcp-polymarket#37](https://github.com/IQAIcom/mcp-polymarket/pull/37)

**Files modified**:

- `dist/client.js`: Modified `createOrDeriveApiKey()` to try derive first, then create
