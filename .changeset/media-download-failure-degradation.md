---
'@agent-wechat/shared': patch
---

Degrade failing media downloads instead of re-requesting them, and keep serving chat media from local disk:

- Media content for downloaded assets is served from the local sealed copy or the official profile; the content route never touches the CDN.
- A failed download now records a per-asset exponential backoff (60s doubling to a 30-minute ceiling). Retrying the transfer or the job inside that window is refused with `media_backoff` instead of issuing another CDN request.
- Ten download failures within a ten-minute window open an account-level circuit: new transfers and retries are refused with `media_circuit_open` until the window rolls over. One verified download clears the circuit.
- The automatic-download queue keeps pending requests during backoff or an open circuit without spending their attempt budget, and resumes them once the window passes.
- Chat message text and downloaded voice, video, image and file bytes stay stored in the official profile on disk; nothing new is fetched from the server to re-render them.
