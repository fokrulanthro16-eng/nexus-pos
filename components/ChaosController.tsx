'use client';

import React from 'react';
import { Wifi, WifiOff, Activity, RefreshCw, Database, AlertCircle } from 'lucide-react';

export type NetworkState = 'ONLINE' | 'FLAKY_3G' | 'OFFLINE';

interface ChaosControllerProps {
  networkState: NetworkState;
  onChangeNetworkState: (state: NetworkState) => void;
  pendingOutboxCount: number;
  onForceSync: () => void | Promise<void>;
  isSyncing?: boolean;
  terminalName?: string;
  lastSyncTime?: string | null;
}

export function ChaosController({
  networkState,
  onChangeNetworkState,
  pendingOutboxCount,
  onForceSync,
  isSyncing = false,
  terminalName = 'Terminal',
  lastSyncTime,
}: ChaosControllerProps) {
  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5 flex flex-col gap-3 shadow-lg">
      {/* Top Header: Node & Network Mode */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></div>
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
            Chaos Mesh: {terminalName}
          </span>
        </div>

        {/* Pending Outbox Queue Counter */}
        <div className="flex items-center gap-1.5">
          <Database className="w-3.5 h-3.5 text-zinc-400" />
          <span
            className={`text-xs font-mono font-medium px-2 py-0.5 rounded-full transition-all ${
              pendingOutboxCount > 0
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse'
                : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {pendingOutboxCount} {pendingOutboxCount === 1 ? 'event' : 'events'} in Outbox
          </span>
        </div>
      </div>

      {/* Network State Switcher Pill Group */}
      <div className="grid grid-cols-3 gap-1.5 p-1 bg-zinc-950 rounded-lg border border-zinc-800/80 text-xs font-medium">
        {/* ONLINE */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('ONLINE')}
          className={`flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all gap-1 ${
            networkState === 'ONLINE'
              ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-semibold">Online</span>
          </div>
          <span className="text-[10px] text-emerald-400/80 font-mono">0ms Latency</span>
        </button>

        {/* FLAKY 3G */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('FLAKY_3G')}
          className={`flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all gap-1 ${
            networkState === 'FLAKY_3G'
              ? 'bg-amber-600/20 text-amber-300 border border-amber-500/40 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
            <span className="font-semibold">Flaky 3G</span>
          </div>
          <span className="text-[10px] text-amber-400/80 font-mono">1.5s &bull; 30% Drop</span>
        </button>

        {/* OFFLINE */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('OFFLINE')}
          className={`flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all gap-1 ${
            networkState === 'OFFLINE'
              ? 'bg-rose-600/20 text-rose-300 border border-rose-500/40 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <WifiOff className="w-3.5 h-3.5 text-rose-400" />
            <span className="font-semibold">Offline Partition</span>
          </div>
          <span className="text-[10px] text-rose-400/80 font-mono">Disconnected</span>
        </button>
      </div>

      {/* Force Sync Action & Status */}
      <div className="flex items-center justify-between text-xs pt-1 border-t border-zinc-800/60">
        <div className="flex items-center gap-1.5 text-zinc-400 truncate">
          {networkState === 'OFFLINE' ? (
            <span className="flex items-center gap-1 text-rose-400 font-medium">
              <AlertCircle className="w-3.5 h-3.5" />
              Partition active &bull; local commits durable
            </span>
          ) : lastSyncTime ? (
            <span>Synced: {new Date(lastSyncTime).toLocaleTimeString()}</span>
          ) : (
            <span>Ready for peer push/pull</span>
          )}
        </div>

        <button
          type="button"
          disabled={isSyncing || networkState === 'OFFLINE'}
          onClick={onForceSync}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
            networkState === 'OFFLINE'
              ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
              : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow hover:shadow-cyan-500/20'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
          {isSyncing ? 'Reconciling...' : 'Force Sync Now'}
        </button>
      </div>
    </div>
  );
}
