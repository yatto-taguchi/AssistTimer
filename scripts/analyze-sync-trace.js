#!/usr/bin/env node
/**
 * Assist Timer — Salon Sync Trace Analyzer (Issue #13)
 *
 * Usage:
 *   node scripts/analyze-sync-trace.js <staffA_main.jsonl> [staffB_sub.jsonl ...] [--markdown]
 *   node scripts/analyze-sync-trace.js --self-test
 *
 * Pure Node.js standard library CLI tool.
 * Joins multi-device JSONL trace exports using the dual correlation keys (`traceId` + `stateRev`),
 * computes per-scene & per-stage reachability (%) and clock-skew-adjusted latency (median / max ms),
 * ranks Drop / Skip / Error causes, detects "reflected only after screen tap (USER_TAP_WAKE)" cases,
 * and outputs a GitHub Issue #13-ready Markdown report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ORIGIN_HOPS = new Set(['W_ORIGIN_ACT', 'P_ORIGIN_ACT', 'P_MAIN_ORIGIN']);
const OWN_PHONE_WC_HOPS = new Set(['N_WC_RX', 'P_WC_RX', 'P_WATCH_ACT_APPLY', 'P_MAIN_WATCH_RX']);
const CLOUD_WRITE_HOPS = new Set(['P_CLOUD_UPSERT', 'W_CLOUD_PATCH']);
const PUSH_TX_HOPS = new Set(['P_PUSH_TX', 'W_DIRECT_PUSH', 'W_EDGE_FALLBACK', 'C_EDGE_PUSH']);
const PEER_PHONE_RX_HOPS = new Set(['P_PUSH_RX', 'P_RT_RX', 'P_POLL_DIFF', 'P_OS_BANNER_DECISION']);
const PEER_PHONE_UI_HOPS = new Set(['P_UI_COMMIT']);
const WATCH_RX_HOPS = new Set(['W_WC_RX', 'W_APNS_RX', 'W_POLL_DIFF']);
const WATCH_COMMIT_HOPS = new Set(['W_UI_COMMIT', 'W_ALARM_SYNC', 'W_LOCAL_NOTIF', 'W_WIDGET_SAVE', 'WG_TIMELINE']);
const TAP_WAKE_HOPS = new Set(['P_USER_TAP_WAKE', 'W_USER_TAP_WAKE']);

const CAUSAL_WINDOW_MS = 120 * 1000; // 120s max window for stateRev fallback linking
const PEER_HOLD_WINDOW_MS = 15 * 1000; // 15s window for Scene S6 local peer-stop hold UI commit linking
const TAP_WAKE_CORRELATION_MS = 3500; // 3.5s window after USER_TAP_WAKE

function parseJsonlFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  const headers = [];
  const entries = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const jsonPart = trimmed.replace(/^#+\s*/, '');
      try {
        const parsedHeader = JSON.parse(jsonPart);
        headers.push({ file: path.basename(filePath), ...parsedHeader });
      } catch {
        // ignore non-JSON comment lines
      }
      continue;
    }
    const firstBrace = trimmed.indexOf('{');
    if (firstBrace < 0) continue;
    try {
      const obj = JSON.parse(trimmed.slice(firstBrace));
      if (obj && typeof obj === 'object' && obj.hop) {
        const adjMs = Number.isFinite(Number(obj.adjMs))
          ? Number(obj.adjMs)
          : Number(obj.wallMs || 0);
        entries.push({
          ...obj,
          _sourceFile: path.basename(filePath),
          adjMs,
          wallMs: Number(obj.wallMs || adjMs),
        });
      }
    } catch {
      // ignore malformed line
    }
  }
  return { file: path.basename(filePath), headers, entries };
}

function parseRevsIntoSet(rawVal, outSet) {
  if (typeof rawVal !== 'string' || !rawVal) return;
  const parts = rawVal.split(',');
  for (const part of parts) {
    const colonIdx = part.lastIndexOf(':');
    const token = (colonIdx >= 0 ? part.slice(colonIdx + 1) : part).trim();
    if (/^[0-9a-f]{8}$/i.test(token)) {
      outSet.add(token.toLowerCase());
    }
  }
}

function parseSeatKeyedRevPairs(rawVal) {
  const pairs = [];
  if (typeof rawVal !== 'string' || !rawVal) return pairs;
  const parts = rawVal.split(',');
  for (const part of parts) {
    const colonIdx = part.lastIndexOf(':');
    if (colonIdx > 0) {
      const seatKey = part.slice(0, colonIdx).trim().toLowerCase();
      const rev = part.slice(colonIdx + 1).trim().toLowerCase();
      if (seatKey && /^[0-9a-f]{8}$/.test(rev)) {
        pairs.push({ seatKey, rev });
      }
    } else {
      const rev = part.trim().toLowerCase();
      if (/^[0-9a-f]{8}$/.test(rev)) {
        pairs.push({ seatKey: '', rev });
      }
    }
  }
  return pairs;
}

function extractSeatKeyFromSeatRef(seatField) {
  if (typeof seatField !== 'string' || !seatField) return '';
  const hashIdx = seatField.indexOf('#');
  return (hashIdx >= 0 ? seatField.slice(0, hashIdx) : seatField).trim().toLowerCase();
}

function extractDirectStateRevs(entry) {
  const revs = new Set();
  if (entry && typeof entry.stateRev === 'string') {
    parseRevsIntoSet(entry.stateRev, revs);
  }
  if (entry && entry.meta && typeof entry.meta === 'object') {
    parseRevsIntoSet(entry.meta.compositeRev, revs);
  }
  return Array.from(revs);
}

function extractCloudMetaRevs(entry) {
  const revs = new Set();
  if (entry && entry.meta && typeof entry.meta === 'object') {
    for (const k of ['cloudRev', 'cloudCompositeRev', 'pickedCloudRev']) {
      parseRevsIntoSet(entry.meta[k], revs);
    }
  }
  return Array.from(revs);
}

function extractIndividualRevs(entry) {
  const revs = new Set();
  if (!entry || typeof entry !== 'object') return [];
  parseRevsIntoSet(entry.stateRev, revs);
  if (entry.meta && typeof entry.meta === 'object') {
    for (const k of [
      'stateRev',
      'nextRev',
      'cloudRev',
      'compositeRev',
      'cloudCompositeRev',
      'pickedCloudRev',
    ]) {
      parseRevsIntoSet(entry.meta[k], revs);
    }
  }
  return Array.from(revs);
}

function isFallbackLocalDevId(dev) {
  const s = String(dev || '').trim();
  return !s || s === 'unknown' || s === 'wg' || s.startsWith('d#') || s.startsWith('w#');
}

function unifyFileDeviceIds(parsedFiles) {
  return parsedFiles.map((f, fileIdx) => {
    const headerStaffDev = (f.headers || [])
      .map((h) => String(h.dev || '').trim())
      .find((d) => d.startsWith('u#'));
    const entryStaffDevs = Array.from(
      new Set(
        (f.entries || [])
          .map((e) => String(e.dev || '').trim())
          .filter((d) => d.startsWith('u#'))
      )
    );
    const canonicalDev =
      headerStaffDev ||
      (entryStaffDevs.length === 1 ? entryStaffDevs[0] : '') ||
      (parsedFiles.length === 1 && entryStaffDevs.length === 0 ? `f#${fileIdx + 1}` : '');

    const normalizedEntries = (f.entries || []).map((e) => {
      const rawDev = String(e.dev || '').trim();
      const unifiedDev =
        canonicalDev && isFallbackLocalDevId(rawDev)
          ? canonicalDev
          : rawDev || canonicalDev || 'unknown';
      return {
        ...e,
        dev: unifiedDev,
      };
    });
    return {
      ...f,
      entries: normalizedEntries,
    };
  });
}

function computeStats(nums) {
  if (!nums || nums.length === 0) return { count: 0, median: null, p95: null, max: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    count: sorted.length,
    median: Math.round(median),
    p95: Math.round(sorted[p95Idx]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

function fmtPct(num, den) {
  if (!den) return '-';
  return `${Math.round((num / den) * 100)}% (${num}/${den})`;
}

function fmtLatency(stat) {
  if (!stat || stat.count === 0) return '-';
  return `p50=${stat.median}ms / max=${stat.max}ms`;
}

function analyzeLogs(rawParsedFiles) {
  const parsedFiles = unifyFileDeviceIds(rawParsedFiles);
  const allHeaders = parsedFiles.flatMap((f) => f.headers || []);
  const allEntries = parsedFiles
    .flatMap((f) => f.entries || [])
    .sort((a, b) => {
      if (a.adjMs !== b.adjMs) return a.adjMs - b.adjMs;
      if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
      return (a.seq || 0) - (b.seq || 0);
    });

  const uniqueDevs = Array.from(new Set(allEntries.map((e) => e.dev || 'unknown')));
  const uniqueStaffDevs = uniqueDevs.filter((d) => String(d).startsWith('u#'));
  const multiDeviceMode = parsedFiles.length >= 2 || uniqueStaffDevs.length >= 2;

  // 1. Group origin events by traceId
  const tracesById = new Map();
  for (const e of allEntries) {
    if (ORIGIN_HOPS.has(e.hop)) {
      const tid = e.traceId || `anon_${e.dev}_${e.adjMs}_${e.seq}`;
      if (!tracesById.has(tid)) {
        tracesById.set(tid, {
          traceId: tid,
          origin: e,
          originDev: e.dev || 'unknown',
          originLayer: e.layer || 'unknown',
          originHop: e.hop,
          scene: e.scene || 'S1',
          act: e.act || '',
          seat: e.seat || '',
          t0: e.adjMs,
          stateRevs: new Set(extractIndividualRevs(e)),
          events: [e],
        });
      } else {
        const tr = tracesById.get(tid);
        extractIndividualRevs(e).forEach((r) => tr.stateRevs.add(r));
        tr.events.push(e);
      }
    }
  }

  const linkedEvents = new Set();

  // Pass 1: attach all events with matching explicit traceId & harvest newly computed stateRevs
  for (const e of allEntries) {
    if (ORIGIN_HOPS.has(e.hop)) {
      linkedEvents.add(e);
      continue;
    }
    if (e.traceId && tracesById.has(e.traceId)) {
      const tr = tracesById.get(e.traceId);
      tr.events.push(e);
      linkedEvents.add(e);
      extractIndividualRevs(e).forEach((r) => tr.stateRevs.add(r));
    }
  }

  // Build stateRev -> candidate trace list index for traceId-less hops (Realtime, Polling, UI Commit, Widget)
  const revIndex = new Map();
  for (const tr of tracesById.values()) {
    for (const rev of tr.stateRevs) {
      if (!revIndex.has(rev)) revIndex.set(rev, []);
      revIndex.get(rev).push(tr);
    }
  }

  // Scene S6 helper: record local-hold running stateRev observed when a peer device keeps its local timer running
  // (`P_RT_RX` keepLocalRun, `P_POLL_DIFF` / `W_POLL_DIFF` local_peer_stop_hold)
  const peerHoldLinks = [];

  // Pass 2a: link non-commit hops (receive/reconcile/push hops) lacking explicit traceId via cloudRev / peerHoldLinks / stateRev
  for (const e of allEntries) {
    if (linkedEvents.has(e)) continue;
    if (PEER_PHONE_UI_HOPS.has(e.hop) || WATCH_COMMIT_HOPS.has(e.hop)) continue;
    const revs = extractIndividualRevs(e);
    if (revs.length === 0) continue;

    let bestTrace = null;
    let bestDelta = Infinity;
    const cloudMetaRevs = extractCloudMetaRevs(e);

    // 1) Explicit cloudRev metadata (e.g. Scene S6 P_RT_RX / W_WC_RX / W_POLL_DIFF) takes highest priority
    if (cloudMetaRevs.length > 0) {
      for (const r of cloudMetaRevs) {
        const candidates = revIndex.get(r);
        if (!candidates) continue;
        for (const tr of candidates) {
          const dt = e.adjMs - tr.t0;
          if (dt >= -2000 && dt <= CAUSAL_WINDOW_MS && Math.abs(dt) < bestDelta) {
            bestDelta = Math.abs(dt);
            bestTrace = tr;
          }
        }
      }
    }

    // 2) Active Scene S6 local-hold on the same staff device (prevents an older START_TIMER rev from stealing W_WC_RX)
    let activeHoldForEvent = null;
    if (!bestTrace && WATCH_RX_HOPS.has(e.hop)) {
      let bestHoldDelta = Infinity;
      for (const r of revs) {
        for (const h of peerHoldLinks) {
          if (h.dev !== e.dev || h.holdRev !== r) continue;
          const dtHold = e.adjMs - h.rxAdjMs;
          if (dtHold >= -50 && dtHold <= PEER_HOLD_WINDOW_MS && Math.abs(dtHold) < bestHoldDelta) {
            bestHoldDelta = Math.abs(dtHold);
            activeHoldForEvent = h;
          }
        }
      }
      if (activeHoldForEvent) {
        bestTrace = activeHoldForEvent.trace;
        bestDelta = bestHoldDelta;
      }
    }

    // 3) Standard stateRev lookup (if activeHoldForEvent matched, only override if a NEWER trace started after the hold trace)
    if (!bestTrace || activeHoldForEvent) {
      for (const r of revs) {
        const candidates = revIndex.get(r);
        if (!candidates) continue;
        for (const tr of candidates) {
          if (activeHoldForEvent && tr.t0 <= activeHoldForEvent.trace.t0) continue;
          const dt = e.adjMs - tr.t0;
          if (dt >= -2000 && dt <= CAUSAL_WINDOW_MS && Math.abs(dt) < bestDelta) {
            bestDelta = Math.abs(dt);
            bestTrace = tr;
          }
        }
      }
    }

    if (bestTrace) {
      bestTrace.events.push(e);
      linkedEvents.add(e);

      const isPeerStopHoldEvent =
        e.rsn === 'local_peer_stop_hold' ||
        Boolean(e.meta && e.meta.keepLocalRun) ||
        Boolean(e.meta && Number(e.meta.peerKeep) > 0) ||
        Boolean(e.meta && e.meta.peerRevChg) ||
        Boolean(e.meta && e.meta.freshNotif && e.rsn === 'applied_same_rev') ||
        Boolean(e.meta && e.meta.cloudRev && e.stateRev && e.meta.cloudRev !== e.stateRev);
      if (isPeerStopHoldEvent && (PEER_PHONE_RX_HOPS.has(e.hop) || WATCH_RX_HOPS.has(e.hop))) {
        const targetHoldSeats = new Set();
        const explicitSeatKey = extractSeatKeyFromSeatRef(e.seat);
        if (explicitSeatKey) targetHoldSeats.add(explicitSeatKey);
        if (e.meta && typeof e.meta.cloudRev === 'string') {
          for (const p of parseSeatKeyedRevPairs(e.meta.cloudRev)) {
            if (p.seatKey) targetHoldSeats.add(p.seatKey);
          }
        }
        let localHoldRevs = [];
        if (targetHoldSeats.size > 0) {
          const statePairs = [
            ...parseSeatKeyedRevPairs(e.stateRev),
            ...(e.meta && typeof e.meta.compositeRev === 'string'
              ? parseSeatKeyedRevPairs(e.meta.compositeRev)
              : []),
          ];
          const matched = new Set();
          for (const p of statePairs) {
            if (!p.seatKey || targetHoldSeats.has(p.seatKey)) {
              matched.add(p.rev);
            }
          }
          localHoldRevs = Array.from(matched);
        }
        if (localHoldRevs.length === 0) {
          localHoldRevs = extractDirectStateRevs(e);
        }
        for (const holdRev of localHoldRevs) {
          peerHoldLinks.push({
            dev: e.dev,
            seatKey: targetHoldSeats.size === 1 ? Array.from(targetHoldSeats)[0] : '',
            holdRev,
            rxAdjMs: e.adjMs,
            trace: bestTrace,
          });
        }
      }
    }
  }

  // Pass 2b: link UI / Watch / Alarm / Widget commit hops (which may carry multi-seat compositeRev or Scene S6 local-hold rev)
  for (const e of allEntries) {
    if (linkedEvents.has(e)) continue;
    if (!PEER_PHONE_UI_HOPS.has(e.hop) && !WATCH_COMMIT_HOPS.has(e.hop)) continue;
    const revs = extractIndividualRevs(e);
    if (revs.length === 0) continue;

    const matchedTraces = new Set();
    const cloudMetaRevs = extractCloudMetaRevs(e);
    const cloudResolvedSeatKeys = new Set();

    // 1) Explicit cloudRev metadata on commit hops (e.g. P_UI_COMMIT peerStopCloudRev, W_UI_COMMIT peer_alert_banner_commit)
    const cloudPairs =
      e.meta && typeof e.meta.cloudRev === 'string'
        ? parseSeatKeyedRevPairs(e.meta.cloudRev)
        : cloudMetaRevs.map((rev) => ({ seatKey: '', rev }));
    for (const { seatKey: cSeatKey, rev: cr } of cloudPairs.length > 0
      ? cloudPairs
      : cloudMetaRevs.map((rev) => ({ seatKey: '', rev }))) {
      let bestCloudTr = null;
      let bestCloudDelta = Infinity;
      const candidates = revIndex.get(cr);
      if (candidates) {
        for (const tr of candidates) {
          const dt = e.adjMs - tr.t0;
          if (dt >= -2000 && dt <= CAUSAL_WINDOW_MS && Math.abs(dt) < bestCloudDelta) {
            bestCloudDelta = Math.abs(dt);
            bestCloudTr = tr;
          }
        }
      }
      if (bestCloudTr) {
        matchedTraces.add(bestCloudTr);
        if (cSeatKey) {
          cloudResolvedSeatKeys.add(cSeatKey);
        }
      }
    }

    // If this is a per-alert banner commit and its explicit cloudRev already linked to the exact trace, skip compositeRev fan-out
    const skipDirectCompositeFanout =
      e.act === 'peer_alert_banner_commit' && cloudMetaRevs.length > 0 && matchedTraces.size > 0;

    if (!skipDirectCompositeFanout) {
      let revsToCheck = [];
      if (e.hop === 'P_UI_COMMIT' && typeof e.stateRev === 'string' && e.stateRev.trim()) {
        // P_UI_COMMIT puts ONLY changed seats into e.stateRev (meta.compositeRev contains unchanged seats too)
        const changedPairs = parseSeatKeyedRevPairs(e.stateRev);
        revsToCheck = changedPairs
          .filter((p) => !p.seatKey || !cloudResolvedSeatKeys.has(p.seatKey))
          .map((p) => p.rev);
      } else if (e.act === 'peer_alert_banner_commit') {
        const bannerSeatKey = extractSeatKeyFromSeatRef(e.seat);
        if (bannerSeatKey) {
          const statePairs = parseSeatKeyedRevPairs(e.stateRev);
          revsToCheck = statePairs
            .filter((p) => !p.seatKey || p.seatKey === bannerSeatKey)
            .map((p) => p.rev);
        } else {
          const directRevs = extractDirectStateRevs(e);
          revsToCheck = directRevs.length > 0 ? directRevs : revs;
        }
      } else {
        const directRevs = extractDirectStateRevs(e);
        revsToCheck = directRevs.length > 0 ? directRevs : revs;
      }
      for (const r of revsToCheck) {
        let matchedHold = null;
        let bestHoldDelta = Infinity;
        for (const h of peerHoldLinks) {
          if (h.dev !== e.dev || h.holdRev !== r) continue;
          const dtHold = e.adjMs - h.rxAdjMs;
          if (dtHold >= -50 && dtHold <= PEER_HOLD_WINDOW_MS && Math.abs(dtHold) < bestHoldDelta) {
            bestHoldDelta = Math.abs(dtHold);
            matchedHold = h;
          }
        }

        let bestForRev = matchedHold ? matchedHold.trace : null;
        let bestDeltaForRev = matchedHold ? bestHoldDelta : Infinity;
        const candidates = revIndex.get(r);
        if (candidates) {
          for (const tr of candidates) {
            if (matchedHold && tr.t0 <= matchedHold.trace.t0) continue;
            const dt = e.adjMs - tr.t0;
            if (dt >= -2000 && dt <= CAUSAL_WINDOW_MS && Math.abs(dt) < bestDeltaForRev) {
              bestDeltaForRev = Math.abs(dt);
              bestForRev = tr;
            }
          }
        }
        if (bestForRev) {
          matchedTraces.add(bestForRev);
        }
      }
    }
    if (matchedTraces.size > 0) {
      for (const tr of matchedTraces) {
        tr.events.push(e);
      }
      linkedEvents.add(e);
    }
  }

  // 2. Evaluate stage completion & latencies per trace
  const traces = Array.from(tracesById.values());
  const evaluatedTraces = traces.map((tr) => {
    const isWatchOrigin = tr.originHop === 'W_ORIGIN_ACT';
    const isMainTimerOnly = tr.originHop === 'P_MAIN_ORIGIN' || tr.seat === 'main-timer';

    const firstDelta = (predicate) => {
      let best = null;
      for (const ev of tr.events) {
        if (!predicate(ev)) continue;
        const d = Math.max(0, ev.adjMs - tr.t0);
        if (best === null || d < best) best = d;
      }
      return best;
    };

    const ownPhoneWcMs = isWatchOrigin
      ? firstDelta((ev) => ev.dev === tr.originDev && OWN_PHONE_WC_HOPS.has(ev.hop) && ev.res === 'ok')
      : null;

    const cloudWriteMs = !isMainTimerOnly
      ? firstDelta((ev) => CLOUD_WRITE_HOPS.has(ev.hop) && ev.res === 'ok')
      : null;

    const pushTxMs = !isMainTimerOnly
      ? firstDelta((ev) => PUSH_TX_HOPS.has(ev.hop) && ev.res === 'ok')
      : null;

    const peerPhoneRxMs = !isMainTimerOnly && multiDeviceMode
      ? firstDelta((ev) => ev.dev !== tr.originDev && PEER_PHONE_RX_HOPS.has(ev.hop) && ev.res === 'ok')
      : null;

    const peerPhoneRxChannel = (() => {
      if (isMainTimerOnly || !multiDeviceMode) return null;
      let earliest = null;
      for (const ev of tr.events) {
        if (ev.dev !== tr.originDev && PEER_PHONE_RX_HOPS.has(ev.hop) && ev.res === 'ok') {
          if (!earliest || ev.adjMs < earliest.adjMs) earliest = ev;
        }
      }
      return earliest ? earliest.hop : null;
    })();

    const peerPhoneUiMs = !isMainTimerOnly && multiDeviceMode
      ? firstDelta((ev) => ev.dev !== tr.originDev && PEER_PHONE_UI_HOPS.has(ev.hop) && ev.res === 'ok')
      : null;

    const targetWatchRxMs = firstDelta((ev) => {
      if (!WATCH_RX_HOPS.has(ev.hop) || ev.res !== 'ok') return false;
      return multiDeviceMode ? ev.dev !== tr.originDev : !isWatchOrigin;
    });

    const targetWatchCommitMs = firstDelta((ev) => {
      if (!WATCH_COMMIT_HOPS.has(ev.hop) || ev.res !== 'ok') return false;
      return multiDeviceMode ? ev.dev !== tr.originDev : !isWatchOrigin;
    });

    const drops = tr.events
      .filter((ev) => ev.res === 'drop' || ev.res === 'skip' || ev.res === 'err' || ev.hop === 'N_BG_TASK_EXPIRE')
      .map((ev) => `${ev.hop}:${ev.res}:${ev.rsn || 'unspecified'}`);

    return {
      ...tr,
      isWatchOrigin,
      isMainTimerOnly,
      ownPhoneWcMs,
      cloudWriteMs,
      pushTxMs,
      peerPhoneRxMs,
      peerPhoneRxChannel,
      peerPhoneUiMs,
      targetWatchRxMs,
      targetWatchCommitMs,
      drops,
    };
  });

  // 3. Drop / Skip / Error ranking + Realtime channel state + BG task expiration
  const dropCounts = new Map();
  const rtChannelIssues = [];
  let bgTaskExpireCount = 0;

  for (const e of allEntries) {
    if (e.hop === 'N_BG_TASK_EXPIRE') {
      bgTaskExpireCount += 1;
    }
    if (e.hop === 'P_RT_CH_STATE' && e.act !== 'SUBSCRIBED') {
      rtChannelIssues.push(e);
    }
    if (e.res === 'drop' || e.res === 'skip' || e.res === 'err' || e.hop === 'N_BG_TASK_EXPIRE') {
      const key = `${e.layer}|${e.hop}|${e.res}|${e.rsn || e.act || 'unspecified'}`;
      dropCounts.set(key, (dropCounts.get(key) || 0) + 1);
    }
  }

  const rankedDrops = Array.from(dropCounts.entries())
    .map(([key, count]) => {
      const [layer, hop, res, rsn] = key.split('|');
      return { layer, hop, res, rsn, count };
    })
    .sort((a, b) => b.count - a.count);

  // 4. Detect "Reflected ONLY right after screen tap (USER_TAP_WAKE)"
  const tapWakeEventsByDevLayer = new Map();
  for (const e of allEntries) {
    if (TAP_WAKE_HOPS.has(e.hop)) {
      const k = `${e.dev}|${e.layer}`;
      if (!tapWakeEventsByDevLayer.has(k)) tapWakeEventsByDevLayer.set(k, []);
      tapWakeEventsByDevLayer.get(k).push(e);
    }
  }

  const tapTriggeredCommits = [];
  for (const e of allEntries) {
    if (e.hop !== 'P_UI_COMMIT' && e.hop !== 'W_UI_COMMIT' && e.hop !== 'P_POLL_DIFF' && e.hop !== 'W_POLL_DIFF') {
      continue;
    }
    if (e.res !== 'ok') continue;
    const k = `${e.dev}|${e.layer}`;
    const taps = tapWakeEventsByDevLayer.get(k) || [];
    const recentTap = taps.find((t) => e.adjMs >= t.adjMs && e.adjMs - t.adjMs <= TAP_WAKE_CORRELATION_MS);
    if (recentTap) {
      tapTriggeredCommits.push({
        scene: e.scene || 'S1',
        dev: e.dev,
        layer: e.layer,
        commitHop: e.hop,
        tapAct: recentTap.act,
        delayAfterTapMs: e.adjMs - recentTap.adjMs,
        stateRev: e.stateRev || '',
      });
    }
  }

  return {
    allHeaders,
    totalEntries: allEntries.length,
    uniqueDevs,
    uniqueStaffDevs,
    multiDeviceMode,
    evaluatedTraces,
    rankedDrops,
    rtChannelIssues,
    bgTaskExpireCount,
    tapTriggeredCommits,
  };
}

function summarizeTraceGroup(traces, multiDeviceMode) {
  const salonTraces = traces.filter((t) => !t.isMainTimerOnly);
  const watchOriginTraces = traces.filter((t) => t.isWatchOrigin);

  const ownWcArr = watchOriginTraces.map((t) => t.ownPhoneWcMs).filter((v) => v !== null);
  const cloudArr = salonTraces.map((t) => t.cloudWriteMs).filter((v) => v !== null);
  const pushArr = salonTraces.map((t) => t.pushTxMs).filter((v) => v !== null);
  const peerRxArr = salonTraces.map((t) => t.peerPhoneRxMs).filter((v) => v !== null);
  const peerUiArr = salonTraces.map((t) => t.peerPhoneUiMs).filter((v) => v !== null);
  const watchTargetPool = multiDeviceMode ? salonTraces : traces.filter((t) => !t.isWatchOrigin);
  const watchRxArr = watchTargetPool.map((t) => t.targetWatchRxMs).filter((v) => v !== null);
  const watchCommitArr = watchTargetPool.map((t) => t.targetWatchCommitMs).filter((v) => v !== null);

  return {
    totalOrigins: traces.length,
    watchOrigins: watchOriginTraces.length,
    salonOrigins: salonTraces.length,
    watchTargetDenom: watchTargetPool.length,
    ownWc: computeStats(ownWcArr),
    cloud: computeStats(cloudArr),
    push: computeStats(pushArr),
    peerRx: computeStats(peerRxArr),
    peerUi: computeStats(peerUiArr),
    watchRx: computeStats(watchRxArr),
    watchCommit: computeStats(watchCommitArr),
  };
}

function renderMarkdownReport(analysis, inputFiles) {
  const out = [];
  out.push('## 🔍 Issue #13 共有タイマー同期経路 トレース診断レポート');
  out.push('');
  out.push(`- **解析ファイル**: ${inputFiles.map((f) => `\`${path.basename(f)}\``).join(', ')}`);
  out.push(`- **総ログ行数**: ${analysis.totalEntries} 件 / **検出端末数**: ${analysis.uniqueDevs.length} 台 (${analysis.uniqueDevs.map((d) => `\`${d}\``).join(', ') || 'none'}) / **モード**: ${analysis.multiDeviceMode ? '複数スタッフ間JOIN' : '単一スタッフ内トレース'}`);
  out.push(`- **検出操作起点 (Origin)**: ${analysis.evaluatedTraces.length} 回 / **iOS BGタスク時間切れ (` + '`N_BG_TASK_EXPIRE`' + `)**: ${analysis.bgTaskExpireCount} 回 / **Realtime切断・異常 (` + '`P_RT_CH_STATE`' + `)**: ${analysis.rtChannelIssues.length} 回`);
  out.push(`- **画面タップ (` + '`USER_TAP_WAKE`' + `) 直後3.5秒以内に初めて反映された更新**: **${analysis.tapTriggeredCommits.length} 件**`);
  out.push('');

  if (analysis.allHeaders.length > 0) {
    out.push('### 1. 端末メタデータ & 文字盤優先枠 (Complication Quota)');
    out.push('| ファイル | 端末ID | 役割 | 時計補正 (`serverOffsetMs`) | Watch回収結果 | 文字盤優先有効 | 文字盤残枠 (`remaining`) |');
    out.push('| :--- | :--- | :---: | :---: | :--- | :---: | :---: |');
    for (const h of analysis.allHeaders) {
      out.push(
        `| \`${h.file}\` | \`${h.dev || '-'}\` | ${h.role || '-'} | ${h.serverOffsetMs ?? 0}ms | \`${h.watchPullResult || '-'}\` | ${h.complicationEnabled ?? '-'} | ${h.remainingComplicationTransfers ?? '-'} |`
      );
    }
    out.push('');
  }

  // Group by Scene
  const scenes = Array.from(new Set(['ALL', ...analysis.evaluatedTraces.map((t) => t.scene).sort()]));
  out.push('### 2. シーン別・各段到達率 ＆ 遅延 (`adjMs` 基準 p50 / max)');
  out.push('| Scene | 起点数 | ①Watch➔自iPhone WC | ②Cloud書込 (`UPSERT`/`PATCH`) | ③Push送信 (`PUSH_TX`) | ④相手iPhone受信 (Push/RT/Poll) | ⑤相手iPhone描画 (`UI_COMMIT`) | ⑥Watch受信 (`WC`/`APNs`/`Poll`) | ⑦Watch描画/Alarm/Widget |');
  out.push('| :---: | :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const sc of scenes) {
    const group =
      sc === 'ALL'
        ? analysis.evaluatedTraces
        : analysis.evaluatedTraces.filter((t) => t.scene === sc);
    if (group.length === 0 && sc !== 'ALL') continue;
    const s = summarizeTraceGroup(group, analysis.multiDeviceMode);
    out.push(
      `| **${sc}** | ${s.totalOrigins} | ${fmtPct(s.ownWc.count, s.watchOrigins)}<br>${fmtLatency(s.ownWc)} | ${fmtPct(s.cloud.count, s.salonOrigins)}<br>${fmtLatency(s.cloud)} | ${fmtPct(s.push.count, s.salonOrigins)}<br>${fmtLatency(s.push)} | ${analysis.multiDeviceMode ? `${fmtPct(s.peerRx.count, s.salonOrigins)}<br>${fmtLatency(s.peerRx)}` : '*(1台ログ)*'} | ${analysis.multiDeviceMode ? `${fmtPct(s.peerUi.count, s.salonOrigins)}<br>${fmtLatency(s.peerUi)}` : '*(1台ログ)*'} | ${fmtPct(s.watchRx.count, s.watchTargetDenom)}<br>${fmtLatency(s.watchRx)} | ${fmtPct(s.watchCommit.count, s.watchTargetDenom)}<br>${fmtLatency(s.watchCommit)} |`
    );
  }
  out.push('');

  out.push('### 3. 個別トレース追跡一覧 (`traceId` + `stateRev` JOIN)');
  if (analysis.evaluatedTraces.length === 0) {
    out.push('_操作起点 (`W_ORIGIN_ACT` / `P_ORIGIN_ACT`) が記録されていません。_');
  } else {
    out.push('| Scene | `traceId` | 起点 (`dev` / `hop` / `act`) | 席 | `stateRev` | 自iPhone WC | Cloud書込 | Push送信 | 相手iPhone受信 | 相手iPhone描画 | Watch受信 | Watch反映 | 検出 Drop/Skip |');
    out.push('| :---: | :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');
    for (const tr of analysis.evaluatedTraces) {
      const revs = Array.from(tr.stateRevs).slice(0, 2).join(',') || '-';
      const fmtMs = (v) => (v === null || v === undefined ? '❌' : `${v}ms`);
      const peerRxCell = !analysis.multiDeviceMode || tr.isMainTimerOnly
        ? '-'
        : tr.peerPhoneRxMs !== null
          ? `${tr.peerPhoneRxMs}ms (${tr.peerPhoneRxChannel.replace('P_', '')})`
          : '❌';
      const peerUiCell = !analysis.multiDeviceMode || tr.isMainTimerOnly ? '-' : fmtMs(tr.peerPhoneUiMs);
      const ownWcCell = tr.isWatchOrigin ? fmtMs(tr.ownPhoneWcMs) : '-';
      const cloudCell = tr.isMainTimerOnly ? '-' : fmtMs(tr.cloudWriteMs);
      const pushCell = tr.isMainTimerOnly ? '-' : fmtMs(tr.pushTxMs);
      const dropStr = tr.drops.length > 0 ? tr.drops.slice(0, 3).map((d) => `\`${d}\``).join(', ') : '-';
      out.push(
        `| ${tr.scene} | \`${tr.traceId}\` | \`${tr.originDev}\` ${tr.originHop} \`${tr.act}\` | \`${tr.seat || '-'}\` | \`${revs}\` | ${ownWcCell} | ${cloudCell} | ${pushCell} | ${peerRxCell} | ${peerUiCell} | ${fmtMs(tr.targetWatchRxMs)} | ${fmtMs(tr.targetWatchCommitMs)} | ${dropStr} |`
      );
    }
  }
  out.push('');

  out.push('### 4. Drop / Skip / Error 理由ランキング (上位15件)');
  if (analysis.rankedDrops.length === 0) {
    out.push('- ドロップ・スキップ・エラーは検出されませんでした。');
  } else {
    out.push('| 順位 | 件数 | レイヤー (`layer`) | Hop | 結果 (`res`) | 理由 (`rsn`) |');
    out.push('| :---: | :---: | :--- | :--- | :---: | :--- |');
    analysis.rankedDrops.slice(0, 15).forEach((d, idx) => {
      out.push(`| ${idx + 1} | **${d.count}** | \`${d.layer}\` | \`${d.hop}\` | \`${d.res}\` | \`${d.rsn}\` |`);
    });
  }
  out.push('');

  out.push('### 5. 画面タップ (`USER_TAP_WAKE`) 直後に初めて反映された遅延コミット一覧');
  if (analysis.tapTriggeredCommits.length === 0) {
    out.push('- 画面タップ直後に遅延反映されたコミットは検出されませんでした。');
  } else {
    out.push('| Scene | 端末ID | レイヤー | タップ操作 (`act`) | 反映 Hop | タップからの経過 | `stateRev` |');
    out.push('| :---: | :--- | :--- | :--- | :--- | :---: | :--- |');
    for (const c of analysis.tapTriggeredCommits.slice(0, 20)) {
      out.push(
        `| ${c.scene} | \`${c.dev}\` | \`${c.layer}\` | \`${c.tapAct}\` | \`${c.commitHop}\` | +${c.delayAfterTapMs}ms | \`${c.stateRev || '-'}\` |`
      );
    }
  }
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Built-in Self-Test Suite (verifies multi-seat composite stateRev, 00:00 stop,
// Scene S6 peer-stop local hold, and single-staff multiDeviceMode === false)
// ---------------------------------------------------------------------------
function fnv1a32Hex(input) {
  const bytes = Buffer.from(String(input ?? ''), 'utf8');
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function maskStaffForSelfTest(raw) {
  const norm = String(raw ?? '').normalize('NFKC').replace(/[\s\u3000\ufeff]+/g, '').toLowerCase();
  if (!norm) return 'empty';
  if (norm === '未定') return 'unset';
  if (norm === 'ヘルプなし' || norm === 'none') return 'none';
  if (norm === '募集中') return 'recruit';
  if (norm === 'スタイリスト' || norm === 'スタッフ') return 'default_stylist';
  return `stf#${fnv1a32Hex(norm).slice(0, 4)}`;
}

function computeRevForSelfTest({
  seatKey,
  isRunning = false,
  endMs = 0,
  pausedSec = 0,
  hasActiveCheck = false,
  chkEndMs = 0,
  isPostStopProcessActive = false,
  assistToken = '',
  checkToken = '',
}) {
  const runFlag = isRunning && endMs > 0 ? 1 : 0;
  const effPaused = runFlag === 0 ? Math.max(0, Math.round(pausedSec || 0)) : 0;
  const shampooFlag = runFlag === 0 && effPaused <= 0 && isPostStopProcessActive ? 1 : 0;
  const endBkt = runFlag
    ? Math.round(endMs / 5000)
    : shampooFlag === 0 && effPaused > 0
      ? effPaused
      : 0;
  const chkFlag = runFlag === 1 && hasActiveCheck && chkEndMs > 0 ? 1 : 0;
  const chkBkt = chkFlag ? Math.round(chkEndMs / 5000) : 0;
  const keepAssist = runFlag === 1 || shampooFlag === 1 || effPaused > 0;
  const assistMasked = keepAssist ? maskStaffForSelfTest(assistToken) : 'empty';
  const checkMasked = chkFlag === 1 ? maskStaffForSelfTest(checkToken) : 'empty';
  return fnv1a32Hex(`${seatKey}|${runFlag}|${endBkt}|${chkFlag}|${chkBkt}|${shampooFlag}|${assistMasked}|${checkMasked}`);
}

function runSelfTest() {
  // 1) Multi-seat (3 seats) composite stateRev JOIN (without secondary FNV-1a!)
  const s1IdleRev = computeRevForSelfTest({ seatKey: 's1' });
  const s2RunRev = computeRevForSelfTest({
    seatKey: 's2',
    isRunning: true,
    endMs: 1763002500000,
    assistToken: '佐藤',
  });
  const s3RunRev = computeRevForSelfTest({
    seatKey: 's3',
    isRunning: true,
    endMs: 1763002200000,
    assistToken: 'ヘルプなし',
  });
  const compositeMultiSeat = `s1:${s1IdleRev},s2:${s2RunRev},s3:${s3RunRev}`;

  // 2) Assistant-assigned seat stopped at 00:00 (State 8: leftover assistant on DB must still yield 'empty')
  const s2StoppedNormalFromSeat = computeRevForSelfTest({
    seatKey: 's2',
    isRunning: false,
    pausedSec: 0,
    isPostStopProcessActive: false,
    assistToken: '',
  });
  const s2StoppedNormalFromCloudRow = computeRevForSelfTest({
    seatKey: 's2',
    isRunning: false,
    pausedSec: 0,
    isPostStopProcessActive: false,
    assistToken: '佐藤', // stale DB assistant_staff_name on 00:00 stop
  });
  assert.strictEqual(
    s2StoppedNormalFromSeat,
    s2StoppedNormalFromCloudRow,
    '00:00 stopped seat rev must match cloud row rev even with leftover assistant_staff_name'
  );
  const compositeAfterStop = `s1:${s1IdleRev},s2:${s2StoppedNormalFromSeat},s3:${s3RunRev}`;

  // 2b) Assistant-unassigned paused seat (300s vs 180s) must NOT collide with 00:00 reset seat
  const s1UnassignedPaused300Rev = computeRevForSelfTest({
    seatKey: 's1',
    isRunning: false,
    pausedSec: 300,
    assistToken: '',
  });
  const s1UnassignedPaused180Rev = computeRevForSelfTest({
    seatKey: 's1',
    isRunning: false,
    pausedSec: 180,
    assistToken: '',
  });
  assert.notStrictEqual(
    s1UnassignedPaused300Rev,
    s1IdleRev,
    'Assistant-unassigned paused (300s) seat must have distinct stateRev from 00:00 reset seat'
  );
  assert.notStrictEqual(
    s1UnassignedPaused300Rev,
    s1UnassignedPaused180Rev,
    'Assistant-unassigned paused seats with different remaining seconds must have distinct stateRevs'
  );

  // 2c) Planned help process (`combing` / `shampoo` with DB `is_shampooing: true`) + mid-countdown pause (`pausedRemainingSeconds > 0`)
  //     Execute actual production `computeSeatStateRev` & `computeCloudRowStateRev` from `src/utils/syncTraceLogger.js`!
  const vm = require('vm');
  const loggerPath = path.resolve(__dirname, '../src/utils/syncTraceLogger.js');
  const rawLoggerSrc = fs.readFileSync(loggerPath, 'utf8');
  const cjsLoggerSrc =
    [
      "const AppState = { currentState: 'active' };",
      'const Share = { share: async () => {} };',
      'const AsyncStorage = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };',
      "const SUPABASE_URL = 'https://example.supabase.co';",
      "const SUPABASE_ANON_KEY = 'anon';",
    ].join('\n') +
    '\n' +
    rawLoggerSrc
      .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
      .replace(/export\s+const\s+(\w+)\s*=/g, 'const $1 = exports.$1 =')
      .replace(/export\s+function\s+(\w+)/g, 'function $1')
      .replace(/export\s+default\s+/g, 'exports.default = ');
  const loggerExports = {};
  vm.runInNewContext(
    cjsLoggerSrc,
    {
      exports: loggerExports,
      module: { exports: loggerExports },
      TextEncoder,
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      RegExp,
      JSON,
      Promise,
      setTimeout,
      clearTimeout,
      fetch: async () => ({ headers: { get: () => null } }),
      console,
    },
    { filename: loggerPath }
  );

  const combingPaused300SeatRev = loggerExports.computeSeatStateRev({
    seatNumber: 1,
    seatLabel: '1番',
    status: 'paused',
    isRunning: false,
    isReset: false,
    targetEndTimestamp: 0,
    pausedRemainingSeconds: 300,
    actionStatus: 'combing',
    helpProcess: 'コーミング',
    assistantStaffName: '佐藤',
  });
  const combingPaused300CloudRev = loggerExports.computeCloudRowStateRev({
    seat_label: '1番',
    status: 'paused',
    target_end_timestamp: null,
    paused_remaining_seconds: 300,
    is_shampooing: false,
    help_process: 'コーミング',
    assistant_staff_name: '佐藤',
  });
  assert.strictEqual(
    combingPaused300SeatRev,
    combingPaused300CloudRev,
    'Paused seat (300s) with planned combing must match cloud row stateRev'
  );

  const shampooPaused300SeatRev = loggerExports.computeSeatStateRev({
    seatNumber: 1,
    seatLabel: '1番',
    status: 'paused',
    isRunning: false,
    isReset: false,
    targetEndTimestamp: 0,
    pausedRemainingSeconds: 300,
    isShampooing: false,
    actionStatus: 'shampoo',
    helpProcess: 'シャンプー',
    assistantStaffName: '佐藤',
  });
  const shampooPaused300CloudRev = loggerExports.computeCloudRowStateRev({
    seat_label: '1番',
    status: 'paused',
    target_end_timestamp: null,
    paused_remaining_seconds: 300,
    is_shampooing: true, // mapSeatToCloudTimer sets is_shampooing=true when actionStatus==='shampoo'
    help_process: 'シャンプー',
    assistant_staff_name: '佐藤',
  });
  assert.strictEqual(
    shampooPaused300SeatRev,
    shampooPaused300CloudRev,
    'Paused seat (300s) with planned shampoo (is_shampooing: true on DB) must match cloud row stateRev'
  );
  assert.strictEqual(
    combingPaused300SeatRev,
    shampooPaused300SeatRev,
    'Mid-countdown pause (pausedSec > 0) must keep shampooFlag=0 regardless of planned helpProcess'
  );

  const shampooPaused480SeatRev = loggerExports.computeSeatStateRev({
    seatNumber: 1,
    seatLabel: '1番',
    status: 'paused',
    isRunning: false,
    isReset: false,
    targetEndTimestamp: 0,
    pausedRemainingSeconds: 480,
    actionStatus: 'shampoo',
    helpProcess: 'シャンプー',
    assistantStaffName: '佐藤',
  });
  const shampooPaused480CloudRev = loggerExports.computeCloudRowStateRev({
    seat_label: '1番',
    status: 'paused',
    target_end_timestamp: null,
    paused_remaining_seconds: 480,
    is_shampooing: true,
    help_process: 'シャンプー',
    assistant_staff_name: '佐藤',
  });
  assert.strictEqual(
    shampooPaused480SeatRev,
    shampooPaused480CloudRev,
    'Adjusted paused seat (480s) with planned shampoo must match cloud row stateRev'
  );
  assert.notStrictEqual(
    shampooPaused300SeatRev,
    shampooPaused480SeatRev,
    'Adjusting paused remaining seconds (300s -> 480s) must change stateRev'
  );

  const postStopShampooSeatRev = loggerExports.computeSeatStateRev({
    seatNumber: 1,
    seatLabel: '1番',
    status: 'paused',
    isRunning: false,
    isReset: false,
    targetEndTimestamp: 0,
    pausedRemainingSeconds: 0,
    isShampooing: true,
    actionStatus: 'shampoo',
    helpProcess: 'シャンプー',
    assistantStaffName: '佐藤',
  });
  assert.notStrictEqual(
    shampooPaused300SeatRev,
    postStopShampooSeatRev,
    'Mid-countdown pause (300s) must differ from post-stop shampoo (pausedSec=0, shampooFlag=1)'
  );

  // 3) Scene S6: Peer B stops s3 while Stylist A keeps s3 locally running (`keepLocalRunningOnPeerStop`)
  const s3PeerStoppedRev = computeRevForSelfTest({
    seatKey: 's3',
    isRunning: false,
    pausedSec: 0,
    isPostStopProcessActive: false,
    assistToken: '佐藤',
  });
  const compositeStylistHold = `s1:${s1IdleRev},s2:${s2StoppedNormalFromSeat},s3:${s3RunRev}`;

  const s4RunRev = computeRevForSelfTest({
    seatKey: 's4',
    isRunning: true,
    endMs: 1763002800000,
    assistToken: '鈴木',
  });
  const s4PeerStopStage1Rev = computeRevForSelfTest({
    seatKey: 's4',
    isRunning: false,
    pausedSec: 0,
    isPostStopProcessActive: false,
    assistToken: '鈴木',
  });
  const s4PeerShampooStage2Rev = computeRevForSelfTest({
    seatKey: 's4',
    isRunning: false,
    pausedSec: 0,
    isPostStopProcessActive: true,
    assistToken: '鈴木',
  });
  const compositeStylistHoldS4 = `s1:${s1IdleRev},s2:${s2StoppedNormalFromSeat},s3:${s3RunRev},s4:${s4RunRev}`;

  const multiDeviceDataset = [
    {
      file: 'staffA_main.jsonl',
      headers: [
        {
          file: 'staffA_main.jsonl',
          dev: 'u#aaaa11',
          role: 'owner',
          serverOffsetMs: 12,
          watchPullResult: 'ok(8rows,42ms)',
          complicationEnabled: true,
          remainingComplicationTransfers: 48,
        },
      ],
      entries: [
        // Trace 1: Staff A starts s2 on Watch
        { seq: 1, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 1000, wallMs: 988, scene: 'S1', traceId: 'tr_s1_start', stateRev: s2RunRev, hop: 'W_ORIGIN_ACT', seat: 's2', act: 'START_TIMER', res: 'ok' },
        { seq: 2, dev: 'u#aaaa11', layer: 'ios_native', adjMs: 1060, wallMs: 1048, scene: 'S1', traceId: 'tr_s1_start', hop: 'N_WC_RX', seat: 's2', act: 'START_TIMER', res: 'ok' },
        { seq: 3, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 1110, wallMs: 1098, scene: 'S1', traceId: 'tr_s1_start', stateRev: s2RunRev, hop: 'P_WATCH_ACT_APPLY', seat: 's2', act: 'START_TIMER', res: 'ok' },
        { seq: 4, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 1210, wallMs: 1198, scene: 'S1', traceId: 'tr_s1_start', stateRev: s2RunRev, hop: 'W_CLOUD_PATCH', seat: 's2', act: 'START_TIMER', res: 'ok' },
        { seq: 5, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 1320, wallMs: 1308, scene: 'S1', traceId: 'tr_s1_start', stateRev: s2RunRev, hop: 'P_PUSH_TX', seat: 's2', act: 'timer_start', res: 'ok' },

        // Trace 2: Staff A stops assistant-assigned s2 at 00:00 on Watch
        { seq: 6, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 5000, wallMs: 4988, scene: 'S3', traceId: 'tr_s3_stop00', stateRev: s2StoppedNormalFromSeat, hop: 'W_ORIGIN_ACT', seat: 's2', act: 'STOP_TIMER', res: 'ok' },
        { seq: 7, dev: 'u#aaaa11', layer: 'ios_native', adjMs: 5070, wallMs: 5058, scene: 'S3', traceId: 'tr_s3_stop00', hop: 'N_WC_RX', seat: 's2', act: 'STOP_TIMER', res: 'ok' },
        { seq: 8, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 5190, wallMs: 5178, scene: 'S3', traceId: 'tr_s3_stop00', stateRev: s2StoppedNormalFromSeat, hop: 'W_CLOUD_PATCH', seat: 's2', act: 'STOP_TIMER', res: 'ok' },
        { seq: 9, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 5340, wallMs: 5328, scene: 'S3', traceId: 'tr_s3_stop00', stateRev: s2StoppedNormalFromSeat, hop: 'W_DIRECT_PUSH', seat: 's2', act: 'stop', res: 'ok' },

        // Trace 3 (Scene S6 direct-poll receiver): Stylist A receives peer stop of s3 from Staff B while keeping s3 running locally!
        { seq: 10, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 9350, wallMs: 9338, scene: 'S6', stateRev: s3RunRev, hop: 'P_RT_RX', seat: 's3', act: 'UPDATE', res: 'ok', meta: { cloudRev: s3PeerStoppedRev, keepLocalRun: true } },
        { seq: 11, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 9380, wallMs: 9368, scene: 'S6', stateRev: `s3:${s3RunRev}`, hop: 'P_UI_COMMIT', act: 'seats_state_changed', res: 'ok', meta: { compositeRev: compositeStylistHold, cloudRev: `s3:${s3PeerStoppedRev}` } },
        { seq: 12, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 9600, wallMs: 9588, scene: 'S6', stateRev: s3RunRev, hop: 'W_POLL_DIFF', seat: 's3', act: 'reconcile', res: 'ok', rsn: 'local_peer_stop_hold', meta: { prevRev: s3RunRev, cloudRev: s3PeerStoppedRev } },
        { seq: 13, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 9630, wallMs: 9618, scene: 'S6', stateRev: compositeStylistHold, hop: 'W_UI_COMMIT', seat: 's3', act: 'peer_alert_banner_commit', res: 'ok', rsn: 'peer_stop_hold_banner', meta: { cloudRev: s3PeerStoppedRev } },

        // Trace 4: Stylist A starts s4 on Watch at t=12000ms (30s BEFORE Staff B stops s4!)
        { seq: 14, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 12000, wallMs: 11988, scene: 'S1', traceId: 'tr_s4_start', stateRev: s4RunRev, hop: 'W_ORIGIN_ACT', seat: 's4', act: 'START_TIMER', res: 'ok' },
        { seq: 15, dev: 'u#aaaa11', layer: 'ios_native', adjMs: 12055, wallMs: 12043, scene: 'S1', traceId: 'tr_s4_start', hop: 'N_WC_RX', seat: 's4', act: 'START_TIMER', res: 'ok' },
        { seq: 16, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 12180, wallMs: 12168, scene: 'S1', traceId: 'tr_s4_start', stateRev: s4RunRev, hop: 'W_CLOUD_PATCH', seat: 's4', act: 'START_TIMER', res: 'ok' },
        { seq: 17, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 12290, wallMs: 12278, scene: 'S1', traceId: 'tr_s4_start', stateRev: s4RunRev, hop: 'P_PUSH_TX', seat: 's4', act: 'timer_start', res: 'ok' },

        // Trace 5 (Scene S6 Stage 1 WCSession receiver 30s after s4 start while s3 is ALSO running & peer-stop held!):
        { seq: 18, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 42240, wallMs: 42228, scene: 'S6', stateRev: s4RunRev, hop: 'P_RT_RX', seat: 's4', act: 'UPDATE', res: 'ok', meta: { cloudRev: s4PeerStopStage1Rev, keepLocalRun: true } },
        { seq: 19, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 42275, wallMs: 42263, scene: 'S6', stateRev: `s4:${s4RunRev}`, hop: 'P_UI_COMMIT', act: 'seats_state_changed', res: 'ok', meta: { compositeRev: compositeStylistHoldS4, cloudRev: `s4:${s4PeerStopStage1Rev}` } },
        { seq: 20, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 42390, wallMs: 42378, scene: 'S6', stateRev: compositeStylistHoldS4, hop: 'W_WC_RX', act: 'SYNC_SEATS', res: 'ok', rsn: 'applied_same_rev', meta: { prevRev: compositeStylistHoldS4, peerKeep: 1, freshNotif: true, peerRevChg: true, cloudRev: `s4:${s4PeerStopStage1Rev}` } },
        { seq: 21, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 42420, wallMs: 42408, scene: 'S6', stateRev: compositeStylistHoldS4, hop: 'W_UI_COMMIT', seat: 's4', act: 'peer_alert_banner_commit', res: 'ok', rsn: 'peer_stop_hold_banner', meta: { alertCount: 2, cloudRev: s4PeerStopStage1Rev } },

        // Trace 6 (Scene S6 Stage 2 transition on s4: stop -> shampoo while BOTH s3 and s4 remain locally running!):
        { seq: 22, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 47250, wallMs: 47238, scene: 'S6', stateRev: s4RunRev, hop: 'P_POLL_DIFF', seat: 's4', act: 'reconcile', res: 'ok', rsn: 'local_peer_stop_hold', meta: { prevRev: s4RunRev, cloudRev: s4PeerShampooStage2Rev } },
        { seq: 23, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 47285, wallMs: 47273, scene: 'S6', stateRev: `s4:${s4RunRev}`, hop: 'P_UI_COMMIT', act: 'seats_state_changed', res: 'ok', meta: { compositeRev: compositeStylistHoldS4, cloudRev: `s4:${s4PeerShampooStage2Rev}` } },
        { seq: 24, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 47410, wallMs: 47398, scene: 'S6', stateRev: compositeStylistHoldS4, hop: 'W_WC_RX', act: 'SYNC_SEATS', res: 'ok', rsn: 'applied_same_rev', meta: { prevRev: compositeStylistHoldS4, peerKeep: 0, freshNotif: false, peerRevChg: true, cloudRev: `s4:${s4PeerShampooStage2Rev}` } },
        { seq: 25, dev: 'u#aaaa11', layer: 'watch_app', adjMs: 47440, wallMs: 47428, scene: 'S6', stateRev: compositeStylistHoldS4, hop: 'W_UI_COMMIT', seat: 's4', act: 'peer_alert_banner_commit', res: 'ok', rsn: 'peer_stop_hold_banner', meta: { alertCount: 2, cloudRev: s4PeerShampooStage2Rev } },
      ],
    },
    {
      file: 'staffB_sub.jsonl',
      headers: [
        {
          file: 'staffB_sub.jsonl',
          dev: 'u#bbbb22',
          role: 'guest',
          serverOffsetMs: -8,
          watchPullResult: 'ok(9rows,51ms)',
          complicationEnabled: true,
          remainingComplicationTransfers: 45,
        },
      ],
      entries: [
        // Trace 1 receiver on Staff B (multi-seat compositeRev on P_UI_COMMIT, W_UI_COMMIT, and WG_TIMELINE!)
        { seq: 1, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 1520, wallMs: 1528, scene: 'S1', stateRev: s2RunRev, hop: 'P_RT_RX', seat: 's2', act: 'UPDATE', res: 'ok' },
        { seq: 2, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 1550, wallMs: 1558, scene: 'S1', stateRev: `s2:${s2RunRev},s3:${s3RunRev}`, hop: 'P_UI_COMMIT', res: 'ok', meta: { compositeRev: compositeMultiSeat } },
        { seq: 3, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 1700, wallMs: 1708, scene: 'S1', stateRev: s2RunRev, hop: 'W_POLL_DIFF', seat: 's2', act: 'reconcile', res: 'ok' },
        { seq: 4, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 1725, wallMs: 1733, scene: 'S1', stateRev: compositeMultiSeat, hop: 'W_UI_COMMIT', act: 'timers_state_commit', res: 'ok' },
        { seq: 5, dev: 'u#bbbb22', layer: 'watch_widget', adjMs: 1850, wallMs: 1858, stateRev: s3RunRev, hop: 'WG_TIMELINE', seat: 's3', act: 'getTimeline', res: 'ok', meta: { compositeRev: compositeMultiSeat } },

        // Trace 2 receiver on Staff B (00:00 stop with leftover assistant on cloud row)
        { seq: 6, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 5510, wallMs: 5518, scene: 'S3', stateRev: s2StoppedNormalFromCloudRow, hop: 'P_POLL_DIFF', seat: 's2', act: 'reconcile', res: 'ok' },
        { seq: 7, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 5540, wallMs: 5548, scene: 'S3', stateRev: `s2:${s2StoppedNormalFromSeat}`, hop: 'P_UI_COMMIT', res: 'ok', meta: { compositeRev: compositeAfterStop } },
        { seq: 8, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 5710, wallMs: 5718, scene: 'S3', stateRev: s2StoppedNormalFromCloudRow, hop: 'W_POLL_DIFF', seat: 's2', act: 'reconcile', res: 'ok' },
        { seq: 9, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 5740, wallMs: 5748, scene: 'S3', stateRev: compositeAfterStop, hop: 'W_WIDGET_SAVE', act: 'save_and_reload', res: 'ok' },

        // Trace 3 origin on Staff B (Scene S6: Staff B stops s3 from TimeActionSheet with post-action s3PeerStoppedRev!)
        { seq: 10, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 9000, wallMs: 9008, scene: 'S6', traceId: 'tr_s6_peerstop', stateRev: s3PeerStoppedRev, hop: 'W_ORIGIN_ACT', seat: 's3', act: 'STOP_TIMER', res: 'ok', meta: { prevRev: s3RunRev } },
        { seq: 11, dev: 'u#bbbb22', layer: 'ios_native', adjMs: 9065, wallMs: 9073, scene: 'S6', traceId: 'tr_s6_peerstop', hop: 'N_WC_RX', seat: 's3', act: 'STOP_TIMER', res: 'ok' },
        { seq: 12, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 9180, wallMs: 9188, scene: 'S6', traceId: 'tr_s6_peerstop', stateRev: s3PeerStoppedRev, hop: 'W_CLOUD_PATCH', seat: 's3', act: 'STOP_TIMER', res: 'ok' },
        { seq: 13, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 9290, wallMs: 9298, scene: 'S6', traceId: 'tr_s6_peerstop', stateRev: s3PeerStoppedRev, hop: 'W_DIRECT_PUSH', seat: 's3', act: 'stop', res: 'ok' },

        // Trace 4 receiver on Staff B (s4 start)
        { seq: 14, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 12450, wallMs: 12458, scene: 'S1', stateRev: s4RunRev, hop: 'P_RT_RX', seat: 's4', act: 'UPDATE', res: 'ok' },
        { seq: 15, dev: 'u#bbbb22', layer: 'ios_js', adjMs: 12480, wallMs: 12488, scene: 'S1', stateRev: `s4:${s4RunRev}`, hop: 'P_UI_COMMIT', res: 'ok', meta: { compositeRev: compositeStylistHoldS4 } },
        { seq: 16, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 12610, wallMs: 12618, scene: 'S1', stateRev: compositeStylistHoldS4, hop: 'W_WC_RX', act: 'SYNC_SEATS', res: 'ok' },
        { seq: 17, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 12640, wallMs: 12648, scene: 'S1', stateRev: compositeStylistHoldS4, hop: 'W_UI_COMMIT', act: 'timers_state_commit', res: 'ok' },

        // Trace 5 origin on Staff B (Stage 1: 30s after s4 start, Staff B stops s4 -> Stylist A receives via WCSession!)
        { seq: 18, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 42000, wallMs: 42008, scene: 'S6', traceId: 'tr_s6_wc_peerstop', stateRev: s4PeerStopStage1Rev, hop: 'W_ORIGIN_ACT', seat: 's4', act: 'STOP_TIMER', res: 'ok', meta: { prevRev: s4RunRev } },
        { seq: 19, dev: 'u#bbbb22', layer: 'ios_native', adjMs: 42060, wallMs: 42068, scene: 'S6', traceId: 'tr_s6_wc_peerstop', hop: 'N_WC_RX', seat: 's4', act: 'STOP_TIMER', res: 'ok' },
        { seq: 20, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 42150, wallMs: 42158, scene: 'S6', traceId: 'tr_s6_wc_peerstop', stateRev: s4PeerStopStage1Rev, hop: 'W_CLOUD_PATCH', seat: 's4', act: 'STOP_TIMER', res: 'ok' },
        { seq: 21, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 42210, wallMs: 42218, scene: 'S6', traceId: 'tr_s6_wc_peerstop', stateRev: s4PeerStopStage1Rev, hop: 'W_DIRECT_PUSH', seat: 's4', act: 'stop', res: 'ok' },

        // Trace 6 origin on Staff B (Stage 2: 5s later while s4 is stopped, Staff B transitions s4 to shampoo!)
        { seq: 22, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 47000, wallMs: 47008, scene: 'S6', traceId: 'tr_s6_stage2_shampoo', stateRev: s4PeerShampooStage2Rev, hop: 'W_ORIGIN_ACT', seat: 's4', act: 'START_SHAMPOO', res: 'ok', meta: { prevRev: s4PeerStopStage1Rev } },
        { seq: 23, dev: 'u#bbbb22', layer: 'ios_native', adjMs: 47055, wallMs: 47063, scene: 'S6', traceId: 'tr_s6_stage2_shampoo', hop: 'N_WC_RX', seat: 's4', act: 'START_SHAMPOO', res: 'ok' },
        { seq: 24, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 47140, wallMs: 47148, scene: 'S6', traceId: 'tr_s6_stage2_shampoo', stateRev: s4PeerShampooStage2Rev, hop: 'W_CLOUD_PATCH', seat: 's4', act: 'START_SHAMPOO', res: 'ok' },
        { seq: 25, dev: 'u#bbbb22', layer: 'watch_app', adjMs: 47200, wallMs: 47208, scene: 'S6', traceId: 'tr_s6_stage2_shampoo', stateRev: s4PeerShampooStage2Rev, hop: 'W_DIRECT_PUSH', seat: 's4', act: 'shampoo', res: 'ok' },
      ],
    },
  ];

  const multiAnalysis = analyzeLogs(multiDeviceDataset);
  assert.strictEqual(multiAnalysis.multiDeviceMode, true, '2-staff dataset must enable multiDeviceMode');
  assert.strictEqual(multiAnalysis.evaluatedTraces.length, 6, 'All 6 traces must be detected');

  for (const tr of multiAnalysis.evaluatedTraces) {
    assert.notStrictEqual(tr.ownPhoneWcMs, null, `${tr.traceId}: Stage 1 (ownPhoneWcMs) must join`);
    assert.notStrictEqual(tr.cloudWriteMs, null, `${tr.traceId}: Stage 2 (cloudWriteMs) must join`);
    assert.notStrictEqual(tr.pushTxMs, null, `${tr.traceId}: Stage 3 (pushTxMs) must join`);
    assert.notStrictEqual(tr.peerPhoneRxMs, null, `${tr.traceId}: Stage 4 (peerPhoneRxMs) must join`);
    assert.notStrictEqual(tr.peerPhoneUiMs, null, `${tr.traceId}: Stage 5 (peerPhoneUiMs) must join`);
    assert.notStrictEqual(tr.targetWatchRxMs, null, `${tr.traceId}: Stage 6 (targetWatchRxMs) must join`);
    assert.notStrictEqual(tr.targetWatchCommitMs, null, `${tr.traceId}: Stage 7 (targetWatchCommitMs) must join`);
  }

  const s3PeerStopTrace = multiAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_peerstop');
  const wcS6Stage1Trace = multiAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_wc_peerstop');
  const wcS6Stage2Trace = multiAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_stage2_shampoo');
  assert.strictEqual(wcS6Stage1Trace.targetWatchRxMs, 390, 'Scene S6 Stage 1 W_WC_RX must link to tr_s6_wc_peerstop');
  assert.strictEqual(wcS6Stage1Trace.targetWatchCommitMs, 420, 'Scene S6 Stage 1 W_UI_COMMIT must link to tr_s6_wc_peerstop');
  assert.strictEqual(wcS6Stage2Trace.peerPhoneRxMs, 250, 'Scene S6 Stage 2 P_POLL_DIFF must link to tr_s6_stage2_shampoo');
  assert.strictEqual(wcS6Stage2Trace.peerPhoneUiMs, 285, 'Scene S6 Stage 2 P_UI_COMMIT must link to tr_s6_stage2_shampoo');
  assert.strictEqual(wcS6Stage2Trace.targetWatchRxMs, 410, 'Scene S6 Stage 2 W_WC_RX (peerRevChg) must link to tr_s6_stage2_shampoo');
  assert.strictEqual(wcS6Stage2Trace.targetWatchCommitMs, 440, 'Scene S6 Stage 2 W_UI_COMMIT must link to tr_s6_stage2_shampoo');

  // Verify strict cross-seat & cross-stage isolation: s4 events (seq 18..25 on staffA) must NEVER mislink to s3 (`tr_s6_peerstop`),
  // and Stage 2 events (seq 22..25 on staffA) must NEVER mislink to Stage 1 (`tr_s6_wc_peerstop`)!
  assert.strictEqual(
    s3PeerStopTrace.events.some((ev) => ev.dev === 'u#aaaa11' && ev.seq >= 18),
    false,
    'Multi-seat Scene S6 events on s4 must NOT mislink to s3 trace tr_s6_peerstop'
  );
  assert.strictEqual(
    wcS6Stage1Trace.events.some((ev) => ev.dev === 'u#aaaa11' && ev.seq >= 22),
    false,
    'Scene S6 Stage 2 (stop -> shampoo) events on s4 must NOT mislink to Stage 1 trace tr_s6_wc_peerstop'
  );

  // Also verify fallback when W_WC_RX / W_UI_COMMIT omit meta.cloudRev (composite-only local-hold stateRev 30s after START_TIMER)
  const fallbackDataset = JSON.parse(JSON.stringify(multiDeviceDataset));
  for (const ev of fallbackDataset[0].entries) {
    if (ev.seq === 20 || ev.seq === 21 || ev.seq === 24 || ev.seq === 25) {
      delete ev.meta.cloudRev;
    }
  }
  const fallbackAnalysis = analyzeLogs(fallbackDataset);
  const fallbackWcS6Stage1 = fallbackAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_wc_peerstop');
  const fallbackWcS6Stage2 = fallbackAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_stage2_shampoo');
  const fallbackS3 = fallbackAnalysis.evaluatedTraces.find((t) => t.traceId === 'tr_s6_peerstop');
  assert.strictEqual(fallbackWcS6Stage1.targetWatchRxMs, 390, 'Scene S6 composite-only Stage 1 W_WC_RX must link via peerHoldLinks without being stolen by START_TIMER');
  assert.strictEqual(fallbackWcS6Stage1.targetWatchCommitMs, 420, 'Scene S6 composite-only Stage 1 W_UI_COMMIT must link via peerHoldLinks without cross-seat mislink');
  assert.strictEqual(fallbackWcS6Stage2.targetWatchRxMs, 410, 'Scene S6 composite-only Stage 2 W_WC_RX must link to Stage 2 trace');
  assert.strictEqual(fallbackWcS6Stage2.targetWatchCommitMs, 440, 'Scene S6 composite-only Stage 2 W_UI_COMMIT must link to Stage 2 trace');
  assert.strictEqual(
    fallbackS3.events.some((ev) => ev.dev === 'u#aaaa11' && ev.seq >= 18),
    false,
    'Composite-only fallback on s4 must still NOT mislink to s3 trace'
  );

  // 4) Single-staff 4-layer merged file (even with early unpromoted d#/w#/wg lines) -> multiDeviceMode === false
  const singleStaffDataset = [
    {
      file: 'single_staff_merged.jsonl',
      headers: [
        {
          file: 'single_staff_merged.jsonl',
          dev: 'u#aaaa11',
          role: 'owner',
          serverOffsetMs: 5,
          watchPullResult: 'ok(4rows,31ms)',
          complicationEnabled: true,
          remainingComplicationTransfers: 49,
        },
      ],
      entries: [
        { seq: 1, dev: 'd#1a2b', layer: 'ios_js', adjMs: 1000, wallMs: 995, scene: 'S7', traceId: 'tr_main_01', hop: 'P_MAIN_ORIGIN', seat: 'main-timer', act: 'MAIN_TIMER_RUNNING', res: 'ok' },
        { seq: 2, dev: 'u#aaaa11', layer: 'ios_js', adjMs: 1015, wallMs: 1010, scene: 'S7', traceId: 'tr_main_01', hop: 'P_WC_SYNC_TX', seat: 'main-timer', act: 'SYNC_MAIN_TIMER', res: 'ok' },
        { seq: 3, dev: 'w#9f8e', layer: 'watch_app', adjMs: 1120, wallMs: 1115, scene: 'S7', traceId: 'tr_main_01', hop: 'W_WC_RX', seat: 'main-timer', act: 'SYNC_MAIN_TIMER', res: 'ok' },
        { seq: 4, dev: 'wg', layer: 'watch_widget', adjMs: 1300, wallMs: 1295, traceId: 'tr_main_01', hop: 'WG_TIMELINE', seat: 'main-timer', act: 'getTimeline', res: 'ok' },
      ],
    },
  ];
  const singleAnalysis = analyzeLogs(singleStaffDataset);
  assert.strictEqual(
    singleAnalysis.multiDeviceMode,
    false,
    'Single-staff merged 4-layer file must have multiDeviceMode === false'
  );
  assert.strictEqual(singleAnalysis.uniqueDevs.length, 1, 'Fallback d#/w#/wg IDs must unify to u#aaaa11');
  assert.strictEqual(singleAnalysis.evaluatedTraces[0].targetWatchRxMs, 120);
  assert.strictEqual(singleAnalysis.evaluatedTraces[0].targetWatchCommitMs, 300);

  return renderMarkdownReport(multiAnalysis, ['staffA_main.jsonl', 'staffB_sub.jsonl']);
}

function main() {
  const args = process.argv.slice(2);
  const inputFiles = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--self-test')) {
    const report = runSelfTest();
    console.log(report);
    console.log('✅ SELF-TEST PASSED (multi-seat composite JOIN, 00:00 stop parity, Scene S6 peer-stop hold, single-staff mode)');
    process.exit(0);
  }

  if (inputFiles.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: node scripts/analyze-sync-trace.js <staffA_main.jsonl> [staffB_sub.jsonl ...] [--markdown]',
        '',
        'Options:',
        '  --markdown   Output GitHub Issue #13 ready Markdown report (default output format)',
        '  --self-test  Run built-in strict assertion suite',
      ].join('\n')
    );
    process.exit(0);
  }

  const parsedFiles = inputFiles.map((f) => parseJsonlFile(f));
  const analysis = analyzeLogs(parsedFiles);
  console.log(renderMarkdownReport(analysis, inputFiles));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseJsonlFile,
  analyzeLogs,
  renderMarkdownReport,
  runSelfTest,
};
