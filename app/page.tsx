'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Server,
  Layers,
  AlertTriangle,
  Play,
  RotateCcw,
  Zap,
  ShieldAlert,
  Clock,
  Terminal,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { NexusCentralReconciler } from '@/lib/sync/reconciler';
import { HybridLogicalClock } from '@/lib/hlc';
import { OfflineDiscrepancyAuditor, AuditNarrativeReport } from '@/lib/ai/audit-agent';
import {
  SyncPushRequest,
  SyncPushResponse,
  NexusEvent,
  DiscrepancyPayload,
  InventoryItem,
} from '@/types/events';
import {
  TerminalViewport,
  TerminalViewportHandle,
  INITIAL_PRODUCTS,
} from '@/components/TerminalViewport';
import { NetworkState } from '@/components/ChaosController';

export const DEFAULT_MOCK_PRODUCTS: Array<{
  sku: string;
  name: string;
  price: number;
  stock: number;
  category: string;
}> = [
  { sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, stock: 12, category: 'Beverage' },
  { sku: 'CROISSANT_02', name: 'Artisan Croissant', price: 3.75, stock: 8, category: 'Bakery' },
  { sku: 'ORGANIC_OAT_03', name: 'Organic Oat Milk Latte', price: 5.25, stock: 10, category: 'Beverage' },
  { sku: 'LIMITED_EDITION_MUG', name: 'Limited Ceramic Mug', price: 18.0, stock: 1, category: 'Merchandise' },
];

export default function NexusPOSDemoPage() {
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const hasBootstrappedRef = useRef(false);

  // Central Authoritative Reconciler instance
  const reconciler = useMemo(() => {
    const epoch = '2026-01-01T00:00:00.000Z';
    return new NexusCentralReconciler('CENTRAL_CLOUD_HUB', [
      {
        sku: 'COLD_BREW_01',
        name: 'Cold Brew 16oz',
        price: 4.5,
        stock: 12,
        reorderThreshold: 2,
        updatedAt: epoch,
      },
      {
        sku: 'CROISSANT_02',
        name: 'Artisan Croissant',
        price: 3.75,
        stock: 8,
        reorderThreshold: 2,
        updatedAt: epoch,
      },
      {
        sku: 'ORGANIC_OAT_03',
        name: 'Organic Oat Milk Latte',
        price: 5.25,
        stock: 10,
        reorderThreshold: 2,
        updatedAt: epoch,
      },
      {
        sku: 'LIMITED_EDITION_MUG',
        name: 'Limited Ceramic Mug',
        price: 18.0,
        stock: 1, // Only 1 physical unit in central inventory for race condition demo!
        reorderThreshold: 1,
        updatedAt: epoch,
      },
    ]);
  }, []);

  // Shared server monitor state initialized with immediate in-memory mock products
  const [serverInventory, setServerInventory] = useState<InventoryItem[]>(() =>
    DEFAULT_MOCK_PRODUCTS.map((p) => ({
      sku: p.sku,
      name: p.name,
      price: p.price,
      stock: p.stock,
      reorderThreshold: 1,
      category: p.category,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
  );
  const [serverEvents, setServerEvents] = useState<NexusEvent[]>([]);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyPayload[]>([]);
  const [serverHlcStr, setServerHlcStr] = useState<string>('INIT');

  // Terminal Alpha & Beta network chaos states
  const [alphaNetwork, setAlphaNetwork] = useState<NetworkState>('ONLINE');
  const [betaNetwork, setBetaNetwork] = useState<NetworkState>('ONLINE');

  // Simulation status & drawer controls
  const [isSimulatingRace, setIsSimulatingRace] = useState(false);
  const [raceStepDescription, setRaceStepDescription] = useState<string | null>(null);
  const [isEventFeedExpanded, setIsEventFeedExpanded] = useState(true);

  // Terminal viewport imperative handles
  const alphaRef = useRef<TerminalViewportHandle | null>(null);
  const betaRef = useRef<TerminalViewportHandle | null>(null);

  // Update server view state
  const refreshServerState = useCallback(() => {
    try {
      const invMap = reconciler.getAllInventory();
      if (invMap.size > 0) {
        setServerInventory(Array.from(invMap.values()));
      }
      setDiscrepancies(reconciler.getDiscrepancies() as DiscrepancyPayload[]);
      setServerHlcStr(HybridLogicalClock.toString(reconciler.getServerClock().peek()));
    } catch (e) {
      console.warn('[NexusPOS] Refresh server state notice:', e);
    }
  }, [reconciler]);

  // Guaranteed bootstrap execution with 1500ms safety timeout
  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;

    let isMounted = true;

    // Aggressive 1500ms safety timeout: guaranteed unlock even if browser IndexedDB hangs
    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        setIsBootstrapping(false);
      }
    }, 1500);

    try {
      refreshServerState();
    } catch (err) {
      console.warn('[NexusPOS] Bootstrap sequence notice:', err);
    } finally {
      if (isMounted) {
        clearTimeout(safetyTimer);
        setIsBootstrapping(false);
      }
    }

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
    };
  }, [refreshServerState]);

  // Central sync handler invoked by terminals
  const handleTerminalSyncPush = useCallback(
    async (request: SyncPushRequest): Promise<SyncPushResponse> => {
      const response = reconciler.handleSyncPush(request);

      // Record events in central history
      setServerEvents((prev) => {
        const combined = [...prev];
        for (const evt of request.events) {
          if (!combined.some((e) => e.eventId === evt.eventId)) {
            combined.push(evt);
          }
        }
        return combined.sort((a, b) => HybridLogicalClock.compare(b.hlc, a.hlc)); // newest first
      });

      refreshServerState();

      if (response.discrepancies.length > 0) {
        // Trigger alert confetti
        try {
          confetti({
            particleCount: 50,
            spread: 80,
            origin: { y: 0.2 },
          });
        } catch {
          // ignore
        }
      }

      return response;
    },
    [reconciler, refreshServerState]
  );

  // Derived inventory and AI auditor state evaluated unconditionally at top level
  const mugItem = useMemo(
    () => serverInventory.find((i) => i.sku === 'LIMITED_EDITION_MUG'),
    [serverInventory]
  );
  const hasNegativeStock = mugItem ? mugItem.stock < 0 : false;

  // Autonomous Offline AI Auditor Brief (Top-Level Hook, strictly before conditional return)
  const auditBrief: AuditNarrativeReport | null = useMemo(() => {
    if (discrepancies.length === 0) return null;
    const latest = discrepancies[discrepancies.length - 1];
    return OfflineDiscrepancyAuditor.generateBrief(latest, {
      item: mugItem,
      relatedEvents: serverEvents,
      currencySymbol: '$',
    });
  }, [discrepancies, mugItem, serverEvents]);

  // Automated Race Condition Staging Runner
  const triggerRaceConditionDemo = async () => {
    if (isSimulatingRace) return;
    setIsSimulatingRace(true);

    try {
      // Step 1: Reset state to baseline (Stock = 1 for LIMITED_EDITION_MUG)
      setRaceStepDescription('1/5: Initializing baseline catalog with exactly 1 Limited Edition Titanium Mug...');
      await alphaRef.current?.resetCatalog(INITIAL_PRODUCTS);
      await betaRef.current?.resetCatalog(INITIAL_PRODUCTS);

      // Reset central reconciler memory
      reconciler.reconcileBatch([
        {
          eventId: `evt_reset_${Date.now()}`,
          type: 'INVENTORY_INITIALIZED',
          payload: {
            sku: 'LIMITED_EDITION_MUG',
            name: 'Limited Ceramic Mug',
            price: 18.0,
            stock: 1,
            reorderThreshold: 1,
          },
          hlc: reconciler.getServerClock().now(),
          terminalId: 'SERVER',
          version: 1,
          synced: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      refreshServerState();
      await new Promise((r) => setTimeout(r, 1200));

      // Step 2: Sever network connection on both terminals (Offline Partition)
      setRaceStepDescription('2/5: Chaos Mesh partition active — Disconnecting Terminal Alpha & Beta...');
      setAlphaNetwork('OFFLINE');
      setBetaNetwork('OFFLINE');
      await new Promise((r) => setTimeout(r, 1400));

      // Step 3: Terminal Alpha sells the 1 unit (Cash checkout)
      setRaceStepDescription('3/5: Customer A buys the last mug on Terminal Alpha (0ms local commit)...');
      await alphaRef.current?.executeQuickSale('LIMITED_EDITION_MUG', 1, 'CASH');
      await new Promise((r) => setTimeout(r, 1200));

      // Step 4: Terminal Beta concurrently sells the same 1 unit (Card checkout)
      setRaceStepDescription('4/5: Customer B buys the same mug on Terminal Beta offline (0ms local commit)...');
      await betaRef.current?.executeQuickSale('LIMITED_EDITION_MUG', 1, 'CARD');
      await new Promise((r) => setTimeout(r, 1500));

      // Step 5: Network recovers! Sync both terminals with central reconciler
      setRaceStepDescription('5/5: Network restored! Reconciling event logs via Hybrid Logical Clock...');
      setAlphaNetwork('ONLINE');
      setBetaNetwork('ONLINE');
      await new Promise((r) => setTimeout(r, 500));

      await alphaRef.current?.syncWithServer();
      await new Promise((r) => setTimeout(r, 600));
      await betaRef.current?.syncWithServer();

      refreshServerState();
      setRaceStepDescription('Complete! Discrepancy logged: physical sales accepted & stock set to -1.');
    } catch (err) {
      console.error('Race demo error:', err);
      setRaceStepDescription('Simulation encountered an error. Check console.');
    } finally {
      setTimeout(() => {
        setIsSimulatingRace(false);
      }, 3000);
    }
  };

  const resetAllClusterState = async () => {
    await alphaRef.current?.resetCatalog(INITIAL_PRODUCTS);
    await betaRef.current?.resetCatalog(INITIAL_PRODUCTS);
    setAlphaNetwork('ONLINE');
    setBetaNetwork('ONLINE');
    setServerEvents([]);
    refreshServerState();
  };

  // Conditional render guard ONLY right before final JSX return
  if (isBootstrapping) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center text-zinc-400 font-mono gap-3">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
        <span>Bootstrapping NexusPOS Offline Engine Cluster...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-black">
      {/* Top Global Command Header */}
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-40 px-5 py-3">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-black font-black shadow-lg shadow-cyan-500/20">
              <Zap className="w-5 h-5 fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-base tracking-tight text-white">
                  NexusPOS <span className="text-cyan-400 font-medium">Engine</span>
                </h1>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                  OFFLINE-FIRST EVENT SOURCING
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Twin-Terminal Distributed Architecture &bull; Hybrid Logical Clock &bull; Non-Repudiation Sales
              </p>
            </div>
          </div>

          {/* Interactive Actions & Race Trigger */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              disabled={isSimulatingRace}
              onClick={triggerRaceConditionDemo}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl font-semibold text-xs transition shadow-lg ${
                isSimulatingRace
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 cursor-wait'
                  : 'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black font-bold shadow-amber-500/20 hover:scale-[1.02]'
              }`}
            >
              <Play className={`w-3.5 h-3.5 fill-current ${isSimulatingRace ? 'animate-spin' : ''}`} />
              <span>{isSimulatingRace ? 'Simulating Race Condition...' : 'Stage Twin-Terminal Race Condition'}</span>
            </button>

            <button
              type="button"
              disabled={isSimulatingRace}
              onClick={resetAllClusterState}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-zinc-300 text-xs font-medium transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Cluster</span>
            </button>
          </div>
        </div>

        {/* Live Step Progression Notification */}
        {raceStepDescription && (
          <div className="max-w-7xl mx-auto mt-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-amber-500/40 flex items-center gap-2 text-xs text-amber-300 animate-in fade-in">
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="font-mono">{raceStepDescription}</span>
          </div>
        )}
      </header>

      {/* Discrepancy / Backorder Alert Banner with Embedded Offline AI Auditor */}
      {discrepancies.length > 0 && auditBrief && (
        <div className="bg-rose-950/80 border-b border-rose-500/60 px-5 py-4 text-rose-200">
          <div className="max-w-7xl mx-auto flex flex-col gap-3">
            {/* Top Banner Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2 border-b border-rose-900/60 pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-pulse">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-white">AUTONOMOUS AUDIT BRIEF:</span>
                    <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-rose-500/30 text-rose-200 border border-rose-500/40">
                      INCIDENT #{auditBrief.incidentId.slice(-6)}
                    </span>
                    <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                      SEVERITY: {auditBrief.severity}
                    </span>
                  </div>
                  <p className="text-xs text-rose-300/90 mt-0.5">
                    Offline-First Invariant: <strong>Physical confirmed sales are NEVER rejected</strong>. Inventory decremented to{' '}
                    <span className="font-mono font-bold text-white bg-rose-900/80 px-1 py-0.5 rounded">
                      Stock: {mugItem?.stock}
                    </span>.
                  </p>
                </div>
              </div>

              <div className="text-right shrink-0">
                <span className="text-[10px] font-mono px-2.5 py-1 rounded-full bg-rose-900/60 text-rose-200 border border-rose-700/50">
                  Zero-Cloud Edge AI Auditor
                </span>
              </div>
            </div>

            {/* Structured Executive Brief Content */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {/* Root Cause Card */}
              <div className="p-3 rounded-xl bg-black/40 border border-rose-800/40 flex flex-col gap-1.5">
                <span className="font-bold text-rose-300 uppercase text-[10px] tracking-wider flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                  Root Cause Analysis
                </span>
                <p className="text-zinc-300 text-[11px] leading-relaxed">
                  {auditBrief.rootCauseSummary}
                </p>
              </div>

              {/* Financial Ledger Card */}
              <div className="p-3 rounded-xl bg-black/40 border border-rose-800/40 flex flex-col gap-1.5">
                <span className="font-bold text-emerald-400 uppercase text-[10px] tracking-wider flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  Financial Ledger Status
                </span>
                <p className="text-zinc-300 text-[11px] leading-relaxed">
                  {auditBrief.financialLedgerSummary}
                </p>
              </div>

              {/* Immediate Resolution Card */}
              <div className="p-3 rounded-xl bg-black/40 border border-rose-800/40 flex flex-col gap-1.5">
                <span className="font-bold text-amber-300 uppercase text-[10px] tracking-wider flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                  Immediate Resolution
                </span>
                <p className="text-zinc-300 text-[11px] leading-relaxed">
                  {auditBrief.immediateResolution}
                </p>
              </div>
            </div>

            {/* Actionable Checkpoints */}
            <div className="pt-1 flex flex-wrap gap-2 text-[11px] text-zinc-300">
              <span className="text-rose-400 font-semibold">Recommended Actions:</span>
              {auditBrief.remediationSteps.map((step, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded-md bg-zinc-900/80 border border-rose-800/40 text-zinc-300 flex items-center gap-1"
                >
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  <span>{step}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main Dual Viewport Split Screen */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 flex flex-col gap-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
          {/* Left: Terminal Alpha */}
          <div className="flex flex-col h-[640px]">
            <TerminalViewport
              terminalId="TERM_ALPHA"
              terminalName="Terminal Alpha"
              badgeColor="cyan"
              networkState={alphaNetwork}
              onChangeNetworkState={setAlphaNetwork}
              onSyncPush={handleTerminalSyncPush}
              registerHandle={(h) => {
                alphaRef.current = h;
              }}
            />
          </div>

          {/* Right: Terminal Beta */}
          <div className="flex flex-col h-[640px]">
            <TerminalViewport
              terminalId="TERM_BETA"
              terminalName="Terminal Beta"
              badgeColor="purple"
              networkState={betaNetwork}
              onChangeNetworkState={setBetaNetwork}
              onSyncPush={handleTerminalSyncPush}
              registerHandle={(h) => {
                betaRef.current = h;
              }}
            />
          </div>
        </div>

        {/* Central Authoritative Server Monitor Drawer */}
        <section className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4 shadow-xl flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-cyan-400">
                <Server className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-sm text-zinc-100">Central Reconciler Authority</h2>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                    AUTHORITATIVE
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400">
                  Global State &bull; Server HLC: <code className="text-zinc-300">{serverHlcStr}</code>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsEventFeedExpanded((p) => !p)}
              className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition"
            >
              <span>{isEventFeedExpanded ? 'Collapse Monitor' : 'Expand Monitor'}</span>
              {isEventFeedExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {isEventFeedExpanded && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 pt-1">
              {/* Authoritative Global Stock Inventory (5 cols) */}
              <div className="md:col-span-5 flex flex-col gap-2">
                <span className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-zinc-400" />
                  Global Stock Matrix
                </span>

                <div className="space-y-1.5">
                  {serverInventory.map((item) => {
                    const isNeg = item.stock < 0;
                    return (
                      <div
                        key={item.sku}
                        className={`p-2 rounded-lg border text-xs flex items-center justify-between transition-all ${
                          isNeg
                            ? 'bg-rose-950/40 border-rose-500 text-white font-medium animate-pulse'
                            : 'bg-zinc-900/60 border-zinc-800 text-zinc-300'
                        }`}
                      >
                        <div className="flex flex-col truncate pr-2">
                          <span className="font-medium truncate">{item.name}</span>
                          <span className="text-[10px] text-zinc-500 font-mono">{item.sku}</span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 font-mono">
                          <span className="text-[11px] text-zinc-400">${item.price.toFixed(2)}</span>
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-bold ${
                              isNeg
                                ? 'bg-rose-600 text-white'
                                : item.stock <= 1
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : 'bg-zinc-800 text-emerald-400'
                            }`}
                          >
                            {item.stock} in stock
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Authoritative Live Event Log Feed (7 cols) */}
              <div className="md:col-span-7 flex flex-col gap-2">
                <span className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-zinc-400" />
                  Authoritative Event Log (HLC Order &bull; Causal Horizon)
                </span>

                <div className="bg-black/80 rounded-xl border border-zinc-800 p-3 h-48 overflow-y-auto font-mono text-[11px] space-y-1.5">
                  {serverEvents.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-zinc-600">
                      <span>No events reconciled yet. Commit sales or run race demo.</span>
                    </div>
                  ) : (
                    serverEvents.map((evt) => {
                      const hlcFormatted = `${evt.hlc.millis}-${evt.hlc.counter}`;
                      let badge = 'text-cyan-400 bg-cyan-950/60 border-cyan-800';
                      if (evt.type === 'SALE_COMMITTED') badge = 'text-emerald-400 bg-emerald-950/60 border-emerald-800';
                      if (evt.type === 'DISCREPANCY_FLAGGED') badge = 'text-rose-400 bg-rose-950/60 border-rose-800';

                      return (
                        <div
                          key={evt.eventId}
                          className="flex items-center justify-between p-1.5 rounded hover:bg-zinc-900/60 border border-transparent hover:border-zinc-800"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${badge}`}>
                              {evt.type}
                            </span>
                            <span className="text-zinc-300 truncate">
                              {evt.type === 'SALE_COMMITTED'
                                ? `Sale $${evt.payload.total.toFixed(2)} (${evt.payload.paymentMethod}) by ${evt.terminalId}`
                                : evt.type === 'INVENTORY_INITIALIZED'
                                ? `Init ${evt.payload.sku} (Stock: ${evt.payload.stock})`
                                : evt.type === 'DISCREPANCY_FLAGGED'
                                ? `Deficit ${evt.payload.deficit} on ${evt.payload.sku}`
                                : evt.eventId}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 text-[10px] text-zinc-500 shrink-0">
                            <span>HLC:{hlcFormatted}</span>
                            <span className="text-zinc-600">&bull; {evt.terminalId}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
