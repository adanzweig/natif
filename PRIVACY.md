# Privacy: what data leaves the device

| Data | Leaves the device? | When | Where to | Retention |
|---|---|---|---|---|
| User input | **No**, except fallback | Only if the device can't run the task **and** the user accepted `cloudFallback` **and** the project is not *device-only* | Natif Cloud Function → Claude API | Not stored or logged by Natif. Anthropic applies its standard retention policy unless a Zero Data Retention agreement is in place. |
| Output | No, except fallback | Same as above (returned in the response) | — | Not stored on our server. |
| Telemetry | Only with `telemetry: true` | After each call, in batches | Firestore (`projects/*/events`) | 90 days (TTL). |
| Task configuration | Downloaded | On first use | Server → device | Local cache (IndexedDB / app storage). |
| Model weights | Downloaded | On first use or background preload | Hugging Face → browser Cache Storage / app files | Until the user clears site data or `clearCache()` is called. |

**Telemetry fields (closed list, validated on client and server):** date, task, task version, where it ran, model, device-class key, platform, latency, load time, tokens/s, input and output tokens, outcome (ok/error), fallback reason, SDK version. Never input text, outputs, user ids or IP addresses.

**Device-class key:** a hash of rounded *class* traits (browser and major version, GPU, memory in powers of two). Per-class averages are only used with 20 or more devices.

**Knowledge / RAG:** documents passed to `knowledge` are chunked and ranked on the device. They are never sent to Natif.

**To do before production:** shorten or exclude Cloud Run request logs (they record IPs by default) and a GDPR/CCPA review.
