# NexusPOS Engine v2.1.0

> **Deterministic Offline-First Event-Sourced Retail Point-of-Sale (POS) Architecture**  
> Built with Next.js 16 (App Router & Turbopack), TypeScript, Tailwind CSS, IndexedDB (Dexie.js), and Hybrid Logical Clocks.

---

## ⚡ Core Architecture & Guarantees

### 1. Offline-First Non-Repudiation Invariant
- **0ms Local Commit:** Every transaction is immediately committed to local IndexedDB and materialized stock is decremented with zero network latency.
- **Physical Sales Non-Repudiation:** A customer who has already paid cash or card at a physical till is never rejected upon sync, even during concurrent offline sellouts.

### 2. Negative Stock Deficit Logging & Discrepancy Alerts
- **Concurrent Sellout Reconciliation:** When concurrent offline checkouts across **Terminal Alpha** and **Terminal Beta** exceed central warehouse stock, the central reconciler authoritatively accepts both sales, drives inventory into negative stock (e.g. `-1 DEFICIT`), and emits an immutable `DISCREPANCY_FLAGGED` incident.
- **Autonomous Zero-Cloud Edge AI Auditor:** An embedded local heuristic agent (`OfflineDiscrepancyAuditor`) analyzes the causal timeline and generates an executive briefing covering root cause analysis, financial ledger reconciliation, and safety-stock allocation steps.

### 3. Monotonic Hybrid Logical Clocks (HLC)
- Implements a Lamport + physical clock hybrid (`{ millis, counter, nodeId }`) for strict total causal ordering of distributed checkout events without central clock drift skew.

### 4. ESC/POS Virtual Thermal Printer & WebUSB Bridge
- **Raw Byte Stream Pipeline:** Encodes receipts in authentic binary ESC/POS commands (`0x1B 0x40`, `0x1B 0x61`, `0x1D 0x56 0x01`).
- **Hardware Fault Simulator:** Injects mechanical paper jams and roll outages with dedicated idempotent non-fiscal **Reprint** buttons that re-execute raw byte streams without duplicating financial ledger entries.
- **Physical WebUSB / WebSerial Bridge:** Communicates directly with Epson, Star Micronics, and Xprinter thermal heads via W3C WebUSB/WebSerial with fallback to virtual canvas emulation.

### 5. Persistent Server Ledger
- Backed by `.nexus_ledger.json` across server or container reboots with fine-grained batch acknowledgment (`acceptedEventIds`), retaining unacknowledged events in the client outbox for exponential backoff & jitter retry.

---

## 🖥️ UI: Cyberpunk Dark Glassmorphism Split-Screen

- **Deep Obsidian Theme (`#07090e`)** with frosted glass panels and neon glow accents.
- **Terminal Alpha (Cyan Glow):** Local Catalog, Search, and Cart tray for Node A.
- **Terminal Beta (Purple Glow):** Concurrently active Node B with live ping metrics.
- **Chaos Mesh Controller:** One-click network simulation toggling between `Online (0ms)`, `Flaky 3G (1.5s latency, 30% drop)`, and `Offline Partition (100% disconnected)`.
- **Central Reconciler Authority Monitor:** Live authoritative inventory matrix and real-time HLC-ordered event stream.

---

## 🧪 Verification & Testing

Run the full automated test suite (24 tests across 7 test files):

```bash
npm test
```

Run TypeScript compilation check:

```bash
npx tsc --noEmit
```

Build the production Next.js bundle:

```bash
npm run build
```

Start the development cluster:

```bash
npm run dev -- -p 3000
```
