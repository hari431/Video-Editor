/**
 * JWT Decoder - Pure JS Offline Decoding Module
 * Splits, base64url decodes, parses, and audits standard token claim expirations.
 * Works uniformly in Browser and Node.js unit testing.
 */

export function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return decodeURIComponent(escape(atob(base64)));
}

export function decodeJwtPure(token) {
  if (!token) {
    throw new Error('Please enter a JWT token string.');
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format. A valid token must have exactly three dot-separated components (Header, Payload, and Signature).');
  }

  try {
    const rawHeader = base64UrlDecode(parts[0]);
    const rawPayload = base64UrlDecode(parts[1]);

    const header = JSON.parse(rawHeader);
    const payload = JSON.parse(rawPayload);
    const signature = parts[2]; // Raw signature string

    return {
      header,
      payload,
      signature
    };
  } catch (err) {
    throw new Error(`Failed to decode JWT base64/JSON structure: ${err.message}`);
  }
}

export function formatJwtTimestamp(val) {
  if (val === undefined || val === null) return 'N/A';
  try {
    const d = new Date(Number(val) * 1000);
    if (isNaN(d.getTime())) return 'Invalid timestamp';
    return d.toUTCString() + ' (Local: ' + d.toLocaleString() + ')';
  } catch (e) {
    return 'Invalid Date';
  }
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const jwtInput = document.getElementById('jwtInput');
    const btnDecodeJwt = document.getElementById('btnDecodeJwt');
    const btnLoadSample = document.getElementById('btnLoadSample');
    const btnClearAll = document.getElementById('btnClearAll');

    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');

    const headerPre = document.getElementById('headerPre');
    const payloadPre = document.getElementById('payloadPre');
    const signatureText = document.getElementById('signatureText');

    // Claims table nodes
    const claimIssuer = document.getElementById('claimIssuer');
    const claimSubject = document.getElementById('claimSubject');
    const claimAudience = document.getElementById('claimAudience');
    const claimExpiry = document.getElementById('claimExpiry');
    const claimNotBefore = document.getElementById('claimNotBefore');
    const claimIssuedAt = document.getElementById('claimIssuedAt');
    const claimTokenId = document.getElementById('claimTokenId');
    const expiryAlertBlock = document.getElementById('expiryAlertBlock');

    // Pre-made completely synthetic token for testing (HMAC SHA-256)
    // Header: { "alg": "HS256", "typ": "JWT" }
    // Payload: { "iss": "Guidewire-IDP", "sub": "usr_981247", "aud": "PolicyCenter-API", "exp": 1893456000, "nbf": 1577836800, "iat": 1577836800, "jti": "jti-88123" }
    const sampleToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJHdWlkZXdpcmUtSURQIiwic3ViIjoidXNyXzk4MTI0NyIsImF1ZCI6IlBvbGljeUNlbnRlci1BUEkiLCJleHAiOjE4OTM0NTYwMDAsIm5iZiI6MTU3NzgzNjgwMCwiaWF0IjoxNTc3ODM2ODAwLCJqdGkiOiJqdGktODgxMjMifQ.SignatureExcludedForOfflineDemo';

    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        jwtInput.value = sampleToken;
        btnDecodeJwt.click();
      });
    }

    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        jwtInput.value = '';
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');
      });
    }

    if (btnDecodeJwt) {
      btnDecodeJwt.addEventListener('click', () => {
        const text = jwtInput.value.trim();
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');

        if (!text) {
          showError('Please paste a JWT token to decode.');
          return;
        }

        try {
          const decoded = decodeJwtPure(text);

          headerPre.textContent = JSON.stringify(decoded.header, null, 2);
          payloadPre.textContent = JSON.stringify(decoded.payload, null, 2);
          signatureText.textContent = decoded.signature || 'No Signature Element';

          // Extract standard claims
          const p = decoded.payload;
          claimIssuer.textContent = p.iss || 'N/A';
          claimSubject.textContent = p.sub || 'N/A';
          claimAudience.textContent = p.aud || 'N/A';
          claimTokenId.textContent = p.jti || 'N/A';

          claimExpiry.textContent = formatJwtTimestamp(p.exp);
          claimNotBefore.textContent = formatJwtTimestamp(p.nbf);
          claimIssuedAt.textContent = formatJwtTimestamp(p.iat);

          // Expiry and Status Audit check
          expiryAlertBlock.innerHTML = '';
          if (p.exp) {
            const nowSec = Date.now() / 1000;
            const isExpired = nowSec > Number(p.exp);
            if (isExpired) {
              expiryAlertBlock.innerHTML = `
                <div class="bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 text-xs">
                  ⚠️ <strong>Token Expired:</strong> This token expired on ${formatJwtTimestamp(p.exp)}.
                </div>
              `;
            } else {
              expiryAlertBlock.innerHTML = `
                <div class="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-xs">
                  ✓ <strong>Token Active:</strong> Token is currently within valid operational lifecycle bounds.
                </div>
              `;
            }
          }

          resultsPanel.classList.remove('hidden');

        } catch (err) {
          showError(err.message);
        }
      });
    }

    function showError(msg) {
      errorContainer.classList.remove('hidden');
      errorContainer.innerHTML = `
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-red-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
          <div class="text-sm font-semibold text-red-900">${msg}</div>
        </div>
      `;
    }
  });
}
