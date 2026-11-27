# ParallelZero

ParallelZero is a mobile-friendly chess website using six parallel ChessDrive Stockfish API requests and a custom local move selector.

## Current implementation

- Original dark chess interface preserved.
- Six simultaneous ChessDrive requests per analysis.
- Depth allocation: **38, 38, 37, 37, 37, 37** (224 total assigned depth).
- Each request asks for **five ranked lines**. Its rank-1 line supplies that calculator's own best move.
- The backend compares the six selected moves using median side-to-move evaluation, then vote count, depth, and deterministic tie-breaks.
- chess.js 0.10.3 validates and applies the selected move in the browser.
- Each game has 60-minute player clocks and a 60-minute overall session limit.
- App-level daily budget is 200 calls, with a hard stop at 198 to preserve two calls.
- App schedule pauses from 11:50 UTC until 00:05 UTC.

## Important distinctions

- The six calls use the same Stockfish provider/engine; they are six separate searches, not six different engine implementations.
- Six depths summing to 224 are an assigned depth budget, **not** equivalent to one depth-224 search.
- The 200-call cap and midnight UTC schedule are ParallelZero's planned app controls. They are not verified statements about ChessDrive's account quota or billing reset.
- ChessDrive bills by engine time. Check the live account balance and provider terms before real use.

## Backend and secret setup

The browser calls `/api/analyze`. The ChessDrive key is read only by the server from `CHESSDRIVE_API_KEY`; never put it in `index.html`.

Daily usage enforcement needs a persistent Upstash Redis REST database. Configure these server environment variables:

- `CHESSDRIVE_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Without both the API key and Redis variables, the backend fails closed and does not send paid engine requests.

## Deploy

This repository includes a Vercel serverless API route and `vercel.json`. Import the repository into a compatible Node.js hosting project, configure the three environment variables above, and deploy. The function is configured for a 90-second maximum duration. GitHub Pages alone cannot run the protected API route or persistent usage counter.

## Before production

1. Verify the API key and account's current balance/limits.
2. Confirm ChessDrive's actual daily reset behavior; the app's own usage counter resets at 00:00 UTC.
3. Test all six requests and confirm each returns five ranked lines.
4. Test score perspective for White and Black, mate scores, timeouts, and failed batches.
5. Test Redis atomic reservations under simultaneous sessions.
6. Verify the deployment host supports the configured function duration.
