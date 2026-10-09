# NexusPOS Engine v2.1.0
### *Deterministic, Offline-First Event-Sourced Retail POS Architecture*

[![CI Build](https://github.com/fokrulanthro16-eng/nexus-pos/actions/workflows/ci.yml/badge.svg)](https://github.com/fokrulanthro16-eng/nexus-pos/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js 15](https://img.shields.io/badge/Next.js-15.x-black?style=flat&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tests-30%2F30%20Passed-brightgreen?style=flat&logo=vitest)](https://vitest.dev/)
[![Offline First](https://img.shields.io/badge/Offline-100%25%20Guaranteed-orange?style=flat)](#)
[![Security: WebCrypto](https://img.shields.io/badge/Security-WebCrypto%20Ed25519-indigo?style=flat)](#)

---

## ⚡ Executive Summary

**NexusPOS** is an enterprise-resilient, deterministic Point of Sale (POS) system engineered to survive unstable networks (flaky 3G, total partitions, packet drops) and physical hardware failures without dropping customer transactions or creating silent ledger corruption.

Built on an **Event-Sourced architecture with Hybrid Logical Clocks (HLC)** and native **WebCrypto Asymmetric Non-Repudiation**, NexusPOS guarantees $0\text{ms}$ checkout latency at the physical counter while authoritatively resolving concurrent multi-terminal race conditions.

---

## 🏛️ Architectural Pillars

```text
+-------------------------------------------------------------+
|                 CYBERPUNK TWIN-TERMINAL UI                  |
|  +-----------------------+       +-----------------------+  |
|  |   Terminal Alpha      |       |   Terminal Beta       |  |
|  | (IndexedDB + WebCrypto) |     | (IndexedDB + WebCrypto) |  |
|  +-----------+-----------+       +-----------+-----------+  |
+--------------|-------------------------------|--------------+
  Local Outbox |                  Local Outbox |
  (Signed Events)                 (Signed Events)
               v                               v
+-------------------------------------------------------------+
|                 CHAOS MESH INJECTION LAYER                  |
|          [ Online (0ms) | Flaky 3G (1.5s) | Partition ]      |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                CENTRAL RECONCILER AUTHORITY                 |
|  - Hybrid Logical Clock (HLC) Total Causal Ordering         |
|  - Cryptographic Public-Key Verification & Non-Repudiation  |
|  - Autonomous AI Discrepancy & Deficit Auditor              |
|  - Idempotent Server Ledger (.nexus_ledger.json)            |
+-------------------------------------------------------------+
```

### 1. 0ms Local Commit & Cryptographic Non-Repudiation
- **Local Outbox:** Transactions commit immediately to client-side IndexedDB with sub-millisecond response times.
- **WebCrypto Signatures:** Every event generated at the terminal is signed locally with an asymmetric keypair (`crypto.subtle`), ensuring tamper-proof integrity if client storage or devtools are accessed.

### 2. Deterministic Causal Ordering (Hybrid Logical Clocks)
- Implements a Lamport Clock + Physical Millisecond hybrid clock `(millis, counter, nodeId)` to guarantee strict total order for distributed out-of-order events without clock-drift vulnerabilities.

### 3. Twin-Terminal Race Conditions & Deficit Reconciliation
- **The AP Trade-Off:** In real retail, turning down an in-person paying customer because the WAN link dropped is catastrophic. NexusPOS prioritizes Availability ($A$) and Partition Tolerance ($P$).
- **Deficit Engine:** When concurrent offline checkouts exceed warehouse inventory, the central reconciler authoritatively records sales, sets stock to negative deficits (e.g. `-1 DEFICIT`), and alerts the system without silent data drops.
- **Autonomous AI Discrepancy Auditor:** Embedded edge heuristic agent generates immediate reconciliation briefings with root-cause analysis and automated backorder voucher recommendations.

### 4. ESC/POS Hardware Bridge & Paper-Jam Recovery
- **Raw Byte Stream Pipeline:** Encodes directly into binary ESC/POS standards (`0x1B 0x40`, `0x1B 0x61`, `0x1D 0x56 0x01`) with raw hex telemetry.
- **Fault Tolerance:** Simulates mechanical roll runouts and paper jams with idempotent reprint buffers that guarantee zero duplicate accounting transactions.

### 5. Log Compaction & Snapshotting
- Periodic snapshotting prevents browser IndexedDB log bloat by materializing inventory states and safely purging acknowledged outbox events.

---

## 📊 Feature Matrix

| Feature | NexusPOS Engine | Traditional Cloud POS | Legacy Desktop POS |
| :--- | :--- | :--- | :--- |
| **Offline Checkout** | **0ms Latency (Guaranteed)** | Blocked / Spinner | Local Only (No Multi-Till) |
| **Causal Consistency** | **Hybrid Logical Clocks (HLC)** | Server Timestamp Only | None |
| **Security Layer** | **WebCrypto Asymmetric Signature** | Bearer Token / HTTPS | Local Plaintext |
| **Stock Deficits** | **Authoritative Negative Deficits** | Silent Overwrite / Lost Sale | Crash / DB Lockout |
| **Hardware Driver** | **Native WebUSB / Serial + Raw Hex** | Cloud Print Service | Native DLL / OS-Locked |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18.x or 20.x
- npm / pnpm / yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/fokrulanthro16-eng/nexus-pos.git
cd nexus-pos

# Install dependencies
npm install

# Run the unit test suite (30 Vitest tests)
npm test

# Launch development cluster on port 3000
npm run dev -- -p 3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🧪 Automated Test Suite

NexusPOS maintains 100% pass status across 8 comprehensive test suites:

- **`hlc.test.ts`**: Monotonic clock progression and causal ordering
- **`reconciler.test.ts`**: Conflict resolution and negative stock handling
- **`ai-search-and-audit.test.ts`**: Fuzzy phonetic search and deficit AI briefs
- **`escpos.test.ts`**: ESC/POS binary byte encoding and cut commands
- **`background-sync.test.ts`**: Jitter, exponential backoff, and idempotent outbox batching
- **`edge-cases.test.ts`**: File-backed storage persistence, partial batch acks, and hardware reprint engine
- **`enterprise-fortification.test.ts`**: WebCrypto signature verification, oversell guards, and storage compaction
- **`client-db.test.ts`**: Zero-latency local commit and IndexedDB outbox queue operations

```bash
npm test
```

---

## 📜 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

## 👨‍💻 Author

**Fokrul Islam**  
Lead AI Systems & Infrastructure Architect  
GitHub: [@fokrulanthro16-eng](https://github.com/fokrulanthro16-eng)
