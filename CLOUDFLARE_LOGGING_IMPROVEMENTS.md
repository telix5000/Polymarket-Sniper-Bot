# Cloudflare Logging Improvements

## Summary

Enhanced diagnostic logging for Cloudflare 403 blocks during CLOB order submission to make troubleshooting faster and more effective.

## Changes Made

### 1. `src/lib/error-handling.ts`

**Added:** `extractCloudflareRayId(error: unknown): string | null`
- Dedicated function to extract Cloudflare Ray IDs from error responses
- Supports multiple formats:
  - HTML: `<strong class="font-semibold">abc123</strong>`
  - HTML: `<strong>abc123</strong>`
  - Plain text: `Ray ID: abc123`
  - JSON: `"ray_id":"abc123"` or `"ray-id":"abc123"`
- Returns `null` if no Ray ID found

**Modified:** `formatErrorForLog()`
- Now uses `extractCloudflareRayId()` for cleaner code reuse
- Still provides clean Cloudflare block messages with Ray ID

### 2. `src/lib/order.ts`

**Enhanced logging at 3 locations:**

#### Location 1: Order response failures (lines 229-257)
When `response.success === false`:
```
CLOB Order blocked by Cloudflare (403) - Ray ID: 8e4f3c2b1a9d6e7f | 
Status: 403 | Body length: 4532B | 
Check VPN routing and geo-restrictions
```

Logs:
- Extracted Ray ID from response
- HTTP status code (if available)
- Response body length in bytes
- Actionable suggestion (VPN routing)

For non-Cloudflare failures:
```
Order attempt failed [status=400]: <formatted error message>
```

#### Location 2: Order execution exceptions (lines 258-294)
When `postOrder()` throws an error:
```
CLOB Order blocked by Cloudflare (403) - Ray ID: 8e4f3c2b1a9d6e7f (cf-ray: 8e4f3c2b1a9d6e7f-SJC) | 
Status: 403 | Body length: 4532B | CF-Cache: DYNAMIC | 
Check VPN routing and geo-restrictions
```

Logs:
- Extracted Ray ID from error
- HTTP status code from error/response
- Response body length
- `cf-ray` header (if available)
- `cf-cache-status` header (if available)
- Actionable suggestion

For non-Cloudflare errors:
```
Order execution error [status=500]: <formatted error message>
```

#### Location 3: Outer catch block (lines 307-325)
Top-level error handler:
```
Order rejected: CLOUDFLARE_BLOCKED - Ray ID: 8e4f3c2b1a9d6e7f | Check VPN routing
```

Logs:
- Extracted Ray ID
- Clear rejection reason
- Actionable suggestion

## Benefits

### Before
```
Order blocked by Cloudflare (403). Your IP may be geo-blocked. Consider using a VPN.
Order execution error: Cloudflare block (403 Forbidden)
```

### After
```
CLOB Order blocked by Cloudflare (403) - Ray ID: 8e4f3c2b1a9d6e7f (cf-ray: 8e4f3c2b1a9d6e7f-SJC) | 
Status: 403 | Body length: 4532B | CF-Cache: DYNAMIC | 
Check VPN routing and geo-restrictions
```

**Improvements:**
1. **Ray ID visible** - Can provide to Cloudflare support or correlate with logs
2. **Response metadata** - Status code, body length help diagnose issue type
3. **Headers included** - `cf-ray` and `cf-cache-status` provide routing/caching context
4. **Status codes** - All errors now include HTTP status when available
5. **Consistent format** - All CLOB errors follow similar structured pattern
6. **No secret leakage** - Uses existing `formatErrorForLog()` which redacts sensitive data

## Testing

Validated:
- ✓ Ray ID extraction from 6 different formats
- ✓ Null handling when Ray ID not present
- ✓ Log message formatting with all diagnostic fields
- ✓ TypeScript syntax (existing project config issues are pre-existing)

## Example Outputs

### Cloudflare Block (full diagnostics)
```
CLOB Order blocked by Cloudflare (403) - Ray ID: 8e4f3c2b1a9d6e7f (cf-ray: 8e4f3c2b1a9d6e7f-SJC) | 
Status: 403 | Body length: 4532B | CF-Cache: DYNAMIC | 
Check VPN routing and geo-restrictions
```

### Cloudflare Block (minimal info)
```
Order rejected: CLOUDFLARE_BLOCKED - Ray ID: 8e4f3c2b1a9d6e7f | Check VPN routing
```

### Other API Errors
```
Order attempt failed [status=400]: Request validation error - invalid tokenID format
Order execution error [status=500]: Internal server error
```

## Usage

No changes required to calling code. Enhanced logging is automatic when:
1. A Cloudflare block is detected (via `isCloudflareBlock()`)
2. Any CLOB order submission fails
3. Any CLOB error is thrown

The `extractCloudflareRayId()` function is also exported for use in other modules if needed.

## Security

- All sensitive data redaction still applies via `formatErrorForLog()`
- Ray IDs are safe to log (they're public Cloudflare request identifiers)
- No changes to credential handling or API key usage
