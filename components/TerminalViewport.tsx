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
  CheckCircle2,
  Package,
  Search,
  X,
} from 'lucide-react';
import { offlineSmartSearch } from '@/lib/ai/local-search';
import { NexusClientDatabase } from '@/lib/db/client-db';
import { HybridLogicalClock } from '@/lib/hlc';
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
        // Safe database connection with 1500ms timeout
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

  // Sync outbox queue with central reconciler
  const triggerSync = useCallback(async () => {
    if (networkState === 'OFFLINE') return;
    if (!onSyncPush) return;

    setIsSyncing(true);
    try {
      // Simulate network latency / packet drops based on chaos state
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
        setLastSyncTime(new Date().toISOString());
        await refreshLocalState();
      }
    } catch (err: unknown) {
      console.warn(`[${terminalId}] Sync attempt failed:`, err);
    } finally {
      setIsSyncing(false);
    }
  }, [db, clock, terminalId, networkState, onSyncPush, refreshLocalState]);

  // Cart operations
  const addToCart = (item: InventoryItem) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.sku === item.sku);
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

  // Subtotals and Tax
  const cartSubtotal = useMemo(() => cart.reduce((acc, i) => acc + i.subtotal, 0), [cart]);
  const cartTax = useMemo(() => Number((cartSubtotal * 0.0825).toFixed(2)), [cartSubtotal]);
  const cartTotal = useMemo(() => Number((cartSubtotal + cartTax).toFixed(2)), [cartSubtotal, cartTax]);

  // Instant Checkout Commit
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
      paymentDetails:
        paymentMethod === 'CASH'
          ? { amountTendered: Math.ceil(cartTotal / 10) * 10, changeDue: Number((Math.ceil(cartTotal / 10) * 10 - cartTotal).toFixed(2)) }
          : { cardAuthCode: `AUTH_${Math.floor(100000 + Math.random() * 900000)}` },
    };

    // Commit to local IndexedDB with instant zero-latency stock decrement
    const { event } = await db.commitSale(salePayload, clock, terminalId);

    const tEnd = performance.now();
    const latency = Number((tEnd - tStart).toFixed(2));
    setLastCommitLatency(latency);
    setLastHlcString(HybridLogicalClock.toString(event.hlc));
    setLastSaleId(saleId);

    // Generate binary ESC/POS thermal receipt bytes
    const receiptBytes = generateEscPosReceipt(salePayload, {
      storeName: 'NEXUS COFFEE & BAKEHOUSE',
      storeAddress: `POS CLUSTER // ${terminalName.toUpperCase()}`,
      storeTaxId: 'NX-94810-77',
      cashierName: terminalName,
    });

    setActiveReceiptBytes(receiptBytes);
    setCart([]);
    await refreshLocalState();

    // Trigger celebratory particle animation
    try {
      confetti({
        particleCount: 30,
        spread: 60,
        origin: { y: 0.8 },
      });
    } catch {
      // safe fallback if canvas is unavailable
    }

    if (onSaleCommitted) {
      onSaleCommitted(event);
    }

    // If online, kick off background sync automatically
    if (networkState === 'ONLINE') {
      setTimeout(() => triggerSync(), 50);
    }
  };

  // Imperative handle for parent demo automated race condition runner
  const executeQuickSale = useCallback(
    async (sku: string, quantity: number, paymentMethod: PaymentMethod): Promise<SaleCommittedEvent | null> => {
      const item = inventory.find((i) => i.sku === sku);
      if (!item) return null;

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

  const borderColor = badgeColor === 'cyan' ? 'border-cyan-500/30' : 'border-purple-500/30';
  const headerBg = badgeColor === 'cyan' ? 'bg-cyan-950/40 text-cyan-300' : 'bg-purple-950/40 text-purple-300';
  const accentText = badgeColor === 'cyan' ? 'text-cyan-400' : 'text-purple-400';

  return (
    <div className={`flex flex-col h-full bg-zinc-950 border ${borderColor} rounded-2xl shadow-2xl overflow-hidden`}>
      {/* Terminal Viewport Top Bar */}
      <div className={`px-4 py-3 border-b border-zinc-800 flex items-center justify-between ${headerBg}`}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-700">
            <ShoppingBag className={`w-4 h-4 ${accentText}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight text-white">{terminalName}</span>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-zinc-900/80 border border-zinc-700/60 font-semibold">
                NODE: {terminalId}
              </span>
            </div>
          </div>
        </div>

        {/* 0ms Zero-Latency Commit Monitor */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[11px] font-mono">
            <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
            <span className="text-zinc-400">Latency:</span>
            <span className="font-bold text-emerald-400">
              {lastCommitLatency !== null ? `${lastCommitLatency}ms` : '0ms'} [LOCAL]
            </span>
          </div>
        </div>
      </div>

      {/* Chaos Mesh Network Controller */}
      <div className="p-3 border-b border-zinc-900 bg-zinc-900/30">
        <ChaosController
          terminalName={terminalName}
          networkState={networkState}
          onChangeNetworkState={onChangeNetworkState}
          pendingOutboxCount={pendingOutboxCount}
          onForceSync={triggerSync}
          isSyncing={isSyncing}
          lastSyncTime={lastSyncTime}
        />
      </div>

      {/* Main POS Split Layout: Products (Left) + Cart (Right) */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-0 overflow-hidden">
        {/* Products Grid (7 cols) */}
        <div className="md:col-span-7 p-3.5 overflow-y-auto border-r border-zinc-800/80 flex flex-col gap-3">
          {/* Header & Status */}
          <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
            <div className="flex items-center gap-1.5 font-medium">
              <Package className="w-3.5 h-3.5 text-zinc-400" />
              <span>Local Catalog &bull; Materialized Stock</span>
            </div>
            <span className="text-[11px] font-mono text-zinc-500">IndexedDB Synced</span>
          </div>

          {/* Offline Smart AI Search Input */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
              <Search className="w-3.5 h-3.5" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Offline AI Search (e.g. 'kroisant', 'nitro', 'mug')..."
              className="w-full pl-9 pr-8 py-2 bg-zinc-900 border border-zinc-700/80 rounded-xl text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 transition shadow-inner font-sans"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-zinc-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Search telemetry pill when active */}
          {searchQuery && (
            <div className="flex items-center justify-between px-1 text-[11px]">
              <span className="text-zinc-400 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-cyan-400" />
                <span>Found {searchResults.length} matching items</span>
              </span>
              <span className="text-cyan-400 font-mono text-[10px]">Zero-Cloud Edge AI</span>
            </div>
          )}

          {/* Products Grid */}
          {searchResults.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 text-xs flex flex-col items-center gap-1.5">
              <Search className="w-6 h-6 stroke-1 text-zinc-600" />
              <span>No items matched "{searchQuery}"</span>
              <span className="text-[10px] text-zinc-600">Try phonetic phrases like "kroisant" or "nitro"</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {searchResults.map((res) => {
                const item = res.item;
                const isLowStock = item.stock <= item.reorderThreshold && item.stock > 0;
                const isOutOrNegative = item.stock <= 0;

                return (
                  <div
                    key={item.sku}
                    onClick={() => addToCart(item)}
                    className={`group relative p-3 rounded-xl border text-left cursor-pointer transition-all flex flex-col justify-between ${
                      isOutOrNegative
                        ? 'bg-rose-950/20 border-rose-500/40 hover:border-rose-400'
                        : isLowStock
                        ? 'bg-amber-950/20 border-amber-500/30 hover:border-amber-400'
                        : 'bg-zinc-900/80 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/80'
                    }`}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-start justify-between gap-1">
                        <span className="font-semibold text-xs text-zinc-100 group-hover:text-white line-clamp-1">
                          {item.name}
                        </span>
                        <span className="font-mono text-xs font-bold text-zinc-200">
                          ${item.price.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-mono">{item.sku}</span>
                        {/* Instant Offline AI Match Badge */}
                        {searchQuery && res.isAiMatched && (
                          <span
                            title={res.matchReason}
                            className="text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1 shadow-sm"
                          >
                            <Sparkles className="w-2.5 h-2.5 text-cyan-400" />
                            AI Matched ({Math.round(res.score * 100)}%)
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between pt-2 border-t border-zinc-800/60 text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="text-zinc-500">Stock:</span>
                        <span
                          className={`font-mono font-bold px-1.5 py-0.2 rounded text-[11px] ${
                            isOutOrNegative
                              ? 'text-rose-400 bg-rose-500/10'
                              : isLowStock
                              ? 'text-amber-400 bg-amber-500/10'
                              : 'text-emerald-400 bg-emerald-500/10'
                          }`}
                        >
                          {item.stock}
                        </span>
                      </div>

                      <button
                        type="button"
                        className="p-1 rounded-md bg-zinc-800 group-hover:bg-cyan-600 text-zinc-400 group-hover:text-white transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Active Cart & Instant Checkout Tray (5 cols) */}
        <div className="md:col-span-5 p-3.5 flex flex-col justify-between bg-zinc-900/40 overflow-hidden">
          {/* Cart Header */}
          <div className="flex items-center justify-between pb-2.5 border-b border-zinc-800 text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <span>Active Cart</span>
              <span className="px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 font-mono text-[10px]">
                {cart.length}
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
                  className="p-2 rounded-lg bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between text-xs"
                >
                  <div className="flex flex-col truncate pr-2">
                    <span className="font-medium text-zinc-200 truncate">{item.name}</span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      ${item.price.toFixed(2)} each
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-md">
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
                    <span className="font-mono font-bold text-zinc-100 min-w-12 text-right">
                      ${item.subtotal.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Checkout Totals & Buttons */}
          <div className="pt-2.5 border-t border-zinc-800 flex flex-col gap-2">
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-zinc-400 text-[11px]">
                <span>Subtotal</span>
                <span className="font-mono">${cartSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-zinc-400 text-[11px]">
                <span>Tax (8.25%)</span>
                <span className="font-mono">${cartTax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-zinc-100 font-bold text-sm pt-1 border-t border-zinc-800/60">
                <span>Total Due</span>
                <span className="font-mono text-emerald-400">${cartTotal.toFixed(2)}</span>
              </div>
            </div>

            {/* Instant Offline Checkout Action Buttons */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => checkout('CASH')}
                className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-semibold text-xs shadow-md transition"
              >
                <Banknote className="w-4 h-4" />
                <span>Cash Checkout</span>
              </button>

              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => checkout('CARD')}
                className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-semibold text-xs shadow-md transition"
              >
                <CreditCard className="w-4 h-4" />
                <span>Card Checkout</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Telemetry Bar */}
      <div className="px-3 py-2 bg-zinc-950 border-t border-zinc-900 flex items-center justify-between text-[11px] font-mono text-zinc-500">
        <div className="flex items-center gap-2 truncate">
          <Clock className="w-3.5 h-3.5 text-zinc-600" />
          <span className="truncate">HLC: {lastHlcString}</span>
        </div>
        {lastSaleId && (
          <button
            onClick={() => {
              if (activeReceiptBytes) {
                setActiveReceiptBytes(activeReceiptBytes);
              }
            }}
            className="text-cyan-400 hover:underline flex items-center gap-1 shrink-0"
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
