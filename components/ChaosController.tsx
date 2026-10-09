'use client';

import React from 'react';
import { Wifi, WifiOff, Activity, RefreshCw, Database, Clock, Radio } from 'lucide-react';

export type NetworkState = 'ONLINE' | 'FLAKY_3G' | 'OFFLINE';

interface ChaosControllerProps {
  networkState: NetworkState;
  onChangeNetworkState: (state: NetworkState) => void;
  pendingOutboxCount: number;
  onForceSync: () => void | Promise<void>;
  isSyncing?: boolean;
  terminalName?: string;
  themeColor?: 'cyan' | 'purple';
  lastSyncTime?: string | null;
}

export function ChaosController({
  networkState,
  onChangeNetworkState,
  pendingOutboxCount,
  onForceSync,
  isSyncing = false,
  terminalName = 'Terminal Alpha',
  themeColor = 'cyan',
  lastSyncTime,
}: ChaosControllerProps) {
  const isCyan = themeColor === 'cyan';
  const pulseColor = isCyan ? 'bg-cyan-400 shadow-[0_0_8px_#22d3ee]' : 'bg-purple-400 shadow-[0_0_8px_#c084fc]';
  const syncBtnColor = isCyan
    ? 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-[0_0_15px_rgba(6,182,212,0.35)]'
    : 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-[0_0_15px_rgba(168,85,247,0.35)]';

  return (
    <div className="glass-card rounded-xl p-3 flex flex-col gap-2.5 border border-white/5 transition-all">
      {/* Top Header: Node & Network Mode & Outbox Counter */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${pulseColor} animate-pulse`}></div>
          <span className="text-[11px] font-semibold tracking-wider uppercase text-zinc-300 font-mono flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-zinc-400" />
            Chaos Mesh: {terminalName}
          </span>
        </div>

        {/* Pending Outbox Queue Counter Badge */}
        <div className="flex items-center gap-1.5">
          <Database className="w-3 h-3 text-zinc-400" />
          <span
            className={`text-[10px] font-mono font-medium px-2 py-0.5 rounded-full border transition-all ${
              pendingOutboxCount > 0
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 shadow-[0_0_10px_rgba(245,158,11,0.25)] animate-pulse'
                : 'bg-zinc-900/80 text-zinc-400 border-zinc-800'
            }`}
          >
            {pendingOutboxCount} {pendingOutboxCount === 1 ? 'event' : 'events'} in Outbox
          </span>
        </div>
      </div>

      {/* Network State Switcher: 3 Pill Buttons */}
      <div className="grid grid-cols-3 gap-1.5 p-1 bg-black/40 rounded-lg border border-white/5 text-xs font-medium">
        {/* ONLINE */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('ONLINE')}
          className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-md transition-all gap-0.5 border ${
            networkState === 'ONLINE'
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.25)] font-semibold'
              : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
          }`}
        >
          <div className="flex items-center gap-1">
            <Wifi className={`w-3.5 h-3.5 ${networkState === 'ONLINE' ? 'text-emerald-400' : 'text-zinc-400'}`} />
            <span className="text-[11px]">Online</span>
          </div>
          <span className="text-[9px] text-emerald-400/90 font-mono">Live &bull; 0ms</span>
        </button>

        {/* FLAKY 3G */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('FLAKY_3G')}
          className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-md transition-all gap-0.5 border ${
            networkState === 'FLAKY_3G'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-[0_0_12px_rgba(245,158,11,0.25)] font-semibold'
              : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
          }`}
        >
          <div className="flex items-center gap-1">
            <Activity className={`w-3.5 h-3.5 ${networkState === 'FLAKY_3G' ? 'text-amber-400 animate-pulse' : 'text-zinc-400'}`} />
            <span className="text-[11px]">Flaky 3G</span>
          </div>
          <span className="text-[9px] text-amber-400/90 font-mono">1.5s &bull; 30% Drop</span>
        </button>

        {/* OFFLINE PARTITION */}
        <button
          type="button"
          onClick={() => onChangeNetworkState('OFFLINE')}
          className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-md transition-all gap-0.5 border ${
            networkState === 'OFFLINE'
              ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-[0_0_12px_rgba(244,63,94,0.25)] font-semibold'
              : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
          }`}
        >
          <div className="flex items-center gap-1">
            <WifiOff className={`w-3.5 h-3.5 ${networkState === 'OFFLINE' ? 'text-rose-400' : 'text-zinc-400'}`} />
            <span className="text-[11px]">Offline Partition</span>
          </div>
          <span className="text-[9px] text-rose-400/90 font-mono">Disconnected</span>
        </button>
      </div>

      {/* Auto-Sync Badge & Force Sync Action */}
      <div className="flex items-center justify-between text-xs pt-1 border-t border-white/5">
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-cyan-300 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5 text-cyan-400" />
            Sync: 2s
          </span>
          <span className="text-[10px] font-mono text-zinc-500 truncate">
            {networkState === 'OFFLINE' ? (
              <span className="text-rose-400 font-medium">Offline Queue Buffer</span>
            ) : lastSyncTime ? (
              `Synced: ${new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            ) : (
              'Auto-sync Ready'
            )}
          </span>
        </div>

        <button
          type="button"
          disabled={isSyncing || networkState === 'OFFLINE'}
          onClick={onForceSync}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition active:scale-95 ${
            networkState === 'OFFLINE'
              ? 'bg-zinc-800/40 text-zinc-600 border border-zinc-800 cursor-not-allowed'
              : syncBtnColor
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'Syncing...' : 'Force Sync Now'}</span>
        </button>
      </div>
    </div>
  );
}
