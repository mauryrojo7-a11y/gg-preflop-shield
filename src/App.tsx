import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Camera,
  Zap,
  KeyRound,
  Shield,
  RefreshCw,
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Eye,
  Grid,
  Wallet,
  Sliders,
  RotateCcw
} from 'lucide-react';

type ActiveTab = 'scanner' | 'matrix' | 'bankroll';
type TablePos = 'UTG_MP' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';
type SpotSituation = 'OPEN_FIRST' | 'VS_OPEN_2BB' | 'VS_ALLIN';
type CellAction = 'ALLIN' | 'MINRAISE' | 'CALL' | 'FOLD';

interface PreflopState {
  heroRank1: string;
  heroRank2: string;
  heroSuited: boolean;
  heroPosition: TablePos;
  effectiveStackBb: number;
  situation: SpotSituation;
  aggressorPosition: TablePos;
  villainBetBb: number;
  deadPotBb: number;
  villainVpipPct: number | null;
  bountyBbEquivalent: number;
  isIcmActive: boolean;
}

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

// Lista priorizada de modelos rápidos con visión JSON; si dan 404 se auto-descubre desde /v1beta/models
const CANDIDATE_VISION_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-flash-latest'
];

const PREFLOP_VISION_PROMPT = `Sos un lector óptico preflop de ultra baja latencia para mesas 8-Max Hyper-Turbo de GGPoker.
Ignorá cualquier carta comunitaria y extraé EXCLUSIVAMENTE el estado PREFLOP en JSON válido con este esquema exacto:
{
  "heroRank1": "A|K|Q|J|T|9|8|7|6|5|4|3|2",
  "heroRank2": "A|K|Q|J|T|9|8|7|6|5|4|3|2",
  "heroSuited": boolean (true si ambas cartas de Hero abajo al centro tienen el mismo palo o mismo color en baraja de 4 colores: negro=picas, rojo=corazón, azul=diamante, verde=trébol),
  "heroPosition": "UTG_MP" | "HJ" | "CO" | "BTN" | "SB" | "BB" (según ubicación del disco blanco 'D' respecto al asiento inferior central de Hero en sentido horario),
  "effectiveStackBb": number (el menor entre el stack de Hero en BB y el stack máximo en BB de los rivales activos o que faltan hablar),
  "situation": "OPEN_FIRST" (nadie subió antes de Hero) | "VS_OPEN_2BB" (un rival abrió entre 2.0 y 3.5 BB) | "VS_ALLIN" (un rival fue All-in o apostó más del 40% del stack efectivo),
  "aggressorPosition": "UTG_MP" | "HJ" | "CO" | "BTN" | "SB" | "BB" (posición del rival que abrió o fue All-in; si es OPEN_FIRST repetir heroPosition),
  "villainBetBb": number (tamaño de la apuesta o All-in efectivo del rival en BB; 0 si es OPEN_FIRST),
  "deadPotBb": number (ciegas + antes muertas en el pozo sin contar villainBetBb; 2.5 por defecto en Hyper 8-max),
  "villainVpipPct": number | null (número entero de VPIP junto al avatar del agresor en el Smart HUD de GGPoker, o null si no se distingue),
  "bountyBbEquivalent": number (0 en Daily Hyper/Freezeout; equivalente en BB si hay cartel de bounty PKO),
  "isIcmActive": boolean (true si se observa paño de Final Table o burbuja Hand-for-Hand)
}`;

function sanitizeApiKey(raw: string): string {
  return raw.replace(/\s+/g, '').trim();
}

function normalizeRank(val: string): string {
  const clean = (val || 'A').toUpperCase().trim();
  if (clean === '10') return 'T';
  return (RANKS as readonly string[]).includes(clean) ? clean : 'A';
}

function getMatrixHandLabel(r: number, c: number): string {
  if (r === c) return `${RANKS[r]}${RANKS[c]}`;
  if (r < c) return `${RANKS[r]}${RANKS[c]}s`;
  return `${RANKS[c]}${RANKS[r]}o`;
}

function formatUsdFromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

async function discoverAvailableFlashModel(cleanKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> =
      data?.models || [];

    const validIds = models
      .filter(
        (m) =>
          typeof m.name === 'string' &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
      )
      .map((m) => (m.name as string).replace(/^models\//, ''));

    // Priorizar cualquier variante Flash con visión (excluyendo modelos solo TTS/embedding/imagen)
    const flashModel = validIds.find(
      (id) =>
        id.includes('flash') &&
        !id.includes('tts') &&
        !id.includes('image') &&
        !id.includes('audio') &&
        !id.includes('8b')
    );
    if (flashModel) return flashModel;

    return validIds.find((id) => id.startsWith('gemini-')) || null;
  } catch {
    return null;
  }
}

function computePreflopEquityVsVillain(
  r1: string,
  r2: string,
  suited: boolean,
  vpip: number | null,
  villainBetBb: number,
  aggressorPos: TablePos
): number {
  const i1 = RANKS.indexOf(r1 as (typeof RANKS)[number]);
  const i2 = RANKS.indexOf(r2 as (typeof RANKS)[number]);
  const hi = 14 - Math.min(i1, i2);
  const lo = 14 - Math.max(i1, i2);
  const isPair = i1 === i2;

  let baseEq = 38;
  if (isPair) {
    const pairEq: Record<number, number> = {
      14: 84.5,
      13: 81.2,
      12: 77.5,
      11: 73.8,
      10: 70.2,
      9: 66.4,
      8: 63.0,
      7: 59.8,
      6: 56.8,
      5: 54.2,
      4: 52.0,
      3: 50.2,
      2: 48.8
    };
    baseEq = pairEq[hi] ?? 52;
  } else if (hi === 14) {
    baseEq = 46 + (lo - 2) * 1.85 + (suited ? 3.1 : 0);
  } else if (hi === 13) {
    baseEq = 40.5 + (lo - 2) * 1.65 + (suited ? 3.3 : 0);
  } else if (hi === 12) {
    baseEq = 37.0 + (lo - 2) * 1.55 + (suited ? 3.4 : 0);
  } else {
    const gap = hi - lo;
    baseEq = 31.5 + hi * 0.9 + lo * 0.65 + (suited ? 3.5 : 0) + (gap === 1 ? 2.2 : 0);
  }

  const posShift: Record<TablePos, number> = {
    UTG_MP: -4.5,
    HJ: -2.0,
    CO: 0,
    BTN: +3.2,
    SB: +5.5,
    BB: 0
  };

  let hudShift = 0;
  if (vpip !== null) {
    if (vpip <= 15) {
      hudShift = !isPair && hi === 14 && lo <= 11 ? -10.5 : -6.5;
    } else if (vpip >= 28 && vpip < 40) {
      hudShift = +5.0;
    } else if (vpip >= 40) {
      hudShift = +9.0;
    }
  }

  const shortShoveBonus = Math.max(-4, Math.min(7, (11 - villainBetBb) * 0.75));
  return Math.max(18, Math.min(88, baseEq + posShift[aggressorPos] + hudShift + shortShoveBonus));
}

function computeHyperPreflopScore(r1: string, r2: string, suited: boolean, effBb: number): number {
  const i1 = RANKS.indexOf(r1 as (typeof RANKS)[number]);
  const i2 = RANKS.indexOf(r2 as (typeof RANKS)[number]);
  const isPair = i1 === i2;
  const hi = 14 - Math.min(i1, i2);
  const lo = 14 - Math.max(i1, i2);
  const gap = hi - lo;

  if (isPair) return 54 + (hi - 2) * 3.9 + (effBb <= 18 ? 6.5 : 1.5);

  let score = hi * 3.2 + lo * 1.65 + (suited ? 6.5 : 0);
  if (effBb >= 22) {
    if (suited && gap === 1 && hi >= 6) score += 7.0;
    if (!suited && hi === 14 && lo <= 7) score -= 5.0;
  } else if (effBb <= 9) {
    if (hi === 14) score += 7.5;
    if (hi === 13) score += 3.5;
    if (hi <= 9 && gap >= 1) score -= 3.5;
  } else {
    if (hi === 14 && suited) score += 5.5;
  }
  return score;
}

function evaluateCellPreflopAction(
  r1: string,
  r2: string,
  suited: boolean,
  heroPos: TablePos,
  aggressorPos: TablePos,
  effBb: number,
  situation: SpotSituation,
  villainVpip: number | null,
  isIcmActive: boolean
): CellAction {
  const isPair = r1 === r2;
  const i1 = RANKS.indexOf(r1 as (typeof RANKS)[number]);
  const i2 = RANKS.indexOf(r2 as (typeof RANKS)[number]);
  const hiVal = 14 - Math.min(i1, i2);
  const loVal = 14 - Math.max(i1, i2);

  const score = computeHyperPreflopScore(r1, r2, !isPair && suited, effBb);
  const icmPenalty = isIcmActive ? 7.5 : 0;

  if (situation === 'VS_ALLIN') {
    const baseCut =
      effBb >= 22 ? 81.0 : effBb >= 15 ? 75.5 : effBb >= 11 ? 70.0 : effBb >= 7 ? 65.0 : 58.0;
    const posAdj: Record<TablePos, number> = {
      UTG_MP: +6.5,
      HJ: +3.5,
      CO: 0,
      BTN: -4.5,
      SB: -8.5,
      BB: 0
    };
    const vpipAdj =
      villainVpip !== null && villainVpip <= 15
        ? +6.5
        : villainVpip !== null && villainVpip >= 32
          ? -4.5
          : 0;
    return score >= baseCut + posAdj[aggressorPos] + vpipAdj + icmPenalty * 1.25 ? 'CALL' : 'FOLD';
  }

  if (situation === 'VS_OPEN_2BB') {
    const openerCut: Record<TablePos, number> = {
      UTG_MP: 78.0,
      HJ: 71.5,
      CO: 66.5,
      BTN: 60.5,
      SB: 57.0,
      BB: 65.0
    };
    const vpipAdj =
      villainVpip !== null && villainVpip >= 32
        ? -4.0
        : villainVpip !== null && villainVpip <= 15
          ? +6.0
          : 0;
    const cut = openerCut[aggressorPos] + icmPenalty + vpipAdj;

    if (effBb <= 23 && score >= cut) return 'ALLIN';
    if (heroPos === 'BB' && effBb >= 15 && !isPair && suited && score >= cut - 8.0) return 'CALL';
    return 'FOLD';
  }

  const posOffset: Record<TablePos, number> = {
    UTG_MP: +10.5,
    HJ: +5.5,
    CO: 0,
    BTN: -9.5,
    SB: -15.5,
    BB: -6.0
  };
  const shift = posOffset[heroPos] + icmPenalty;

  if (effBb >= 22) {
    return score >= 58.5 + shift ? 'MINRAISE' : 'FOLD';
  }

  if (effBb >= 14) {
    if (score < 57.8 + shift) return 'FOLD';
    const preferDirectAllIn =
      heroPos !== 'UTG_MP' && ((isPair && hiVal <= 8) || (hiVal === 14 && loVal <= 9 && !suited));
    return preferDirectAllIn ? 'ALLIN' : 'MINRAISE';
  }

  const shoveCut = effBb >= 10 ? 57.2 : effBb >= 7 ? 53.0 : 48.5;
  return score >= shoveCut + shift ? 'ALLIN' : 'FOLD';
}

export default function App() {
  const [tab, setTab] = useState<ActiveTab>('scanner');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('gg_shield_key') || '');
  const [resolvedModel, setResolvedModel] = useState<string>(
    () => localStorage.getItem('gg_shield_model') || ''
  );
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [bankrollCentsStr, setBankrollCentsStr] = useState<string>(
    () => localStorage.getItem('gg_shield_roll_cents') || '10000'
  );

  const [state, setState] = useState<PreflopState>({
    heroRank1: '8',
    heroRank2: '8',
    heroSuited: false,
    heroPosition: 'SB',
    effectiveStackBb: 18,
    situation: 'VS_OPEN_2BB',
    aggressorPosition: 'HJ',
    villainBetBb: 2,
    deadPotBb: 2.5,
    villainVpipPct: null,
    bountyBbEquivalent: 0,
    isIcmActive: false
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    localStorage.setItem('gg_shield_key', sanitizeApiKey(apiKey));
  }, [apiKey]);

  useEffect(() => {
    if (resolvedModel) {
      localStorage.setItem('gg_shield_model', resolvedModel);
    }
  }, [resolvedModel]);

  useEffect(() => {
    localStorage.setItem('gg_shield_roll_cents', bankrollCentsStr);
  }, [bankrollCentsStr]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const currentRollCents = BigInt(bankrollCentsStr);

  const adjustRoll = (deltaCents: bigint) => {
    const next = currentRollCents + deltaCents;
    setBankrollCentsStr((next < 0n ? 0n : next).toString());
  };

  const startLiveCamera = async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
    } catch {
      setErrorMsg(
        'Para cámara continua usá HTTPS (GitHub Pages). También podés tocar "Foto" al lado.'
      );
    }
  };

  const callVisionWithModel = async (
    modelId: string,
    cleanKey: string,
    base64JpegClean: string
  ): Promise<Response> => {
    return fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(
        cleanKey
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PREFLOP_VISION_PROMPT }] },
          contents: [
            {
              parts: [
                { text: 'Extraé el estado preflop exacto en JSON.' },
                { inlineData: { mimeType: 'image/jpeg', data: base64JpegClean } }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.0,
            responseMimeType: 'application/json'
          }
        })
      }
    );
  };

  const scanBase64Image = async (base64JpegClean: string) => {
    const cleanKey = sanitizeApiKey(apiKey);
    if (!cleanKey) {
      setShowKeyModal(true);
      setErrorMsg('Pegá primero tu API Key gratuita de Google AI Studio en el ícono de llave.');
      return;
    }

    setIsScanning(true);
    setErrorMsg(null);
    const t0 = performance.now();

    try {
      const queue = resolvedModel
        ? [resolvedModel, ...CANDIDATE_VISION_MODELS.filter((m) => m !== resolvedModel)]
        : [...CANDIDATE_VISION_MODELS];

      let successResponse: Response | null = null;
      let activeModelUsed = '';
      let lastErrorDetail = '';

      for (const candidate of queue) {
        const res = await callVisionWithModel(candidate, cleanKey, base64JpegClean);
        if (res.ok) {
          successResponse = res;
          activeModelUsed = candidate;
          break;
        }

        const errJson = await res.json().catch(() => null);
        lastErrorDetail = errJson?.error?.message || `HTTP ${res.status}`;

        // Si es 400 API_KEY_INVALID o 403 PERMISSION_DENIED, no tiene sentido probar más modelos
        if (res.status === 400 || res.status === 403) {
          if (lastErrorDetail.toLowerCase().includes('key')) {
            throw new Error(`Clave inválida o bloqueada (${lastErrorDetail}). Creá una nueva en aistudio.google.com/api-keys`);
          }
        }

        // Si dio 404, continuar al siguiente modelo candidato
        if (res.status !== 404) {
          break;
        }
      }

      // Si todos los nombres estándar dieron 404, consultar /v1beta/models en vivo para esa API Key
      if (!successResponse) {
        const discovered = await discoverAvailableFlashModel(cleanKey);
        if (discovered) {
          const retryRes = await callVisionWithModel(discovered, cleanKey, base64JpegClean);
          if (retryRes.ok) {
            successResponse = retryRes;
            activeModelUsed = discovered;
          } else {
            const retryErr = await retryRes.json().catch(() => null);
            lastErrorDetail = retryErr?.error?.message || `HTTP ${retryRes.status}`;
          }
        }
      }

      if (!successResponse) {
        throw new Error(
          `No se pudo conectar al modelo (${lastErrorDetail}). Creá una clave nueva con "Create API key in new project" en AI Studio.`
        );
      }

      setResolvedModel(activeModelUsed);

      const payload = await successResponse.json();
      const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Lectura vacía: acercá el encuadre al monitor.');

      const parsed = JSON.parse(extractFirstJsonObject(rawText)) as Partial<PreflopState>;
      const r1 = normalizeRank(parsed.heroRank1 || 'A');
      const r2 = normalizeRank(parsed.heroRank2 || 'K');

      setState({
        heroRank1: r1,
        heroRank2: r2,
        heroSuited: r1 === r2 ? false : Boolean(parsed.heroSuited),
        heroPosition: parsed.heroPosition || 'CO',
        effectiveStackBb: Math.max(1, Math.round(Number(parsed.effectiveStackBb) || 12)),
        situation: parsed.situation || 'OPEN_FIRST',
        aggressorPosition: parsed.aggressorPosition || 'CO',
        villainBetBb: Math.max(0, Number(parsed.villainBetBb) || 0),
        deadPotBb: Math.max(1.5, Number(parsed.deadPotBb) || 2.5),
        villainVpipPct: typeof parsed.villainVpipPct === 'number' ? parsed.villainVpipPct : null,
        bountyBbEquivalent: Math.max(0, Number(parsed.bountyBbEquivalent) || 0),
        isIcmActive: Boolean(parsed.isIcmActive)
      });

      setLatencyMs(Math.round(performance.now() - t0));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Fallo al leer el monitor.');
    } finally {
      setIsScanning(false);
    }
  };

  const captureLiveFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const b64 = canvas.toDataURL('image/jpeg', 0.78).split(',')[1];
    if (b64) void scanBase64Image(b64);
  };

  const handleNativePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const scale = Math.min(1, 960 / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL('image/jpeg', 0.78).split(',')[1];
        if (b64) void scanBase64Image(b64);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const preflopVerdict = useMemo(() => {
    const i1 = RANKS.indexOf(state.heroRank1 as (typeof RANKS)[number]);
    const i2 = RANKS.indexOf(state.heroRank2 as (typeof RANKS)[number]);
    const hi = i1 <= i2 ? state.heroRank1 : state.heroRank2;
    const lo = i1 <= i2 ? state.heroRank2 : state.heroRank1;
    const isPair = hi === lo;
    const handLabel = isPair ? `${hi}${lo}` : `${hi}${lo}${state.heroSuited ? 's' : 'o'}`;
    const bubbleFactor = state.isIcmActive ? 1.38 : 1.0;

    if (state.situation === 'VS_ALLIN') {
      const callBb = Math.min(
        state.effectiveStackBb,
        state.villainBetBb > 0 ? state.villainBetBb : state.effectiveStackBb
      );
      const finalPotBb = state.deadPotBb + callBb + callBb;
      const potOddsPct = (callBb / finalPotBb) * 100;

      const rewardBb = state.deadPotBb + callBb + state.bountyBbEquivalent;
      const riskIcmBb = callBb * bubbleFactor;
      const reqEqPct = (riskIcmBb / (riskIcmBb + rewardBb)) * 100;

      const heroEqPct = computePreflopEquityVsVillain(
        hi,
        lo,
        !isPair && state.heroSuited,
        state.villainVpipPct,
        callBb,
        state.aggressorPosition
      );

      const pWin = heroEqPct / 100;
      const evBb = pWin * rewardBb - (1 - pWin) * riskIcmBb;
      const isCall = evBb >= 0.15;

      return {
        handLabel,
        actionLabel: isCall ? 'PAGAR ALL-IN' : 'FOLD ESTRICTO',
        theme: isCall ? 'emerald' : 'rose',
        headline: `EV Neto: ${evBb >= 0 ? '+' : ''}${evBb.toFixed(2)} BB | Equity: ${heroEqPct.toFixed(1)}% vs Exigida: ${reqEqPct.toFixed(1)}%`,
        mathLine: `Pozo Final: ${finalPotBb.toFixed(1)} BB | Pot Odds: ${potOddsPct.toFixed(1)}% | BF: ${bubbleFactor.toFixed(2)}x`
      };
    }

    const cellAct = evaluateCellPreflopAction(
      hi,
      lo,
      !isPair && state.heroSuited,
      state.heroPosition,
      state.aggressorPosition,
      state.effectiveStackBb,
      state.situation,
      state.villainVpipPct,
      state.isIcmActive
    );

    if (state.situation === 'VS_OPEN_2BB') {
      if (cellAct === 'ALLIN') {
        return {
          handLabel,
          actionLabel: '3-BET ALL-IN',
          theme: 'emerald',
          headline: `Re-steal +EV sobre apertura de ${state.aggressorPosition} (${state.effectiveStackBb} BB)`,
          mathLine: `Robás ~4.5 BB muertas sin ver flop (+${Math.round(
            (4.5 / state.effectiveStackBb) * 100
          )}% al stack)`
        };
      }
      if (cellAct === 'CALL') {
        const openSz = state.villainBetBb > 0 ? state.villainBetBb : 2.0;
        const callAmt = Math.max(0.5, openSz - 1.0);
        const potDef = state.deadPotBb + openSz + callAmt;
        const oddsDef = (callAmt / potDef) * 100;
        return {
          handLabel,
          actionLabel: 'DEFENDER EN BB (CALL)',
          theme: 'amber',
          headline: `Call rentable en Ciega Grande (${state.effectiveStackBb} BB)`,
          mathLine: `Ponés ${callAmt.toFixed(1)} BB en Pozo Final ${potDef.toFixed(1)} BB (Pot Odds: ${oddsDef.toFixed(1)}%)`
        };
      }
      return {
        handLabel,
        actionLabel: 'FOLD',
        theme: 'rose',
        headline: `Fuera de rango frente a apertura de ${state.aggressorPosition}`,
        mathLine: `Guardá tus ${state.effectiveStackBb} BB para empujar con Fold Equity`
      };
    }

    if (cellAct === 'MINRAISE') {
      return {
        handLabel,
        actionLabel: 'ABRIR A 2.0 BB',
        theme: 'sky',
        headline: `Min-Raise estándar desde ${state.heroPosition} (${state.effectiveStackBb} BB)`,
        mathLine: `Prohibido hacer limp o ir All-in directo con este stack`
      };
    }
    if (cellAct === 'ALLIN') {
      return {
        handLabel,
        actionLabel: 'ALL-IN DIRECTO',
        theme: 'emerald',
        headline: `Push preflop +EV desde ${state.heroPosition} (${state.effectiveStackBb} BB)`,
        mathLine: `Robás las 2.5 BB de ciegas + antes con máxima Fold Equity`
      };
    }
    return {
      handLabel,
      actionLabel: 'FOLD',
      theme: 'rose',
      headline: `Fold preflop en ${state.heroPosition} (${state.effectiveStackBb} BB)`,
      mathLine: `Esperando mejor mano o posición más tardía`
    };
  }, [state]);

  const matrixGrid = useMemo(() => {
    return RANKS.map((rChar, rIdx) =>
      RANKS.map((cChar, cIdx) => {
        const label = getMatrixHandLabel(rIdx, cIdx);
        const hi = rIdx <= cIdx ? rChar : cChar;
        const lo = rIdx <= cIdx ? cChar : rChar;
        const suited = rIdx < cIdx;
        const act = evaluateCellPreflopAction(
          hi,
          lo,
          suited,
          state.heroPosition,
          state.aggressorPosition,
          state.effectiveStackBb,
          state.situation,
          state.villainVpipPct,
          state.isIcmActive
        );
        return { label, act };
      })
    );
  }, [state]);

  const themeStyle: Record<string, string> = {
    emerald: 'bg-emerald-950/50 border-emerald-400 text-emerald-300',
    sky: 'bg-sky-950/50 border-sky-400 text-sky-300',
    amber: 'bg-amber-950/50 border-amber-400 text-amber-300',
    rose: 'bg-rose-950/50 border-rose-500 text-rose-300'
  };

  return (
    <div className="min-h-screen bg-black text-slate-100 max-w-md mx-auto flex flex-col select-none font-sans border-x border-slate-900">
      <canvas ref={canvasRef} className="hidden" />

      <header className="px-3.5 py-2.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye className="w-5 h-5 text-emerald-400" />
          <div>
            <div className="text-xs font-black tracking-wider text-white">GG PREFLOP SHIELD</div>
            <div className="text-[10px] text-slate-400">
              {latencyMs
                ? `${(latencyMs / 1000).toFixed(2)}s (${resolvedModel || 'Auto'})`
                : `Banca: ${formatUsdFromCents(currentRollCents)}`}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setState((p) => ({ ...p, isIcmActive: !p.isIcmActive }))}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border flex items-center gap-1 ${
              state.isIcmActive
                ? 'bg-amber-950 border-amber-400 text-amber-300'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            {state.isIcmActive ? 'ICM ON' : 'ICM OFF'}
          </button>
          <button
            onClick={() => setShowKeyModal((v) => !v)}
            className={`p-2 rounded-lg border ${
              apiKey ? 'bg-slate-900 border-slate-700 text-emerald-400' : 'bg-rose-950 border-rose-500 text-rose-300'
            }`}
          >
            <KeyRound className="w-4 h-4" />
          </button>
        </div>
      </header>

      {showKeyModal && (
        <div className="p-3 bg-slate-900 border-b border-slate-700 space-y-2">
          <div className="text-xs font-bold text-white">Gemini API Key (Google AI Studio)</div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setResolvedModel('');
            }}
            placeholder="AIzaSy..."
            className="w-full bg-black border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
          />
          <div className="flex justify-between items-center text-[11px] text-slate-400">
            <span>Auto-detecta el modelo Flash activo.</span>
            <button
              onClick={() => setShowKeyModal(false)}
              className="px-3 py-1 rounded-md bg-emerald-600 text-white font-bold"
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 p-3 space-y-3 overflow-y-auto pb-20">
        {tab === 'scanner' && (
          <>
            <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden">
              {cameraActive ? (
                <div className="relative">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-36 object-cover bg-black"
                  />
                  <div className="absolute inset-0 border-2 border-emerald-500/40 pointer-events-none flex items-end p-2">
                    <span className="text-[10px] bg-black/75 px-2 py-0.5 rounded text-emerald-300 font-semibold">
                      4-Color Deck + Stacks en BB activos en GGPoker
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-3 flex items-center justify-between bg-slate-900/50">
                  <span className="text-xs text-slate-300">Cámara continua en vivo:</span>
                  <button
                    onClick={startLiveCamera}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-600 text-xs font-bold text-white flex items-center gap-1.5 active:scale-95"
                  >
                    <Camera className="w-4 h-4 text-emerald-400" /> Encender Visor
                  </button>
                </div>
              )}

              <div className="p-2.5 grid grid-cols-3 gap-2">
                <button
                  onClick={cameraActive ? captureLiveFrame : startLiveCamera}
                  disabled={isScanning}
                  className="col-span-2 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black text-sm flex items-center justify-center gap-2 active:scale-95 shadow-lg"
                >
                  {isScanning ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" /> ESCANEANDO...
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5" /> {cameraActive ? 'ESCANEAR PREFLOP' : 'ACTIVAR CÁMARA'}
                    </>
                  )}
                </button>

                <label className="py-3.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer active:scale-95">
                  <Upload className="w-4 h-4 text-cyan-400" />
                  Foto
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleNativePhoto}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {errorMsg && (
              <div className="bg-amber-950/50 border border-amber-600 rounded-xl p-2.5 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className={`rounded-2xl border-2 p-4 space-y-2 ${themeStyle[preflopVerdict.theme]}`}>
              <div className="flex items-center gap-3">
                <span className="px-3 py-1.5 rounded-xl bg-black/80 border border-slate-700 text-2xl font-black text-white">
                  {preflopVerdict.handLabel}
                </span>
                <div>
                  <div className="text-[10px] uppercase tracking-wider opacity-85 font-bold">
                    {state.heroPosition} • {state.effectiveStackBb} BB Efectivas
                  </div>
                  <div className="text-2xl font-black text-white flex items-center gap-1.5">
                    {preflopVerdict.theme === 'rose' ? (
                      <XCircle className="w-6 h-6 text-rose-400" />
                    ) : (
                      <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                    )}
                    {preflopVerdict.actionLabel}
                  </div>
                </div>
              </div>
              <div className="text-xs font-semibold text-white">{preflopVerdict.headline}</div>
              <div className="text-[11px] font-mono bg-black/40 rounded-lg px-2.5 py-1.5 opacity-90">
                {preflopVerdict.mathLine}
              </div>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 space-y-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                Ajuste Manual en 1 Toque (Sin Re-Escanear)
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { k: 'OPEN_FIRST', l: 'Mano Limpia' },
                    { k: 'VS_OPEN_2BB', l: 'Vs Open 2BB' },
                    { k: 'VS_ALLIN', l: 'Vs All-in' }
                  ] as const
                ).map((item) => (
                  <button
                    key={item.k}
                    onClick={() => setState((p) => ({ ...p, situation: item.k }))}
                    className={`py-1.5 rounded-lg text-[11px] font-bold border ${
                      state.situation === item.k
                        ? 'bg-cyan-700 border-cyan-400 text-white'
                        : 'bg-slate-900 border-slate-800 text-slate-400'
                    }`}
                  >
                    {item.l}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-1.5 text-xs">
                <select
                  value={state.heroRank1}
                  onChange={(e) => setState((p) => ({ ...p, heroRank1: e.target.value }))}
                  className="bg-slate-900 border border-slate-700 rounded-lg p-2 font-black text-white text-center"
                >
                  {RANKS.map((r) => (
                    <option key={`c1-${r}`} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <select
                  value={state.heroRank2}
                  onChange={(e) => setState((p) => ({ ...p, heroRank2: e.target.value }))}
                  className="bg-slate-900 border border-slate-700 rounded-lg p-2 font-black text-white text-center"
                >
                  {RANKS.map((r) => (
                    <option key={`c2-${r}`} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setState((p) => ({ ...p, heroSuited: !p.heroSuited }))}
                  className={`rounded-lg font-bold border ${
                    state.heroSuited
                      ? 'bg-emerald-900/60 border-emerald-500 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-300'
                  }`}
                >
                  {state.heroSuited ? 'Suited' : 'Offsuit'}
                </button>
                <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-lg px-2">
                  <button
                    onClick={() =>
                      setState((p) => ({
                        ...p,
                        effectiveStackBb: Math.max(2, p.effectiveStackBb - 2)
                      }))
                    }
                    className="text-slate-300 font-black px-1"
                  >
                    -
                  </button>
                  <span className="font-bold text-emerald-400 text-[11px]">
                    {state.effectiveStackBb}BB
                  </span>
                  <button
                    onClick={() =>
                      setState((p) => ({
                        ...p,
                        effectiveStackBb: Math.min(40, p.effectiveStackBb + 2)
                      }))
                    }
                    className="text-slate-300 font-black px-1"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] text-slate-400">
                  {state.situation === 'OPEN_FIRST' ? 'Tu Posición:' : 'Posición del Agresor:'}
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {(['UTG_MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const).map((pos) => {
                    const isSelected =
                      state.situation === 'OPEN_FIRST'
                        ? state.heroPosition === pos
                        : state.aggressorPosition === pos;
                    return (
                      <button
                        key={pos}
                        onClick={() =>
                          setState((p) =>
                            p.situation === 'OPEN_FIRST'
                              ? { ...p, heroPosition: pos }
                              : { ...p, aggressorPosition: pos }
                          )
                        }
                        className={`py-1.5 rounded-lg text-[10px] font-bold border ${
                          isSelected
                            ? 'bg-slate-800 border-emerald-400 text-white'
                            : 'bg-slate-900 border-slate-800 text-slate-400'
                        }`}
                      >
                        {pos === 'UTG_MP' ? 'UTG' : pos}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'matrix' && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { k: 'OPEN_FIRST', l: 'Mano Limpia' },
                  { k: 'VS_OPEN_2BB', l: 'Vs Open 2BB' },
                  { k: 'VS_ALLIN', l: 'Vs All-in' }
                ] as const
              ).map((item) => (
                <button
                  key={item.k}
                  onClick={() => setState((p) => ({ ...p, situation: item.k }))}
                  className={`py-2 rounded-xl text-[11px] font-bold border ${
                    state.situation === item.k
                      ? 'bg-emerald-600 border-emerald-400 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  {item.l}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-5 gap-1.5">
              {[25, 18, 12, 9, 5].map((st) => (
                <button
                  key={st}
                  onClick={() => setState((p) => ({ ...p, effectiveStackBb: st }))}
                  className={`py-2 rounded-lg text-xs font-black border ${
                    state.effectiveStackBb === st
                      ? 'bg-slate-800 border-emerald-400 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  {st}BB
                </button>
              ))}
            </div>

            <div className="grid grid-cols-5 gap-1.5">
              {(['UTG_MP', 'HJ', 'CO', 'BTN', 'SB'] as const).map((pos) => {
                const selected =
                  state.situation === 'OPEN_FIRST'
                    ? state.heroPosition === pos
                    : state.aggressorPosition === pos;
                return (
                  <button
                    key={pos}
                    onClick={() =>
                      setState((p) =>
                        p.situation === 'OPEN_FIRST'
                          ? { ...p, heroPosition: pos }
                          : { ...p, aggressorPosition: pos }
                      )
                    }
                    className={`py-1.5 rounded-lg text-xs font-bold border ${
                      selected
                        ? 'bg-cyan-700 border-cyan-400 text-white'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    {pos === 'UTG_MP' ? 'UTG' : pos}
                  </button>
                );
              })}
            </div>

            <div className="bg-slate-950 p-1.5 rounded-xl border border-slate-800">
              <div
                className="grid gap-[2px]"
                style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
              >
                {matrixGrid.map((row) =>
                  row.map((cell) => {
                    let cls = 'bg-slate-900 text-slate-600';
                    if (cell.act === 'ALLIN') cls = 'bg-emerald-600 text-white';
                    else if (cell.act === 'MINRAISE') cls = 'bg-sky-600 text-white';
                    else if (cell.act === 'CALL') cls = 'bg-amber-500 text-black';

                    return (
                      <div
                        key={cell.label}
                        className={`aspect-square flex items-center justify-center rounded-[3px] text-[9px] font-extrabold leading-none ${cls}`}
                      >
                        {cell.label}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-300 mt-2 pt-2 border-t border-slate-800 text-center font-semibold">
                <span>Azul: Abrir 2BB</span>
                <span>Verde: All-in</span>
                <span>Ámbar: Call</span>
                <span>Gris: Fold</span>
              </div>
            </div>
          </div>
        )}

        {tab === 'bankroll' && (
          <div className="space-y-3.5">
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 text-center space-y-2">
              <div className="text-xs uppercase tracking-wider text-slate-400">
                Banca Hyper-Turbo Exacta
              </div>
              <div className="text-4xl font-black text-white">
                {formatUsdFromCents(currentRollCents)}
              </div>
              <div className="text-xs font-bold pt-1">
                {currentRollCents < 7500n ? (
                  <span className="text-rose-400">
                    PROTECCIÓN: Jugá solo Hypers $0.50 - $0.88
                  </span>
                ) : currentRollCents < 18000n ? (
                  <span className="text-emerald-400">
                    NIVEL ACTUAL: Daily Hyper $1.00 / Saver $1.00 (Bloqueado $3/$5)
                  </span>
                ) : currentRollCents < 30000n ? (
                  <span className="text-cyan-400">
                    NIVEL 2: Habilitado Daily Hyper $2.00 + Shots $3.00
                  </span>
                ) : currentRollCents < 50000n ? (
                  <span className="text-indigo-400">
                    NIVEL 3: Instalado en Daily Hyper $3.00
                  </span>
                ) : (
                  <span className="text-amber-300">
                    NIVEL 4 DESBLOQUEADO: Daily Hyper $5.00 Habilitado
                  </span>
                )}
              </div>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3.5 space-y-3">
              <div className="text-xs text-slate-400 font-semibold">Descontar Entrada Hyper</div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { l: '-$0.50', c: -50n },
                  { l: '-$0.88', c: -88n },
                  { l: '-$1.00', c: -100n },
                  { l: '-$2.00', c: -200n }
                ].map((b) => (
                  <button
                    key={b.l}
                    onClick={() => adjustRoll(b.c)}
                    className="py-2.5 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-300 text-xs font-bold active:scale-95"
                  >
                    {b.l}
                  </button>
                ))}
              </div>

              <div className="text-xs text-slate-400 font-semibold pt-1">Sumar Cobro ITM / FT</div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { l: '+$1.80', c: 180n },
                  { l: '+$3.50', c: 350n },
                  { l: '+$8.00', c: 800n },
                  { l: '+$20.00', c: 2000n }
                ].map((b) => (
                  <button
                    key={b.l}
                    onClick={() => adjustRoll(b.c)}
                    className="py-2.5 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-xs font-bold active:scale-95"
                  >
                    {b.l}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => setBankrollCentsStr('10000')}
              className="w-full py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-95"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reiniciar a $100.00
            </button>
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-slate-950/95 backdrop-blur border-t border-slate-800 grid grid-cols-3 p-1.5">
        <button
          onClick={() => setTab('scanner')}
          className={`flex flex-col items-center py-1.5 rounded-xl text-[11px] font-bold ${
            tab === 'scanner' ? 'text-emerald-400 bg-slate-900' : 'text-slate-400'
          }`}
        >
          <Camera className="w-5 h-5 mb-0.5" />
          Escáner
        </button>
        <button
          onClick={() => setTab('matrix')}
          className={`flex flex-col items-center py-1.5 rounded-xl text-[11px] font-bold ${
            tab === 'matrix' ? 'text-emerald-400 bg-slate-900' : 'text-slate-400'
          }`}
        >
          <Grid className="w-5 h-5 mb-0.5" />
          Matriz 13x13
        </button>
        <button
          onClick={() => setTab('bankroll')}
          className={`flex flex-col items-center py-1.5 rounded-xl text-[11px] font-bold ${
            tab === 'bankroll' ? 'text-emerald-400 bg-slate-900' : 'text-slate-400'
          }`}
        >
          <Wallet className="w-5 h-5 mb-0.5" />
          Banca $100
        </button>
      </nav>
    </div>
  );
}
