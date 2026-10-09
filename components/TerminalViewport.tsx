'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import confetti from 'canvas-confetti';
import {
  ShoppingBag,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  Banknote,
  Clock,
  Printer,
  Sparkles,
  Zap,
  Package,
  Search,
  X,
  SlidersHorizontal,
  Coffee,
  Cookie,
  CupSoda,
  Award,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import { offlineSmartSearch } from '@/lib/ai/local-search';
import { NexusClientDatabase } from '@/lib/db/client-db';
import { HybridLogicalClock } from '@/lib/hlc';
import { evaluateOversellPolicy, STRICT_OVERSELL_REJECTION_MESSAGE } from '@/lib/policy/oversell-rules';
import { defaultCompactor } from '@/lib/storage/compactor';
import {
  CartItem,
  SalePayload,
  PaymentMethod,
  InventoryItem,
  SyncPushRequest,
  SyncPushResponse,
  SaleCommittedEvent,
} from '@/types/events';
import { generateEscPosReceipt } from '@/lib/hardware/escpos';
import { ChaosController, NetworkState } from './ChaosController';
import { VirtualThermalPrinter } from './VirtualThermalPrinter';

export interface TerminalViewportHandle {
  executeQuickSale: (sku: string, quantity: number, paymentMethod: PaymentMethod) => Promise<SaleCommittedEvent | null>;
  syncWithServer: () => Promise<void>;
  resetCatalog: (items: Array<{ sku: string; name: string; price: number; stock: number }>) => Promise<void>;
}

interface TerminalViewportProps {
  terminalId: string;
  terminalName: string;
  badgeColor?: 'cyan' | 'purple';
  onSyncPush?: (request: SyncPushRequest) => Promise<SyncPushResponse>;
  networkState: NetworkState;
  onChangeNetworkState: (state: NetworkState) => void;
  onSaleCommitted?: (event: SaleCommittedEvent) => void;
  registerHandle?: (handle: TerminalViewportHandle) => void;
}

export const INITIAL_PRODUCTS: Array<{
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

function getProductIcon(sku: string) {
  switch (sku) {
    case 'COLD_BREW_01':
      return <Coffee className="w-4 h-4 text-cyan-400" />;
    case 'CROISSANT_02':
      return <Cookie className="w-4 h-4 text-amber-400" />;
    case 'ORGANIC_OAT_03':
      return <CupSoda className="w-4 h-4 text-emerald-400" />;
    case 'LIMITED_EDITION_MUG':
      return <Award className="w-4 h-4 text-purple-400" />;
    default:
      return <Package className="w-4 h-4 text-zinc-400" />;
  }
}

export function TerminalViewport({
  terminalId,
  terminalName,
  badgeColor = 'cyan',
  onSyncPush,
  networkState,
  onChangeNetworkState,
  onSaleCommitted,
  registerHandle,
}: TerminalViewportProps) {
  const isCyan = badgeColor === 'cyan';
  const pingLatency = isCyan ? '8ms' : '6ms';
  const modeBadge = isCyan ? 'MODE: TERMINAL_ALPHA' : 'MODE: TERMINAL_BETA';

  // Local isolated client IndexedDB instance per terminal
  const db = useMemo(() => new NexusClientDatabase(`NexusPOS_${terminalId}`), [terminalId]);
  const clock = useMemo(() => new HybridLogicalClock(terminalId), [terminalId]);

  // Immediate default catalog to prevent any blank renders or race conditions
  const [inventory, setInventory] = useState<InventoryItem[]>(() =>
    INITIAL_PRODUCTS.map((p) => ({
      sku: p.sku,
      name: p.name,
      price: p.price,
      stock: p.stock,
      reorderThreshold: 2,
      category: p.category,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
  );
  const [cart, setCart] = useState<CartItem[]>([]);
  const [pendingOutboxCount, setPendingOutboxCount] = useState<number>(0);
  const [lastCommitLatency, setLastCommitLatency] = useState<number | null>(null);
  const [lastHlcString, setLastHlcString] = useState<string>('0-0-INIT');
  const [activeReceiptBytes, setActiveReceiptBytes] = useState<Uint8Array | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [policyToast, setPolicyToast] = useState<{ message: string; sku: string } | null>(null);

  // Auto-dismiss policy alert toast after 5 seconds
  useEffect(() => {
    if (policyToast) {
      const timer = setTimeout(() => setPolicyToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [policyToast]);

  // Offline AI Smart Search: Instant in-memory fuzzy, Levenshtein & phonetic matcher
  const searchResults = useMemo(() => {
    return offlineSmartSearch(searchQuery, inventory);
  }, [searchQuery, inventory]);

  // Refresh inventory & outbox from local IndexedDB (with fallback)
  const refreshLocalState = useCallback(async () => {
    try {
      const items = await db.getAllInventory();
      if (items && items.length > 0) {
        setInventory(items);
      }
      const outbox = await db.getPendingOutbox();
      setPendingOutboxCount(outbox.length);
    } catch (e) {
      console.warn(`[${terminalId}] Refresh local state notice:`, e);
    }
  }, [db, terminalId]);

  // Seed or initialize inventory on first mount with aggressive 1500ms safety timeout
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    let mounted = true;

    async function initDb() {
      try {
        await db.initClientDb(1500);

        const count = await db.inventory.count().catch(() => 0);
        if (count === 0) {
          for (const prod of INITIAL_PRODUCTS) {
            await db.initializeInventoryItem(
              {
                sku: prod.sku,
                name: prod.name,
                price: prod.price,
                stock: prod.stock,
                reorderThreshold: 2,
                category: prod.category,
              },
              clock,
              terminalId
            );
          }
        }
        if (mounted) {
          await refreshLocalState();
        }
      } catch (err) {
        console.warn(`[${terminalId}] DB init fallback enabled:`, err);
      }
    }

    initDb();
    return () => {
      mounted = false;
    };
  }, [db, clock, terminalId, refreshLocalState]);

  // Background synchronization trigger
  const triggerSync = useCallback(async () => {
    if (!onSyncPush) return;

    setIsSyncing(true);
    try {
      if (networkState === 'FLAKY_3G') {
        await new Promise((r) => setTimeout(r, 1500));
        if (Math.random() < 0.3) {
          throw new Error('Simulated 3G network packet drop!');
        }
      }

      const pending = await db.getPendingOutbox();
      if (pending.length === 0) {
        setIsSyncing(false);
        setLastSyncTime(new Date().toISOString());
        return;
      }

      const syncRequest: SyncPushRequest = {
        idempotencyKey: `sync_${terminalId}_${Date.now()}`,
        terminalId,
        events: pending.map((p) => p.event),
        clientHLC: clock.peek(),
      };

      const response = await onSyncPush(syncRequest);

      if (response.success) {
        clock.update(response.serverHLC);
        await db.markOutboxSynced(response.acceptedEventIds as string[]);

        // Compactor: Periodically snapshot and prune acknowledged events
        try {
          await defaultCompactor.checkAndCompact(db, clock, terminalId);
        } catch (compactionErr) {
          console.warn(`[${terminalId}] Compactor notice:`, compactionErr);
        }

        setLastSyncTime(new Date().toISOString());
        await refreshLocalState();
      }
    } catch (err: unknown) {
      console.warn(`[${terminalId}] Sync attempt failed:`, err);
    } finally {
      setIsSyncing(false);
    }
  }, [db, clock, terminalId, networkState, onSyncPush, refreshLocalState]);

  // Cart operations with Business Policy Oversell Guard
  const addToCart = (item: InventoryItem) => {
    const existing = cart.find((i) => i.sku === item.sku);
    const targetQty = (existing?.quantity || 0) + 1;
    const policyResult = evaluateOversellPolicy(item.sku, item.stock, targetQty);

    if (!policyResult.allowed) {
      setPolicyToast({
        message: policyResult.reason || STRICT_OVERSELL_REJECTION_MESSAGE,
        sku: item.sku,
      });
      return;
    }

    setCart((prev) => {
      if (existing) {
        return prev.map((i) =>
          i.sku === item.sku
            ? { ...i, quantity: i.quantity + 1, subtotal: (i.quantity + 1) * i.price }
            : i
        );
      }
      return [
        ...prev,
        {
          sku: item.sku,
          name: item.name,
          price: item.price,
          quantity: 1,
          subtotal: item.price,
        },
      ];
    });
  };

  const updateCartQuantity = (sku: string, delta: number) => {
    if (delta > 0) {
      const item = inventory.find((i) => i.sku === sku);
      const inCart = cart.find((i) => i.sku === sku);
      if (item && inCart) {
        const policyResult = evaluateOversellPolicy(sku, item.stock, inCart.quantity + delta);
        if (!policyResult.allowed) {
          setPolicyToast({
            message: policyResult.reason || STRICT_OVERSELL_REJECTION_MESSAGE,
            sku,
          });
          return;
        }
      }
    }

    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.sku === sku) {
            const nextQty = item.quantity + delta;
            return nextQty > 0
              ? { ...item, quantity: nextQty, subtotal: nextQty * item.price }
              : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[];
    });
  };

  const clearCart = () => setCart([]);

  const cartSubtotal = useMemo(() => cart.reduce((acc, it) => acc + it.subtotal, 0), [cart]);
  const cartTax = useMemo(() => Number((cartSubtotal * 0.0825).toFixed(2)), [cartSubtotal]);
  const cartTotal = useMemo(() => Number((cartSubtotal + cartTax).toFixed(2)), [cartSubtotal, cartTax]);

  // Instant Checkout
  const checkout = async (paymentMethod: PaymentMethod) => {
    if (cart.length === 0) return;

    const tStart = performance.now();
    const saleId = `sale_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const salePayload: SalePayload = {
      saleId,
      terminalId,
      cashierId: `cashier_${terminalId.toLowerCase()}`,
      items: [...cart],
      subtotal: cartSubtotal,
      tax: cartTax,
      total: cartTotal,
      paymentMethod,
    };

    const { event } = await db.commitSale(salePayload, clock, terminalId);
    const tEnd = performance.now();
    setLastCommitLatency(Number((tEnd - tStart).toFixed(2)));
    setLastHlcString(HybridLogicalClock.toString(event.hlc));
    setLastSaleId(saleId);

    const receiptBytes = generateEscPosReceipt(salePayload, {
      storeName: 'NEXUS RETAIL LAB',
      storeAddress: `${terminalName.toUpperCase()} POS TERMINAL`,
      cashierName: `OPERATOR_${terminalId}`,
    });
    setActiveReceiptBytes(receiptBytes);

    clearCart();
    await refreshLocalState();

    try {
      confetti({
        particleCount: 25,
        spread: 50,
        origin: { y: 0.8 },
      });
    } catch {
      // safe fallback
    }

    if (onSaleCommitted) {
      onSaleCommitted(event);
    }

    if (networkState === 'ONLINE') {
      setTimeout(() => triggerSync(), 50);
    }
  };

  // Imperative handle for parent race runner
  const executeQuickSale = useCallback(
    async (sku: string, quantity: number, paymentMethod: PaymentMethod): Promise<SaleCommittedEvent | null> => {
      const item = inventory.find((i) => i.sku === sku);
      if (!item) return null;

      const policyResult = evaluateOversellPolicy(item.sku, item.stock, quantity);
      if (!policyResult.allowed) {
        setPolicyToast({
          message: policyResult.reason || STRICT_OVERSELL_REJECTION_MESSAGE,
          sku: item.sku,
        });
        return null;
      }

      const tStart = performance.now();
      const saleId = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const subtotal = item.price * quantity;
      const tax = Number((subtotal * 0.0825).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));

      const salePayload: SalePayload = {
        saleId,
        terminalId,
        cashierId: `auto_${terminalId.toLowerCase()}`,
        items: [{ sku: item.sku, name: item.name, price: item.price, quantity, subtotal }],
        subtotal,
        tax,
        total,
        paymentMethod,
      };

      const { event } = await db.commitSale(salePayload, clock, terminalId);
      const tEnd = performance.now();
      setLastCommitLatency(Number((tEnd - tStart).toFixed(2)));
      setLastHlcString(HybridLogicalClock.toString(event.hlc));
      setLastSaleId(saleId);

      const receiptBytes = generateEscPosReceipt(salePayload, {
        storeName: 'NEXUS FAST-CHECKOUT',
        storeAddress: `${terminalName.toUpperCase()} AUTOMATION`,
      });
      setActiveReceiptBytes(receiptBytes);

      await refreshLocalState();
      if (onSaleCommitted) onSaleCommitted(event);
      return event;
    },
    [db, clock, terminalId, terminalName, inventory, refreshLocalState, onSaleCommitted]
  );

  const resetCatalog = useCallback(
    async (items: Array<{ sku: string; name: string; price: number; stock: number }>) => {
      await db.inventory.clear();
      await db.events.clear();
      await db.outbox.clear();
      for (const it of items) {
        await db.initializeInventoryItem(
          { sku: it.sku, name: it.name, price: it.price, stock: it.stock, reorderThreshold: 2 },
          clock,
          terminalId
        );
      }
      setCart([]);
      setActiveReceiptBytes(null);
      await refreshLocalState();
    },
    [db, clock, terminalId, refreshLocalState]
  );

  useEffect(() => {
    if (registerHandle) {
      registerHandle({
        executeQuickSale,
        syncWithServer: triggerSync,
        resetCatalog,
      });
    }
  }, [registerHandle, executeQuickSale, triggerSync, resetCatalog]);

  const borderClass = isCyan
    ? 'border-cyan-500/40 hover:border-cyan-400/60 shadow-[0_0_20px_-3px_rgba(6,182,212,0.18)]'
    : 'border-purple-500/40 hover:border-purple-400/60 shadow-[0_0_20px_-3px_rgba(168,85,247,0.18)]';

  const headerGradient = isCyan
    ? 'bg-gradient-to-r from-cyan-950/50 via-[#0a1120] to-[#07090e] border-b border-cyan-500/30'
    : 'bg-gradient-to-r from-purple-950/50 via-[#130d22] to-[#07090e] border-b border-purple-500/30';

  const accentColor = isCyan ? 'text-cyan-400' : 'text-purple-400';
  const badgeGlow = isCyan ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' : 'bg-purple-500/10 text-purple-300 border-purple-500/30';

  return (
    <div className={`relative flex flex-col h-full bg-[#090d16] border ${borderClass} rounded-2xl overflow-hidden transition-all duration-300`}>
      {/* Business Policy Allocation Guard Toast */}
      {policyToast && (
        <div className="absolute top-14 left-4 right-4 z-50 p-3.5 rounded-xl bg-rose-950/95 border border-rose-500/60 shadow-[0_0_25px_rgba(244,63,94,0.35)] backdrop-blur-md flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="p-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 shrink-0">
            <AlertTriangle className="w-4 h-4 text-rose-300" />
          </div>
          <div className="flex-1 text-xs">
            <div className="font-bold text-rose-200 flex items-center justify-between">
              <span>Inventory Allocation Policy Alert</span>
              <button
                type="button"
                onClick={() => setPolicyToast(null)}
                className="text-rose-400 hover:text-white p-0.5 rounded transition"
                title="Dismiss Alert"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="mt-1 text-rose-300/90 leading-relaxed font-sans">{policyToast.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-black/50 text-rose-300 border border-rose-500/30">
                SKU: {policyToast.sku}
              </span>
              <span className="text-[10px] text-zinc-400 font-sans">Offline Oversell: RESTRICTED</span>
            </div>
          </div>
        </div>
      )}

      {/* 1. Terminal Header */}
      <div className={`px-4 py-3 flex items-center justify-between ${headerGradient}`}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-black/50 border border-white/10">
            <ShoppingBag className={`w-4 h-4 ${accentColor}`} />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-extrabold text-sm tracking-tight text-white">{terminalName}</span>
              {/* Online status badge */}
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                {networkState === 'ONLINE' ? 'ONLINE' : networkState === 'FLAKY_3G' ? 'FLAKY' : 'OFFLINE'}
              </span>
              {/* Terminal Mode badge */}
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${badgeGlow}`}>
                {modeBadge}
              </span>
            </div>
          </div>
        </div>

        {/* Live ping latency & zero-latency commit badge */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/60 border border-white/10 text-[11px] font-mono">
            <Activity className="w-3 h-3 text-cyan-400" />
            <span className="text-zinc-400">Ping:</span>
            <span className="font-bold text-cyan-300">{pingLatency}</span>
            <span className="text-zinc-600">&bull;</span>
            <Zap className="w-3 h-3 text-amber-400 fill-amber-400" />
            <span className="font-bold text-emerald-400">
              {lastCommitLatency !== null ? `${lastCommitLatency}ms` : '0ms'} [LOCAL]
            </span>
          </div>
        </div>
      </div>

      {/* 2. Chaos Mesh Bar */}
      <div className="p-3 border-b border-white/5 bg-black/20">
        <ChaosController
          terminalName={terminalName}
          networkState={networkState}
          onChangeNetworkState={onChangeNetworkState}
          pendingOutboxCount={pendingOutboxCount}
          onForceSync={triggerSync}
          isSyncing={isSyncing}
          themeColor={badgeColor}
          lastSyncTime={lastSyncTime}
        />
      </div>

      {/* 3. Catalog & Cart Split View */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-0 overflow-hidden">
        {/* Left: Local Catalog (7 cols) */}
        <div className="md:col-span-7 p-3.5 overflow-y-auto border-r border-white/5 flex flex-col gap-3">
          {/* Header & Status */}
          <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
            <div className="flex items-center gap-1.5 font-medium">
              <Package className="w-3.5 h-3.5 text-zinc-400" />
              <span>Local Catalog &bull; Materialized Stock</span>
            </div>
            <span className="text-[10px] font-mono text-zinc-500">IndexedDB Zero-Latency</span>
          </div>

          {/* Search Input with Filter Icon */}
          <div className="relative flex items-center">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
              <Search className="w-3.5 h-3.5" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search catalog or phonetic requests (e.g. 'kroisant', 'nitro', 'mug')..."
              className="w-full pl-9 pr-9 py-2 bg-black/50 border border-white/10 rounded-xl text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 transition shadow-inner font-sans"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-zinc-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <SlidersHorizontal className="w-3 h-3 text-zinc-500 pointer-events-none" />
              )}
            </div>
          </div>

          {/* Search telemetry pill when active */}
          {searchQuery && (
            <div className="flex items-center justify-between px-1 text-[11px]">
              <span className="text-zinc-400 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-cyan-400" />
                <span>Found {searchResults.length} matching items</span>
              </span>
              <span className="text-cyan-400 font-mono text-[10px]">Zero-Cloud AI Matched</span>
            </div>
          )}

          {/* Products Grid */}
          {searchResults.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 text-xs flex flex-col items-center gap-1.5">
              <Search className="w-6 h-6 stroke-1 text-zinc-600" />
              <span>No items matched &quot;{searchQuery}&quot;</span>
              <span className="text-[10px] text-zinc-600">Try phonetic keywords like &quot;kroisant&quot;</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {searchResults.map((res) => {
                const item = res.item;
                const isLowStock = item.stock <= item.reorderThreshold && item.stock > 0;
                const isOutOrNegative = item.stock <= 0;
                const inCartQty = cart.find((c) => c.sku === item.sku)?.quantity || 0;

                return (
                  <div
                    key={item.sku}
                    className={`group relative p-3 rounded-xl border text-left transition-all flex flex-col justify-between ${
                      isOutOrNegative
                        ? 'bg-rose-950/25 border-rose-500/40 hover:border-rose-400 shadow-[0_0_15px_-4px_rgba(244,63,94,0.3)]'
                        : isLowStock
                        ? 'bg-amber-950/25 border-amber-500/35 hover:border-amber-400'
                        : 'glass-card border-white/5 hover:border-white/15 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          <div className="p-1.5 rounded-lg bg-black/60 border border-white/5 shrink-0">
                            {getProductIcon(item.sku)}
                          </div>
                          <div className="truncate">
                            <span className="font-semibold text-xs text-zinc-100 group-hover:text-white truncate block">
                              {item.name}
                            </span>
                            <span className="text-[10px] text-zinc-500 uppercase font-mono">{item.sku}</span>
                          </div>
                        </div>

                        {/* Price in USD $ */}
                        <span className="font-mono text-xs font-extrabold text-white shrink-0">
                          ${item.price.toFixed(2)}
                        </span>
                      </div>

                      {/* AI match confidence tag */}
                      {searchQuery && res.isAiMatched && (
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1 shadow-sm">
                            <Sparkles className="w-2.5 h-2.5 text-cyan-400" />
                            AI Matched ({Math.round(res.score * 100)}%)
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Stock pill & Cart increment/decrement buttons */}
                    <div className="mt-3 flex items-center justify-between pt-2 border-t border-white/5 text-[11px]">
                      <div className="flex items-center gap-1">
                        <span
                          className={`font-mono font-bold px-2 py-0.5 rounded text-[10px] uppercase ${
                            isOutOrNegative
                              ? 'text-rose-300 bg-rose-500/20 border border-rose-500/40 animate-pulse'
                              : isLowStock
                              ? 'text-amber-300 bg-amber-500/20 border border-amber-500/30'
                              : 'text-emerald-300 bg-emerald-500/15 border border-emerald-500/30'
                          }`}
                        >
                          {isOutOrNegative ? `${item.stock} DEFICIT` : `${item.stock} in stock`}
                        </span>
                      </div>

                      {/* Increment / Decrement Quantity Buttons */}
                      <div className="flex items-center gap-1">
                        {inCartQty > 0 && (
                          <button
                            type="button"
                            onClick={() => updateCartQuantity(item.sku, -1)}
                            className="p-1 rounded-md bg-zinc-900 border border-zinc-700 hover:bg-rose-900/50 hover:text-rose-300 text-zinc-300 transition"
                            title="Decrement cart"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                        )}
                        {inCartQty > 0 && (
                          <span className="font-mono text-xs font-bold text-white px-1">
                            {inCartQty}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => addToCart(item)}
                          className={`p-1 rounded-md transition flex items-center gap-1 ${
                            isCyan
                              ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-[0_0_10px_rgba(6,182,212,0.3)]'
                              : 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_10px_rgba(168,85,247,0.3)]'
                          }`}
                          title="Add to cart"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Active Cart Tray (5 cols) */}
        <div className="md:col-span-5 p-3.5 flex flex-col justify-between bg-black/40 overflow-hidden">
          {/* Cart Header */}
          <div className="flex items-center justify-between pb-2.5 border-b border-white/5 text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <span>Active Cart</span>
              <span className="px-2 py-0.5 rounded-full bg-zinc-900 border border-white/10 text-zinc-300 font-mono text-[10px]">
                {cart.length} {cart.length === 1 ? 'item' : 'items'}
              </span>
            </span>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={clearCart}
                className="text-zinc-500 hover:text-rose-400 text-[11px] flex items-center gap-1 transition"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto py-2 space-y-2 min-h-[140px]">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-600 text-xs py-8">
                <ShoppingBag className="w-8 h-8 stroke-[1.5] mb-2 text-zinc-700" />
                <span>Cart is empty</span>
                <span className="text-[10px] text-zinc-600">Select items from catalog</span>
              </div>
            ) : (
              cart.map((item) => (
                <div
                  key={item.sku}
                  className="p-2 rounded-lg bg-zinc-900/60 border border-white/5 flex items-center justify-between text-xs"
                >
                  <div className="flex flex-col truncate pr-2">
                    <span className="font-medium text-zinc-200 truncate">{item.name}</span>
                    <span className="text-[10px] font-mono text-zinc-400">
                      ${item.price.toFixed(2)} each
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center bg-black/60 border border-white/10 rounded-md">
                      <button
                        onClick={() => updateCartQuantity(item.sku, -1)}
                        className="p-1 hover:text-rose-400 text-zinc-400 transition"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="px-2 font-mono text-xs font-semibold text-zinc-200">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateCartQuantity(item.sku, 1)}
                        className="p-1 hover:text-emerald-400 text-zinc-400 transition"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    <span className="font-mono font-bold text-zinc-100 min-w-14 text-right">
                      ${item.subtotal.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Checkout Totals & Buttons */}
          <div className="pt-2.5 border-t border-white/5 flex flex-col gap-2">
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-zinc-400 text-[11px]">
                <span>Subtotal</span>
                <span className="font-mono">${cartSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-zinc-400 text-[11px]">
                <span>Tax (8.25%)</span>
                <span className="font-mono">${cartTax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-zinc-100 font-bold text-sm pt-1 border-t border-white/10">
                <span>Total Due</span>
                <span className="font-mono text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]">
                  ${cartTotal.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Instant Offline Checkout Action Buttons */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => checkout('CASH')}
                className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs shadow-[0_0_15px_rgba(16,185,129,0.25)] transition active:scale-95"
              >
                <Banknote className="w-4 h-4" />
                <span>Cash Checkout</span>
              </button>

              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => checkout('CARD')}
                className={`flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl text-white font-semibold text-xs transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                  isCyan
                    ? 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-[0_0_15px_rgba(6,182,212,0.25)]'
                    : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-[0_0_15px_rgba(168,85,247,0.25)]'
                }`}
              >
                <CreditCard className="w-4 h-4" />
                <span>Card Checkout</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Bottom Telemetry Bar */}
      <div className="px-3 py-2 bg-black/60 border-t border-white/5 flex items-center justify-between text-[11px] font-mono text-zinc-500">
        <div className="flex items-center gap-2 truncate">
          <Clock className="w-3.5 h-3.5 text-zinc-500" />
          <span className="truncate">HLC: {lastHlcString}</span>
        </div>
        {lastSaleId && (
          <button
            onClick={() => {
              if (activeReceiptBytes) {
                setActiveReceiptBytes(activeReceiptBytes);
              }
            }}
            className="text-cyan-400 hover:underline flex items-center gap-1 shrink-0 font-medium"
          >
            <Printer className="w-3 h-3" />
            Receipt Ready
          </button>
        )}
      </div>

      {/* Embedded Virtual Thermal Printer Modal */}
      {activeReceiptBytes && (
        <VirtualThermalPrinter
          receiptBytes={activeReceiptBytes}
          terminalName={terminalName}
          onClose={() => setActiveReceiptBytes(null)}
        />
      )}
    </div>
  );
}
