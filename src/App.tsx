import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Package, 
  Flame,
  Wind,
  Droplets,
  Plane,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Shield,
  Zap,
  Briefcase,
  Trophy,
  Target,
  Gem,
  Database,
  Skull,
  Coins,
  Settings,
  Users,
  RefreshCw
} from 'lucide-react';

// --- Constants ---
const GRID_COLS = 8;
const GRID_ROWS = 36;
const BASE_INITIAL_HP = 110;
const SUIT_COST_PER_STEP = 2; // Fixed at 2% for all difficulties
const TANK_HP_COST = 0; 
const TANK_RECOVERY = 40;
const WEIGHT_PENALTY_THRESHOLD = 3; 

interface VolcanicBomb {
  x: number;
  y: number;
  turnsToImpact: number;
}

interface LastDeath {
  x: number;
  y: number;
  items: {
    scales: number;
    ores: number;
    data: number;
  };
}

interface RankEntry {
  score: number;
  rank: string;
  difficulty: DifficultyType;
  job: string;
  turns: number;
  date: string;
}

interface PersistentState {
  points: number;
  upgrades: {
    hp: number; // +10 per level
    tanks: number; // +1 per 2 levels
    speed: number; // +1 dice floor per 3 levels
  };
  lastDeath: LastDeath | null;
  rankings: RankEntry[];
}

const STORAGE_KEY = 'volcano_survivor_v2';

const getInitialPersistentState = (): PersistentState => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved);
  return {
    points: 0,
    upgrades: { hp: 0, tanks: 0, speed: 0 },
    lastDeath: null,
    rankings: []
  };
};

const savePersistentState = (state: PersistentState) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

// --- Sound Engine ---
let audioCtx: AudioContext | null = null;
let bgmTimer: any = null;
let bgmState = { step: 0, started: false };

const initAudio = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
};

const playSE = (freq: number, type: OscillatorType = 'square', duration = 0.1, volume = 0.05) => {
  try {
    initAudio();
    const ctx = audioCtx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(volume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
};

const playArp = (freqs: number[], type: OscillatorType = 'triangle') => {
  freqs.forEach((f, i) => setTimeout(() => playSE(f, type, 0.2, 0.03), i * 80));
};

const startBGM = () => {
  if (bgmState.started) return;
  bgmState.started = true;
  // Volcanic tension BGM — F minor pentatonic, layered bass + melody + counter
  const bass    = [43.65, 43.65, 48.99, 43.65];            // F1 pedal
  const melody  = [174.61, 196.00, 207.65, 174.61, 196.00, 233.08, 220.00, 174.61]; // F3 minor
  const counter = [261.63, 277.18, 293.66, 261.63];         // F4 harmony
  const pulse = () => {
    if (!bgmState.started) return;
    const s = bgmState.step;
    if (s % 2 === 0) playSE(bass[Math.floor(s / 2) % bass.length], 'sawtooth', 0.32, 0.018);
    playSE(melody[s % melody.length], 'square', 0.11, 0.007);
    if (s % 4 === 0) playSE(counter[Math.floor(s / 4) % counter.length], 'triangle', 0.28, 0.009);
    bgmState.step++;
    bgmTimer = setTimeout(pulse, 185);
  };
  pulse();
};

const playBeep = (freq = 400, duration = 0.08) => {
  startBGM();
  playSE(freq, 'square', duration, 0.05);
};

const playFanfare = () => {
  [523, 659, 784, 1047, 1175, 1319, 1047, 1319].forEach((f, i) =>
    setTimeout(() => playSE(f, 'square', 0.18, 0.06), i * 95)
  );
};

const playDoomSE = () => {
  [220, 196, 175, 156, 131, 110].forEach((f, i) =>
    setTimeout(() => playSE(f, 'sawtooth', 0.55, 0.11), i * 160)
  );
  setTimeout(() => playSE(55, 'sawtooth', 1.2, 0.18), 180);
};

type TileType = 'road' | 'wall' | 'egg' | 'vent' | 'spray' | 'repair_kit' | 'heli' | 'tank' | 'magma' | 'scale' | 'ore' | 'data' | 'remains' | 'gem' | 'document' | 'statue' | 'crystal' | 'cursed' | 'hole' | 'hidden_tank';

const TILE_INFO: Partial<Record<TileType, { name: string; effect: string; color: string }>> = {
  egg:         { name: '🥚 ドラゴンの卵',     effect: 'ミッション目標！拾ったら急いでヘリポートへ戻れ',       color: '#FFD600' },
  heli:        { name: '🚁 ヘリポート',        effect: 'スタート＆脱出地点。卵を持ってここに戻ればクリア！',    color: '#4FC3F7' },
  vent:        { name: '🌬️ 噴気孔',           effect: '通過するとスーツ耐久が追加で減少する危険地帯',         color: '#FF7043' },
  spray:       { name: '💧 水蒸気',           effect: '通過するとスーツ耐久が少し回復するラッキーマス',        color: '#81D4FA' },
  repair_kit:  { name: '🔧 修理キット',       effect: '拾うとスーツ耐久を大きく回復できる',                   color: '#A5D6A7' },
  tank:        { name: '🫁 酸素タンク',       effect: '拾うとタンクを1つ入手。タンクボタンでスーツ回復+40%', color: '#FFB74D' },
  hidden_tank: { name: '🫁 隠し酸素タンク',  effect: '地中に埋まったタンク。地質学者は最初から見える',       color: '#FFB74D' },
  scale:       { name: '🐉 ドラゴンの鱗',    effect: 'サブアイテム。難易度ふつう以上でクリアに必要',          color: '#FFEB3B' },
  ore:         { name: '💎 貴重な鉱石',       effect: 'サブアイテム。難易度ふつう以上でクリアに必要',          color: '#4FC3F7' },
  data:        { name: '📡 調査データ',       effect: 'サブアイテム。難易度ふつう以上でクリアに必要',          color: '#81C784' },
  gem:         { name: '💍 宝石',             effect: '高価値のお宝。持ち帰るとスコアUP（重量小）',           color: '#F48FB1' },
  document:    { name: '📜 古文書',           effect: 'お宝アイテム。持ち帰るとスコアUP',                     color: '#CE93D8' },
  statue:      { name: '🗿 石像',             effect: 'お宝だが重い！持ちすぎると移動歩数にペナルティ',        color: '#BCAAA4' },
  crystal:     { name: '🔮 クリスタル',       effect: 'お宝アイテム。持ち帰るとスコアUP',                     color: '#80DEEA' },
  cursed:      { name: '☠️ 呪いのアイテム',  effect: '拾うとデバフ発生！HPやスーツに悪影響あり',             color: '#EF9A9A' },
  wall:        { name: '🪨 岩壁',             effect: '通過不可。エンジニアのスキルで破壊できる',              color: '#8D6E63' },
  magma:       { name: '🌋 マグマ壁',         effect: '通過不可。ROBOTのスキルで岩場に変換できる',             color: '#FF5722' },
  hole:        { name: '🕳️ 落とし穴',        effect: '通過不可の穴。迂回が必要',                             color: '#424242' },
  remains:     { name: '💀 前回の遺留品',     effect: '前回ゲームオーバーした地点。アイテムが残っている',      color: '#B0BEC5' },
  road:        { name: '🟫 道',               effect: '通れるマス。点滅している場合は不安定で崩れる危険あり',  color: '#795548' },
};

interface Treasure {
  id: string;
  name: string;
  value: number;
  weight: number;
  type: TileType;
}

interface GameResult {
  treasures: Treasure[];
  totalValue: number;
  totalWeight: number;
  hpRemaining: number;
  turnCount: number;
  difficulty: DifficultyType;
  rank: string;
  title: string;
}

interface Tile {
  id: string;
  x: number;
  y: number;
  type: TileType;
  durability?: number;
  magmaCooldown?: number; // Turns until magma cools back to road
  unstable?: boolean;
}

interface LogEntry {
  id: string;
  message: string;
  type: 'info' | 'danger' | 'success' | 'warning';
}

type JobType = 'leader' | 'tech' | 'carrier' | 'scout' | 'robot' | 'treasure_hunter' | 'geologist';
type DifficultyType = 'EASY' | 'NORMAL' | 'HARD' | 'LEGEND';

interface JobDefinition {
  id: JobType;
  name: string;
  role: string;
  description: string;
  difficulty: number; // 1-5
  ability: string;
  recommend: string;
  skillName: string;
  skillText: string;
  color: string;
}

const JOBS: JobDefinition[] = [
  { 
    id: 'leader', 
    name: 'リーダー', 
    role: '高耐久 / 指揮官',
    description: '最大HPが高く、一度だけ致命傷から復活できる。', 
    difficulty: 1,
    ability: '最大HP+30 / HP0時に一度だけ30回復',
    recommend: '安定してクリアしたい初心者向け',
    skillName: '応急処置',
    skillText: 'HPを30回復する（1回のみ）',
    color: '#FF5252' 
  },
  { 
    id: 'tech',
    name: 'エンジニア',
    role: 'エンジニア / フィールド工作員',
    description: 'リソース管理と遠隔バックアップに長けている。', 
    difficulty: 3,
    ability: 'タンク設置コスト半減 / 遠隔タンク投下(1回)',
    recommend: '計画的なリソース管理を楽しみたい人向け',
    skillName: 'デモワーク',
    skillText: '壁の破壊またはタンクを遠隔設置する（1回）',
    color: '#2196F3' 
  },
  { 
    id: 'carrier', 
    name: '軍人', 
    role: '重装歩兵 / 補給スペシャリスト',
    description: '屈強な肉体を持つスペシャリスト。酸素供給に長け、最も多くのタンクを携行できる。', 
    difficulty: 2,
    ability: '初期タンク+2 (合計5個持参) / タンク最大所持数トップ',
    recommend: '酸素切れを恐れず、じっくり探索したい人向け',
    skillName: '予備タンク',
    skillText: '作戦開始時に特別な予備酸素タンクを2つ追加で装備している。',
    color: '#FFEB3B' 
  },
  { 
    id: 'scout',
    name: '登山家',
    role: '高機動 / 登山のプロ',
    description: '山岳地帯を知り尽くしたプロ。圧倒的な機動力で距離を稼ぐ。',
    difficulty: 4,
    ability: 'ダイス目+1 / 毎ターン追加で1歩移動可能',
    recommend: '最速クリアを目指す上級者向け',
    skillName: '精密スキャン',
    skillText: '次回のダイス目を「6」に固定する（1回のみ）',
    color: '#4CAF50' 
  },
  { 
    id: 'robot', 
    name: 'ROBOT', 
    role: '特殊高温環境モデル',
    description: '過酷な熱地帯での任務のために設計された遠隔操作ユニット。', 
    difficulty: 5,
    ability: 'スーツ耐久値150% / 特殊耐熱 / 岩場投下(2回)',
    recommend: '特殊高温環境モデル。マグマ壁を岩場に変えて進路を切り拓く。',
    skillName: '岩場投下',
    skillText: '隣接するマグマ壁を岩場に変換する。（2回まで・手動選択）',
    color: '#90A4AE'
  },
  {
    id: 'treasure_hunter',
    name: 'トレジャーハンター',
    role: '財宝探索 / パルクール',
    description: '秘境を渡り歩くプロの宝探し師。特殊な身体能力で障害物を飛び越える。',
    difficulty: 4,
    ability: 'HP -20 / パルクール(3回) / 障害物を飛び越え2マス先へ着地',
    recommend: '独自ルートを切り開き財宝を効率よく回収したい人向け',
    skillName: 'パルクール',
    skillText: '進行方向の障害物を飛び越え2マス先へ自動着地。移動時に自動発動・3回まで。',
    color: '#C8A96E'
  },
  {
    id: 'geologist',
    name: '地質学者',
    role: '地層調査 / フィールド研究',
    description: '火山地帯のフィールド調査20年のベテラン研究者。地中の異変を感じ取る第六感を持つ。',
    difficulty: 2,
    ability: '隠しタンク位置が最初から見える / 地層スキャン(1回)で全マップ隠しアイテム開示',
    recommend: '隠しアイテムを確実に回収してスコアを伸ばしたい人向け',
    skillName: '地層スキャン',
    skillText: '全マップの隠しアイテムを即座に開示する。1回限り。',
    color: '#F9A825'
  },
];

const TREASURE_DATA: Record<string, { name: string; value: number; weight: number }> = {
  gem: { name: '小さな宝石', value: 1, weight: 1 },
  document: { name: '古文書', value: 4, weight: 1 },
  statue: { name: '黄金の像', value: 12, weight: 3 },
  crystal: { name: '巨大水晶', value: 20, weight: 4 },
  cursed: { name: '呪いの遺物', value: 35, weight: 5 },
};

const GlobalStyles = () => (
  <style dangerouslySetInnerHTML={{ __html: `
    @keyframes magmaFlash {
      0%, 49% { background-color: #CC0000; }
      50%, 100% { background-color: #FF4500; }
    }
    .magma-tile {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; overflow: hidden;
      animation: magmaFlash 1.2s steps(2, start) infinite;
      background-color: #CC0000;
    }
    button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
    .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
  `}} />
);

const PixelHole = React.memo(function PixelHole() {
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center">
      <svg viewBox="0 0 16 16" className="w-full h-full opacity-60" style={{ imageRendering: 'pixelated' }}>
        <rect width="16" height="16" fill="#000" stroke="#3E2723" strokeWidth="0.5" />
        <path d="M2 2 L14 14 M14 2 L2 14" stroke="#D32F2F" strokeWidth="1" opacity="0.3" />
        <rect x="4" y="4" width="8" height="8" fill="#1A110D" opacity="0.5" />
      </svg>
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
    </div>
  );
});

// 8-bit Style Components
const RetroHPBar = ({ hp, maxHp = 100 }: { hp: number, maxHp?: number }) => (
  <div className="w-full flex flex-col gap-1">
    <div className="flex justify-between text-[8px] uppercase text-white font-bold opacity-90">
      <span>Heat Suit Capacity</span>
      <span className={hp < 30 ? 'text-[#FFCC80] animate-pulse' : 'text-white'}>{Math.round(hp)} / {maxHp}</span>
    </div>
    <div className="h-4 w-full bg-[#1A110D] border-2 border-[#FFD600] p-0.5" style={{ imageRendering: 'pixelated' }}>
       <motion.div 
         className="h-full bg-gradient-to-r from-[#D32F2F] to-[#FF5252]" 
         animate={{ width: `${(hp / maxHp) * 100}%` }} 
         transition={{ type: 'spring', damping: 25, stiffness: 100 }}
       />
    </div>
  </div>
);

const PixelCharacter = React.memo(function PixelCharacter({
  isMoving, isReturning, jobColor, jobId
}: { isMoving: boolean; isReturning: boolean; jobColor: string; jobId?: string }) {
  return (
    <motion.div
      animate={isMoving
        ? { y: [-5, 0], scale: [1.12, 1] }
        : isReturning
          ? { rotate: [-3, 3] }
          : { y: 0, scale: 1, rotate: 0 }
      }
      transition={isReturning
        ? { repeat: Infinity, duration: 0.22, ease: 'easeInOut' }
        : { duration: 0.10, ease: 'easeOut' }
      }
      className="w-full h-full flex items-center justify-center p-0.5 relative"
      style={{ willChange: 'transform' }}
    >
      <svg
        viewBox="0 0 16 16"
        className="w-full h-full drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
        style={{ imageRendering: 'pixelated' }}
      >
        {jobId === 'treasure_hunter' ? (
          <g>
            {/* ── FEDORA CROWN (y=0-1) ── */}
            <rect x="5" y="0" width="6" height="1" fill="#4A2A0E" />
            <rect x="4" y="1" width="8" height="1" fill="#7B4A22" />
            <rect x="4" y="1" width="1" height="1" fill="#4A2A0E" />
            <rect x="11" y="1" width="1" height="1" fill="#4A2A0E" />
            <rect x="6" y="1" width="2" height="1" fill="#9B6030" />

            {/* HAT BAND (y=2) */}
            <rect x="4" y="2" width="8" height="1" fill="#150A04" />
            <rect x="10" y="2" width="1" height="1" fill="#FFD700" />

            {/* FULL-WIDTH BRIM (y=3) — icon of the fedora */}
            <rect x="0" y="3" width="16" height="1" fill="#3D1C08" />
            <rect x="1" y="3" width="5" height="1" fill="#5C3418" />

            {/* ── FACE (y=4-7) ── */}
            <rect x="5" y="4" width="6" height="1" fill="#A86838" />
            <rect x="5" y="5" width="6" height="3" fill="#F5A870" />
            <rect x="5" y="5" width="1" height="3" fill="#D08850" />
            <rect x="10" y="5" width="1" height="3" fill="#C88040" />

            {/* SUNGLASSES: frame → left lens+glint → bridge → right lens */}
            <rect x="5" y="5" width="6" height="1" fill="#0A0604" />
            <rect x="6" y="5" width="2" height="1" fill="#1E3016" />
            <rect x="6" y="5" width="1" height="1" fill="#2E4828" />
            <rect x="9" y="5" width="1" height="1" fill="#1E3016" />

            {/* nose + smirk */}
            <rect x="8" y="6" width="1" height="1" fill="#D08850" />
            <rect x="7" y="7" width="3" height="1" fill="#CC7040" />
            <rect x="8" y="7" width="2" height="1" fill="#A03020" />

            {/* ── RED SCARF (y=8) — same width as jacket ── */}
            <rect x="4" y="8" width="8" height="1" fill="#CC2200" />
            <rect x="4" y="8" width="2" height="1" fill="#881500" />

            {/* ── LEATHER JACKET body (y=9-12) ── */}
            <rect x="4" y="9" width="8" height="4" fill="#3A2416" />
            <rect x="4" y="9" width="1" height="4" fill="#5C3C28" />
            <rect x="11" y="9" width="1" height="4" fill="#221408" />

            {/* LEFT ARM highlight / RIGHT ARM shadow */}
            <rect x="2" y="9" width="2" height="4" fill="#3A2416" />
            <rect x="2" y="9" width="1" height="4" fill="#5C3C28" />
            <rect x="12" y="9" width="2" height="4" fill="#3A2416" />
            <rect x="13" y="9" width="1" height="4" fill="#221408" />

            {/* lapels + white shirt + gold badge */}
            <rect x="6" y="9" width="1" height="3" fill="#221408" />
            <rect x="9" y="9" width="1" height="3" fill="#221408" />
            <rect x="7" y="9" width="2" height="2" fill="#E8E0C8" />
            <rect x="5" y="9" width="1" height="1" fill="#FFD700" />

            {/* ── BELT (y=13) + hands ── */}
            <rect x="4" y="13" width="8" height="1" fill="#150A04" />
            <rect x="7" y="13" width="2" height="1" fill="#FFD700" />
            <rect x="2" y="13" width="2" height="1" fill="#F5A870" />
            <rect x="12" y="13" width="2" height="1" fill="#F5A870" />

            {/* ── LEGS (y=14) ── */}
            <rect x="4" y="14" width="3" height="1" fill="#5C3020" />
            <rect x="9" y="14" width="3" height="1" fill="#5C3020" />

            {/* ── BOOTS (y=15) ── */}
            <rect x="4" y="15" width="3" height="1" fill="#150A04" />
            <rect x="9" y="15" width="3" height="1" fill="#150A04" />
            <rect x="5" y="15" width="1" height="1" fill="#3A2010" />
            <rect x="10" y="15" width="1" height="1" fill="#3A2010" />
          </g>
        ) : jobId === 'geologist' ? (
          <g>
            {/* ── FIELD HAT (khaki explorer, same structure as fedora) ── */}
            <rect x="5" y="0" width="6" height="1" fill="#5C4A28" />
            <rect x="4" y="1" width="8" height="2" fill="#8B7050" />
            <rect x="4" y="1" width="1" height="2" fill="#5C4A28" />
            <rect x="11" y="1" width="1" height="2" fill="#5C4A28" />
            <rect x="6" y="1" width="2" height="1" fill="#A89268" />

            {/* Band + gold emblem */}
            <rect x="4" y="3" width="8" height="1" fill="#2A1808" />
            <rect x="10" y="3" width="1" height="1" fill="#C8A030" />

            {/* Full-width brim */}
            <rect x="0" y="4" width="16" height="1" fill="#7A6040" />
            <rect x="1" y="4" width="5" height="1" fill="#9A8060" />

            {/* ── FACE (y=5-8) ── */}
            <rect x="5" y="5" width="6" height="1" fill="#B07040" />
            <rect x="5" y="6" width="6" height="3" fill="#F5A870" />
            <rect x="5" y="6" width="1" height="3" fill="#D08850" />
            <rect x="10" y="6" width="1" height="3" fill="#C88040" />

            {/* Blue-tinted scientific glasses */}
            <rect x="5" y="6" width="6" height="1" fill="#1A2838" />
            <rect x="6" y="6" width="2" height="1" fill="#90C8E8" />
            <rect x="6" y="6" width="1" height="1" fill="#C0E8FF" />
            <rect x="9" y="6" width="2" height="1" fill="#90C8E8" />

            {/* Smirk */}
            <rect x="7" y="8" width="3" height="1" fill="#CC7040" />
            <rect x="8" y="8" width="1" height="1" fill="#882020" />

            {/* ── OLIVE FIELD JACKET (y=9-12) ── */}
            <rect x="5" y="9" width="6" height="1" fill="#3A4830" />

            <rect x="4" y="10" width="8" height="3" fill="#4A6040" />
            <rect x="4" y="10" width="1" height="3" fill="#5C7850" />
            <rect x="11" y="10" width="1" height="3" fill="#38482E" />

            {/* L arm: highlight / R arm: shadow */}
            <rect x="2" y="10" width="2" height="3" fill="#4A6040" />
            <rect x="2" y="10" width="1" height="3" fill="#5C7850" />
            <rect x="12" y="10" width="2" height="3" fill="#4A6040" />
            <rect x="13" y="10" width="1" height="3" fill="#38482E" />

            {/* Lapels + shirt + gold badge */}
            <rect x="6" y="10" width="1" height="2" fill="#38482E" />
            <rect x="9" y="10" width="1" height="2" fill="#38482E" />
            <rect x="7" y="10" width="2" height="2" fill="#E8E0C8" />
            <rect x="5" y="10" width="1" height="1" fill="#C8A030" />

            {/* Chest pocket + yellow pencil */}
            <rect x="5" y="11" width="2" height="2" fill="#38482E" />
            <rect x="5" y="11" width="1" height="1" fill="#F9A825" />

            {/* ── BELT ── */}
            <rect x="4" y="13" width="8" height="1" fill="#2A1808" />
            <rect x="7" y="13" width="2" height="1" fill="#8B6030" />
            <rect x="2" y="13" width="2" height="1" fill="#F5A870" />
            <rect x="12" y="13" width="2" height="1" fill="#F5A870" />

            {/* Rock hammer (right hand) */}
            <rect x="14" y="13" width="1" height="2" fill="#8B5A2A" />
            <rect x="13" y="12" width="2" height="1" fill="#607878" />

            {/* ── LEGS ── */}
            <rect x="4" y="14" width="3" height="1" fill="#546E7A" />
            <rect x="9" y="14" width="3" height="1" fill="#546E7A" />

            {/* ── BOOTS ── */}
            <rect x="4" y="15" width="3" height="1" fill="#1C1008" />
            <rect x="9" y="15" width="3" height="1" fill="#1C1008" />
            <rect x="5" y="15" width="1" height="1" fill="#3A2010" />
            <rect x="10" y="15" width="1" height="1" fill="#3A2010" />
          </g>
        ) : jobColor === '#90A4AE' ? (
          <g>
            <rect x="4" y="3" width="8" height="9" fill="#37474F" />
            <rect x="3" y="4" width="2" height="6" fill="#546E7A" />
            <rect x="11" y="4" width="2" height="6" fill="#546E7A" />
            <path d="M4 2 L12 2 L11 7 L5 7 Z" fill="#263238" />
            <rect x="5" y="1" width="6" height="1" fill="#455A64" />
            {/* Visor: opacity only, no filter (expensive on mobile) */}
            <motion.rect
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ repeat: Infinity, duration: 2.5 }}
              x="5" y="3" width="6" height="2" fill="#00E5FF"
            />
            <rect x="6" y="3" width="2" height="1" fill="white" opacity="0.6" />
            <motion.rect
              animate={{ opacity: [0.2, 0.7, 0.2] }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
              x="7" y="5" width="2" height="4" fill="#00E5FF" opacity="0.5"
            />
            <rect x="2" y="4" width="2" height="2" fill="#90A4AE" />
            <rect x="12" y="4" width="2" height="2" fill="#90A4AE" />
            <rect x="10" y="0" width="1" height="3" fill="#B0BEC5" />
            <rect x="10" y="0" width="1" height="1" fill="#E91E63" />
            <rect x="4" y="12" width="3" height="3" fill="#263238" />
            <rect x="9" y="12" width="3" height="3" fill="#263238" />
            <rect x="4" y="14" width="3" height="1" fill="#455A64" />
            <rect x="9" y="14" width="3" height="1" fill="#455A64" />
            <rect x="5" y="11" width="1" height="2" fill="#78909C" />
            <rect x="10" y="11" width="1" height="2" fill="#78909C" />
          </g>
        ) : (
          <g>
            <rect x="4" y="2" width="8" height="10" fill={jobColor} />
            <rect x="5" y="1" width="6" height="1" fill={jobColor} />
            <rect x="4" y="3" width="8" height="4" fill="#333" />
            <rect x="5" y="4" width="6" height="2" fill="#81D4FA" opacity="0.8" />
            <rect x="9" y="4" width="1" height="1" fill="white" opacity="0.9" />
            <rect x="4" y="12" width="3" height="2" fill="#212121" />
            <rect x="9" y="12" width="3" height="2" fill="#212121" />
            <rect x="2" y="5" width="2" height="5" fill={jobColor} />
            <rect x="12" y="5" width="2" height="5" fill={jobColor} />
            <rect x="2" y="10" width="2" height="2" fill="#E0E0E0" />
            <rect x="12" y="10" width="2" height="2" fill="#E0E0E0" />
          </g>
        )}
        {isReturning && (
          <g>
            <rect x="5" y="5" width="6" height="5" fill="#FFD600" stroke="#FF8F00" strokeWidth="0.5" />
            <rect x="6" y="6" width="1" height="1" fill="white" opacity="0.5" />
          </g>
        )}
      </svg>
    </motion.div>
  );
});

const DICE_PIPS: Record<number, [number, number][]> = {
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[0,2],[2,0],[2,2]],
  5: [[0,0],[0,2],[1,1],[2,0],[2,2]],
  6: [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2]],
};

const DiceFace = ({ value, rolling }: { value: number; rolling: boolean }) => {
  if (rolling) return (
    <div className="w-11 h-11 bg-white rounded-lg flex items-center justify-center border-2 border-gray-200 shadow-inner">
      <span className="text-lg font-black text-gray-400">?</span>
    </div>
  );
  const pips = DICE_PIPS[Math.min(6, Math.max(1, value))] ?? DICE_PIPS[1];
  return (
    <div className="w-11 h-11 bg-white rounded-lg relative shadow-md border-2 border-gray-100 p-1.5">
      <div className="relative w-full h-full">
        {pips.map(([r, c], i) => (
          <div key={i} className="absolute bg-gray-900 rounded-full"
            style={{ width: '27%', height: '27%', top: `${r * 33 + 3}%`, left: `${c * 33 + 3}%` }} />
        ))}
      </div>
    </div>
  );
};

const PixelHeli = ({ size = "w-full h-full" }: { size?: string }) => (
  <motion.div 
    animate={{ y: [0, -2, 0] }} 
    transition={{ repeat: Infinity, duration: 2 }}
    className={`${size} flex items-center justify-center p-0.5`}
  >
    <svg viewBox="0 0 16 16" className="w-full h-full drop-shadow-md" style={{ imageRendering: 'pixelated' }}>
      <motion.rect 
        animate={{ scaleX: [1, 0, 1] }} 
        transition={{ repeat: Infinity, duration: 0.1 }}
        x="2" y="1" width="12" height="1" fill="#E0E0E0" 
      />
      <rect x="7" y="2" width="2" height="1" fill="#9E9E9E" />
      <rect x="4" y="3" width="10" height="6" fill="#00ACC1" />
      <rect x="5" y="4" width="4" height="3" fill="#81D4FA" />
      <rect x="1" y="4" width="4" height="2" fill="#00838F" />
      <rect x="0" y="3" width="1" height="4" fill="#006064" />
      <rect x="4" y="9" width="1" height="2" fill="#424242" />
      <rect x="11" y="9" width="1" height="2" fill="#424242" />
      <rect x="3" y="11" width="11" height="1" fill="#212121" />
    </svg>
  </motion.div>
);

const PixelEgg = ({ size = "w-full h-full" }: { size?: string }) => (
  <motion.div 
    animate={{ scale: [1, 1.05, 1], rotate: [-2, 2, -2] }} 
    transition={{ repeat: Infinity, duration: 3 }}
    className={`${size} flex items-center justify-center p-0.5`}
  >
    <svg viewBox="0 0 16 16" className="w-full h-full drop-shadow-[0_0_8px_rgba(255,214,0,0.6)]" style={{ imageRendering: 'pixelated' }}>
      <path d="M8 1 C5 1 3 4 3 8 C3 12 5 15 8 15 C11 15 13 12 13 8 C13 4 11 1 8 1Z" fill="#FFD600" />
      <rect x="5" y="4" width="2" height="2" fill="white" opacity="0.4" />
      <rect x="6" y="9" width="4" height="3" fill="#FF8F00" opacity="0.3" />
    </svg>
  </motion.div>
);

const PixelGem = ({ color = "#F06292", size = "w-full h-full" }: { color?: string, size?: string }) => (
  <div className={`${size} flex items-center justify-center p-0.5`}>
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <path d="M8 2 L13 7 L8 14 L3 7 Z" fill={color} />
      <path d="M8 2 L11 5 L8 8 L5 5 Z" fill="white" opacity="0.5" />
    </svg>
  </div>
);

const PixelStatue = ({ size = "w-full h-full" }: { size?: string }) => (
  <div className={`${size} flex items-center justify-center p-0.5`}>
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <rect x="4" y="13" width="8" height="2" fill="#795548" />
      <rect x="6" y="12" width="4" height="1" fill="#FFC107" />
      <rect x="5" y="4" width="6" height="8" fill="#FFD600" />
      <rect x="6" y="2" width="4" height="3" fill="#FFD600" />
    </svg>
  </div>
);

const PixelDocument = ({ size = "w-full h-full" }: { size?: string }) => (
  <div className={`${size} flex items-center justify-center p-0.5 rotate-[-5deg]`}>
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <rect x="3" y="2" width="10" height="12" fill="#FFF8E1" />
      <rect x="4" y="4" width="6" height="1" fill="#BDBDBD" />
      <rect x="4" y="7" width="8" height="1" fill="#BDBDBD" />
      <rect x="4" y="10" width="7" height="1" fill="#BDBDBD" />
    </svg>
  </div>
);

const PixelRock = React.memo(function PixelRock() {
  return (
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <rect width="16" height="16" fill="#795548" />
      {/* grain marks */}
      <rect x="2" y="3" width="2" height="1" fill="#5D4037" />
      <rect x="10" y="5" width="3" height="1" fill="#3E2723" />
      <rect x="4" y="10" width="3" height="1" fill="#5D4037" />
      <rect x="12" y="11" width="1" height="2" fill="#3E2723" />
      <rect x="2" y="13" width="4" height="1" fill="#3E2723" />
      <rect x="7" y="2" width="1" height="3" fill="#4A2C20" opacity="0.5" />
      <rect x="13" y="7" width="2" height="1" fill="#5D3020" opacity="0.4" />
      {/* edge highlights for subtle depth */}
      <rect x="0" y="0" width="16" height="1" fill="#8D6E63" opacity="0.25" />
      <rect x="0" y="0" width="1" height="16" fill="#8D6E63" opacity="0.18" />
      <rect x="15" y="0" width="1" height="16" fill="#3E2723" opacity="0.25" />
      <rect x="0" y="15" width="16" height="1" fill="#3E2723" opacity="0.25" />
    </svg>
  );
});

const PixelMagma = React.memo(function PixelMagma() {
  return (
    <div className="magma-tile absolute inset-0">
      <svg
        viewBox="0 0 16 16"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0.85 }}
      >
        {/* lava cracks */}
        <line x1="2" y1="10" x2="6" y2="15" stroke="#FF8F00" strokeWidth="0.6" opacity="0.5" />
        <line x1="9" y1="7"  x2="14" y2="13" stroke="#FF8F00" strokeWidth="0.6" opacity="0.4" />
        <line x1="0" y1="5"  x2="4"  y2="10" stroke="#FF6F00" strokeWidth="0.4" opacity="0.35" />
        {/* glow bubbles */}
        <circle cx="3"  cy="12" r="2.0" fill="#FFF176" />
        <circle cx="8"  cy="13" r="1.6" fill="#FFEE58" />
        <circle cx="13" cy="11" r="1.8" fill="#FFF176" />
        <circle cx="6"  cy="9"  r="1.2" fill="#FFF9C4" />
        <circle cx="11" cy="7"  r="1.1" fill="#FFEE58" />
        <circle cx="1"  cy="15" r="1.0" fill="#FFD740" opacity="0.7" />
      </svg>
    </div>
  );
});

const PixelTank = React.memo(function PixelTank() {
  return (
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <rect x="4" y="3" width="8" height="10" fill="#0288D1" />
      <rect x="5" y="2" width="6" height="2" fill="#B3E5FC" />
      <rect x="7" y="1" width="2" height="1" fill="#455A64" />
      <rect x="5" y="5" width="6" height="1" fill="#01579B" opacity="0.4" />
      <rect x="5" y="8" width="6" height="1" fill="#01579B" opacity="0.4" />
      <rect x="6" y="4" width="1" height="2" fill="white" opacity="0.6" />
    </svg>
  );
});

const PixelBombMark = ({ turns }: { turns: number }) => (
   <motion.div
     initial={{ scale: 0.5, opacity: 0 }}
     animate={{ scale: [1, 1.2, 1], opacity: turns <= 1 ? [0.8, 1, 0.8] : [0.5, 0.9, 0.5] }}
     transition={{ repeat: Infinity, duration: turns <= 1 ? 0.4 : 1 }}
     className={`absolute inset-0 flex items-center justify-center p-1 ${turns <= 1 ? 'bg-red-600/40' : 'bg-orange-600/20'}`}
   >
     <div className={`w-full h-full border-2 ${turns <= 1 ? 'border-red-400 border-solid' : 'border-dashed border-[#FFEB3B]'} rounded-full flex items-center justify-center`}>
       <span className="text-[8px] font-black text-white drop-shadow-[0_0_2px_#000]">{turns}</span>
     </div>
   </motion.div>
);

const PixelSpray = () => (
  <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
    <rect x="6" y="5" width="4" height="9" fill="#78909C" />
    <rect x="6" y="3" width="4" height="2" fill="#CFD8DC" />
    <rect x="7" y="2" width="2" height="1" fill="#455A64" />
    <motion.path 
       animate={{ opacity: [0, 0.8, 0], scale: [0.8, 1.2, 0.8] }}
       transition={{ repeat: Infinity, duration: 1 }}
       d="M10 2 C12 0 16 2 13 4" fill="none" stroke="#B3E5FC" strokeWidth="1" 
    />
  </svg>
);

const PixelRepairKit = () => (
  <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
    {/* body */}
    <rect x="4" y="6" width="8" height="8" fill="#E65100" />
    <rect x="4" y="5" width="8" height="2" fill="#FF8F00" />
    {/* handle */}
    <rect x="6" y="3" width="4" height="3" fill="#BF360C" />
    <rect x="7" y="2" width="2" height="1" fill="#7B2809" />
    {/* cross symbol */}
    <rect x="7" y="7" width="2" height="6" fill="#FFF9C4" opacity="0.9" />
    <rect x="5" y="9" width="6" height="2" fill="#FFF9C4" opacity="0.9" />
    {/* heat shimmer dot */}
    <rect x="11" y="4" width="1" height="1" fill="#FFCC02" opacity="0.8" />
  </svg>
);

const PixelCrystal = () => (
  <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
    <path d="M8 1 L12 5 L12 11 L8 15 L4 11 L4 5 Z" fill="#4DD0E1" />
    <path d="M8 3 L10 6 L8 13 L6 6 Z" fill="white" opacity="0.6" />
    <path d="M4 5 L8 8 L4 11 Z" fill="black" opacity="0.1" />
  </svg>
);

const PixelCursed = () => (
  <motion.div
    animate={{ rotate: [-5, 5, -5] }}
    transition={{ repeat: Infinity, duration: 2 }}
    className="w-full h-full"
  >
    <svg viewBox="0 0 16 16" className="w-full h-full" style={{ imageRendering: 'pixelated' }}>
      <rect x="4" y="2" width="8" height="4" fill="#BA68C8" />
      <rect x="3" y="6" width="10" height="7" fill="#7B1FA2" />
      <rect x="5" y="8" width="2" height="2" fill="black" />
      <rect x="9" y="8" width="2" height="2" fill="black" />
      <rect x="6" y="11" width="4" height="1" fill="black" />
      <rect x="7" y="1" width="2" height="1" fill="#EA80FC" />
    </svg>
  </motion.div>
);

const CountUpNumber = React.memo(function CountUpNumber({ target, delay = 0 }: { target: number; delay?: number }) {
  const [count, setCount] = React.useState(0);
  const [started, setStarted] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setStarted(true), delay); return () => clearTimeout(t); }, [delay]);
  React.useEffect(() => {
    if (!started) return;
    if (target === 0) { setCount(0); return; }
    const duration = 1100;
    const begin = performance.now();
    let id: number;
    const tick = (now: number) => {
      const p = Math.min((now - begin) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setCount(Math.floor(target * eased));
      if (p < 1) id = requestAnimationFrame(tick); else setCount(target);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [started, target]);
  return <>{count}</>;
});

const RANK_ORDER = ['D', 'C', 'B', 'A', 'S'];
const RankReveal = React.memo(function RankReveal({ rank, won }: { rank: string; won: boolean }) {
  const [displayed, setDisplayed] = React.useState('?');
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    const idx = RANK_ORDER.indexOf(rank);
    const seq = [...RANK_ORDER.slice(0, idx + 1), ...RANK_ORDER.slice(0, idx).reverse(), rank];
    let i = 0;
    const tick = () => {
      if (i >= seq.length) { setDisplayed(rank); setSettled(true); return; }
      setDisplayed(seq[i]);
      playSE(280 + i * 90, 'square', 0.05, 0.03);
      i++;
      setTimeout(tick, i < seq.length - 2 ? 75 : 210);
    };
    const t = setTimeout(tick, 550);
    return () => clearTimeout(t);
  }, [rank]);
  return (
    <span className={`text-[64px] font-black leading-none italic tracking-tighter transition-colors duration-300 ${settled ? (won ? 'text-white' : 'text-gray-500') : 'text-[#FFD600]'}`}>
      {displayed}
    </span>
  );
});

const getRequiredSubItems = (diff: DifficultyType): number => {
  if (diff === 'EASY') return 0;
  if (diff === 'NORMAL') return 1;
  if (diff === 'HARD') return 2;
  return 3;
};

export default function App() {
  // --- State ---
  const [persistent, setPersistent] = useState<PersistentState>(getInitialPersistentState());
  const [difficulty, setDifficulty] = useState<DifficultyType>('NORMAL');

  // --- Map Generation ---
  const initialMap = useMemo(() => {
    const generate = () => {
      const map: Tile[] = [];
      const unstableRate = difficulty === 'LEGEND' ? 0.50 : difficulty === 'HARD' ? 0.40 : difficulty === 'NORMAL' ? 0.28 : 0.15;

      for (let y = 0; y < GRID_ROWS; y++) {
        for (let x = 0; x < GRID_COLS; x++) {
          let type: TileType = 'road';
          let unstable = false;

          // Fixed points
          if (x === 0 && y === GRID_ROWS - 1) type = 'heli';
          else if (x === GRID_COLS - 1 && y === 0) type = 'egg';
          else {
            const rand = Math.random();
            if (rand < 0.12) type = 'wall';
            else if (rand < 0.14) type = 'vent';
            else if (rand < 0.161) type = 'spray';
            else if (rand < 0.17) type = 'repair_kit';
            else if (rand < 0.18) type = 'scale';
            else if (rand < 0.19) type = 'ore';
            else if (rand < 0.195) type = 'data';
            else if (rand < 0.20) type = 'gem';
            else if (rand < 0.21) type = 'document';
            else if (rand < 0.215) type = 'statue';
            else if (rand < 0.22) type = 'crystal';
            else if (rand < 0.225) type = 'cursed';
            
            // Unstable logic (Only on roads, not safe zones)
            if (type === 'road') {
              const isSafeZone = (Math.abs(x - 0) + Math.abs(y - (GRID_ROWS - 1)) <= 2) || // Near Start
                                 (x === 0 && y === GRID_ROWS - 1) || 
                                 (x === GRID_COLS - 1 && y === 0);
              
              if (!isSafeZone && Math.random() < unstableRate) {
                unstable = true;
              }
            }
          }

          if (persistent.lastDeath && x === persistent.lastDeath.x && y === persistent.lastDeath.y) {
            type = 'remains';
          }

          map.push({ id: `${x}-${y}`, x, y, type, unstable });
        }
      }
      return map;
    };

    // Path safety validation
    const hasPath = (map: Tile[]) => {
      const check = (sx: number, sy: number, gx: number, gy: number) => {
        const q: {x: number, y: number}[] = [{x: sx, y: sy}];
        const visited = new Set([`${sx},${sy}`]);
        const blockers = new Set(map.filter(t => t.type === 'wall' || t.unstable).map(t => `${t.x},${t.y}`));
        while(q.length > 0) {
          const {x, y} = q.shift()!;
          if (x === gx && y === gy) return true;
          for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
            const nx = x + dx, ny = y + dy;
            const key = `${nx},${ny}`;
            if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS && !blockers.has(key) && !visited.has(key)) {
              visited.add(key);
              q.push({x: nx, y: ny});
            }
          }
        }
        return false;
      };
      return check(0, GRID_ROWS - 1, GRID_COLS - 1, 0) && check(GRID_COLS - 1, 0, 0, GRID_ROWS - 1);
    };

    let attempts = 0;
    let finalMap = generate();
    while(!hasPath(finalMap) && attempts < 50) {
      finalMap = generate();
      attempts++;
    }

    // Place 2 hidden tanks on random road tiles (all difficulties)
    const candidateTiles = finalMap.filter(t =>
      t.type === 'road' && !t.unstable &&
      !(t.x === 0 && t.y === GRID_ROWS - 1) &&
      !(t.x === GRID_COLS - 1 && t.y === 0)
    );
    for (let i = candidateTiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidateTiles[i], candidateTiles[j]] = [candidateTiles[j], candidateTiles[i]];
    }
    candidateTiles.slice(0, 2).forEach(ht => {
      const idx = finalMap.findIndex(t => t.id === ht.id);
      if (idx !== -1) finalMap[idx] = { ...finalMap[idx], type: 'hidden_tank' };
    });

    return finalMap;
  }, [persistent.lastDeath, difficulty]);

  // --- Other State ---
  const [showBriefing, setShowBriefing] = useState(true);
  const [selectedJob, setSelectedJob] = useState<JobType | null>(null);
  const [tiles, setTiles] = useState<Tile[]>(initialMap);
  const [playerPos, setPlayerPos] = useState({ x: 0, y: GRID_ROWS - 1 });
  const [hp, setHp] = useState(BASE_INITIAL_HP);
  const [maxHp, setMaxHp] = useState(BASE_INITIAL_HP);
  const [suitCondition, setSuitCondition] = useState(100);
  const [isSettingTank, setIsSettingTank] = useState(false);
  const [eggs, setEggs] = useState(0);
  const [inventory, setInventory] = useState({
    scales: 0,
    ores: 0,
    data: 0,
    treasures: [] as Treasure[]
  });
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [lavaLevel, setLavaLevel] = useState(GRID_ROWS);
  const [turnCount, setTurnCount] = useState(0);
  const [lastBaseRoll, setLastBaseRoll] = useState<number | null>(null);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isRolling, setIsRolling] = useState(false);
  const [visualRoll, setVisualRoll] = useState(1);
  const [gameState, setGameState] = useState<'playing' | 'won' | 'lost'>('playing');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stepsRemaining, setStepsRemaining] = useState(0);
  const [isMoving, setIsMoving] = useState(false);
  const [lavaRising, setLavaRising] = useState(false);
  const [centralMessage, setCentralMessage] = useState<string | null>(null);
  const [tankInventory, setTankInventory] = useState(3);
  const [maxTanks, setMaxTanks] = useState(3);
  const [bombs, setBombs] = useState<VolcanicBomb[]>([]);
  const bombMap = useMemo(() => {
    const m = new Map<string, VolcanicBomb>();
    bombs.forEach(b => m.set(`${b.x},${b.y}`, b));
    return m;
  }, [bombs]);
  const [showDropModal, setShowDropModal] = useState(false);
  const [showSystemMenu, setShowSystemMenu] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);
  const [tilePopup, setTilePopup] = useState<{ name: string; effect: string; color: string } | null>(null);
  const tilePopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoPath, setAutoPath] = useState<{x: number, y: number}[]>([]);
  const [showRanking, setShowRanking] = useState(false);
  const [skillAvailable, setSkillAvailable] = useState(true);
  const [skillActiveTurns, setSkillActiveTurns] = useState(0);
  const [scoutFixedRoll, setScoutFixedRoll] = useState(false);
  const [isTechSkillActive, setIsTechSkillActive] = useState(false);
  const [heliTurnsLeft, setHeliTurnsLeft] = useState<number | null>(null);
  const [isHeatwave, setIsHeatwave] = useState(false);
  const [isSmoke, setIsSmoke] = useState(false);
  const [safeTurns, setSafeTurns] = useState(0);

  // --- Job-Specific State ---
  const [hasLeaderLife, setHasLeaderLife] = useState(true);
  const [hasRemoteTankSkill, setHasRemoteTankSkill] = useState(true);
  const [scoutExtraStepAvailable, setScoutExtraStepAvailable] = useState(false);
  const [robotJumpUses, setRobotJumpUses] = useState(2);
  const [isRobotConvertActive, setIsRobotConvertActive] = useState(false);
  const [treasureHunterJumpUses, setTreasureHunterJumpUses] = useState(3);
  const [geologistScanUsed, setGeologistScanUsed] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);

  const maxSuit = selectedJob === 'robot' ? 150 : 100;

  // --- Initialize Job ---
  const selectJob = (job: JobType) => {
    setSelectedJob(job);
    setSkillAvailable(true);
    setSkillActiveTurns(0);
    setScoutFixedRoll(false);
    setIsTechSkillActive(false);
    setHeliTurnsLeft(null);

    // Reset Job Perks
    setHasLeaderLife(true);
    setHasRemoteTankSkill(true);
    setScoutExtraStepAvailable(false);
    setRobotJumpUses(2);
    setTreasureHunterJumpUses(3);
    setGeologistScanUsed(false);

    let startHp = BASE_INITIAL_HP + (persistent.upgrades.hp * 10);
    let startTanks = 3 + Math.floor(persistent.upgrades.tanks / 2);

    if (job === 'leader') {
      startHp += 30;
    }
    if (job === 'treasure_hunter') {
      startHp -= 20;
    }
    if (job === 'tech') {
      startTanks += 1;
    }
    if (job === 'carrier') {
      startTanks += 2;
    }
    
    setHp(startHp);
    setMaxHp(startHp);
    setSuitCondition(job === 'robot' ? 150 : 100);
    setTankInventory(startTanks);
    setMaxTanks(startTanks);
    addLog(`ミッション開始: ${JOBS.find(j => j.id === job)?.name || '調査員'} 装備オンライン`, 'success');
    playBeep(600, 0.2);
  };

  // --- Handlers ---
  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    setLogs(prev => [{ id, message, type }, ...prev].slice(0, 8));
  }, []);

  // Auto-scrolling to player
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [playerPos]);

  const getTileAt = useCallback((x: number, y: number) => {
    return tiles.find(t => t.x === x && t.y === y);
  }, [tiles]);

  const inventoryWeight = useMemo(() => {
    // Egg=2, Ore=1, Scale=1, Data=1, Treasure=TREASURE_DATA.weight
    const allWeights = [
      ...Array(eggs).fill(2),
      ...Array(inventory.ores).fill(1),
      ...Array(inventory.scales).fill(1),
      ...Array(inventory.data).fill(1),
      ...inventory.treasures.map(t => t.weight)
    ].sort((a, b) => b - a);

    let itemsToIgnore = 0;
    if (skillActiveTurns > 0) itemsToIgnore = 999;

    const calculatedWeight = allWeights.reduce((sum, w, idx) => {
      if (idx < itemsToIgnore) return sum;
      return sum + w;
    }, 0);

    return calculatedWeight;
  }, [eggs, inventory, selectedJob, skillActiveTurns]);

  const uniqueSubItemTypes = useMemo(() => {
    const types = new Set<string>();
    if (inventory.ores > 0) types.add('ore');
    if (inventory.scales > 0) types.add('scale');
    if (inventory.data > 0) types.add('data');
    inventory.treasures.forEach(t => types.add(t.type));
    return types.size;
  }, [inventory]);

  const getHazardLevel = useCallback((x: number, y: number) => {
    let level: 'none' | 'heat' | 'magma' = 'none';
    const adjacentCoords = [[0,1],[0,-1],[1,0],[-1,0]];
    
    for (const [dx, dy] of adjacentCoords) {
      const nx = x + dx, ny = y + dy;
      const tile = getTileAt(nx, ny);
      if (tile?.type === 'magma' || ny >= lavaLevel) {
        level = 'magma';
        break; 
      }
      if (bombs.some(b => b.x === nx && b.y === ny)) {
        level = 'heat';
      }
    }
    return level;
  }, [getTileAt, lavaLevel, bombs]);

  const inventoryValue = useMemo(() => {
    const baseValue = (eggs * 100) + (inventory.ores * 30) + (inventory.scales * 10) + (inventory.data * 20);
    const treasureValue = inventory.treasures.reduce((sum, t) => sum + t.value * 20, 0); 
    return baseValue + treasureValue;
  }, [eggs, inventory]);

  const [lastRollDetails, setLastRollDetails] = useState<{
    raw: number,
    weightPenalty: number,
    jobBonus: number,
    final: number
  } | null>(null);

  const dropItem = (type: 'egg' | 'ores' | 'scales' | 'data' | 'treasure', index?: number) => {
    if (type === 'egg') {
      if (!window.confirm('ドラゴンの卵を捨てますか？ (ミッション失敗となります)')) return;
      setEggs(0);
      setHeliTurnsLeft(null);
      addLog('卵を破棄！ヘリポートは解放待機状態に...', 'warning');
    } else if (type === 'ores') {
      setInventory(prev => ({ ...prev, ores: Math.max(0, prev.ores - 1) }));
      addLog('鉱石を1つ捨てました。', 'warning');
    } else if (type === 'scales') {
      setInventory(prev => ({ ...prev, scales: Math.max(0, prev.scales - 1) }));
      addLog('鱗を1つ捨てました。', 'warning');
    } else if (type === 'data') {
      setInventory(prev => ({ ...prev, data: Math.max(0, prev.data - 1) }));
      addLog('データセットを1つ捨てました。', 'warning');
    } else if (type === 'treasure' && index !== undefined) {
      setInventory(prev => {
        const newTreasures = [...prev.treasures];
        const dropped = newTreasures.splice(index, 1)[0];
        addLog(`${dropped.name}を捨てました。重量が減少。`, 'warning');
        return { ...prev, treasures: newTreasures };
      });
    }
    playBeep(200, 0.1);
  };

  const handleTileEffect = useCallback((x: number, y: number) => {
    const tile = getTileAt(x, y);
    if (!tile) return;

    switch (tile.type) {
      case 'egg':
        if (eggs === 0) {
          setEggs(1);
          addLog('ドラゴンの卵を確保！', 'danger');
          setCentralMessage('ドラゴンの卵を確保！\n火山活動が激化！脱出しろ！');
          setTimeout(() => setCentralMessage(null), 1800);
          playBeep(800, 0.2);
          setStepsRemaining(0); 

          // Remove the egg from the map visually
          setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));

          setSafeTurns(2); // 2 turns of safety after egg pickup

          // Calculate Heli Timer
          const distToHeli = Math.abs(tile.x - 0) + Math.abs(tile.y - (GRID_ROWS - 1));
          const diffMod = difficulty === 'EASY' ? 10 : difficulty === 'NORMAL' ? 5 : difficulty === 'HARD' ? 0 : -5;
          const timer = Math.ceil(distToHeli + inventoryWeight + diffMod + 10); // Generous buffer
          setHeliTurnsLeft(timer);
          addLog(`救助ヘリは${timer}ターン後に離陸する`, 'warning');
          
          addLog('火山活動が激化した！', 'danger');
          
          // Intensify instability: add new unstable tiles
          setTiles(prev => prev.map(t => {
            if (t.type !== 'road' || t.unstable) return t;
            // Safe zone check (near start/heli or near current pos to not trap immediately)
            const isNearStart = (Math.abs(t.x - 0) + Math.abs(t.y - (GRID_ROWS - 1)) <= 1);
            const isNearPlayer = (Math.abs(t.x - x) + Math.abs(t.y - y) <= 1);
            if (!isNearStart && !isNearPlayer && Math.random() < 0.12) {
              return { ...t, unstable: true };
            }
            return t;
          }));
        }
        break;
      case 'scale':
        setInventory(prev => ({ ...prev, scales: prev.scales + 1 }));
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        addLog('ドラゴンの鱗を発見！（換金用材料）', 'success');
        playBeep(700, 0.1);
        break;
      case 'ore':
        setInventory(prev => ({ ...prev, ores: prev.ores + 1 }));
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        addLog('貴重な鉱石を採取！（重量があるが高価値）', 'success');
        playBeep(650, 0.1);
        break;
      case 'data':
        setInventory(prev => ({ ...prev, data: prev.data + 1 }));
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        addLog('調査データを解析！（軽量・ボーナス）', 'success');
        playBeep(900, 0.1);
        break;
      case 'gem':
      case 'document':
      case 'statue':
      case 'crystal':
      case 'cursed': {
        const tData = TREASURE_DATA[tile.type];
        if (tData) {
          const tId = `tr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
          setInventory(prev => ({
            ...prev,
            treasures: [...prev.treasures, {
              id: tId,
              name: tData.name,
              value: tData.value,
              weight: tData.weight,
              type: tile.type
            }]
          }));
          setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
          addLog(`${tData.name}を確保！（価値:${tData.value} 重さ:${tData.weight}）`, 'success');
          if (tile.type === 'cursed') {
            addLog('不穏な気配が漂う...（爆弾の頻度が増加）', 'danger');
          }
          playBeep(700, 0.1);
        }
        break;
      }
      case 'remains':
        if (persistent.lastDeath) {
           addLog('先遣隊の遺体を発見... 回収に成功した。', 'warning');
           setInventory(prev => ({
             ...prev,
             scales: prev.scales + (persistent.lastDeath?.items.scales || 0),
             ores: prev.ores + (persistent.lastDeath?.items.ores || 0),
             data: prev.data + (persistent.lastDeath?.items.data || 0),
           }));
           setHp(prev => Math.min(maxHp, prev + 30));
           setTankInventory(prev => Math.min(maxTanks, prev + 1));
           setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
           playBeep(400, 0.4);
        }
        break;
      case 'tank':
        setSuitCondition(prev => Math.min(maxSuit, prev + 25));
        setHp(prev => Math.min(maxHp, prev + 5));
        setTiles(prev => {
          const targetTank = prev.find(t => t.id === tile.id);
          if (targetTank && (targetTank.durability ?? 1) > 1) {
            addLog('冷却タンク：スーツ+25% HP+5（残量減少）', 'success');
            return prev.map(t => t.id === tile.id ? { ...t, durability: (t.durability ?? 1) - 1 } : t);
          } else {
            addLog('タンク空：冷却完了、タンクは破壊された', 'warning');
            return prev.map(t => t.id === tile.id ? { ...t, type: 'road', durability: undefined } : t);
          }
        });
        playBeep(600, 0.1);
        break;
      case 'hidden_tank': {
        const recovery = Math.floor(maxSuit * 0.3);
        setSuitCondition(prev => Math.min(maxSuit, prev + recovery));
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        addLog('かつての調査隊が遺した予備タンクを発見！耐熱スーツの機能が30%回復した！', 'success');
        playArp([440, 554, 659, 880]);
        break;
      }
      case 'spray':
        if (suitCondition > 0) {
          setSuitCondition(prev => Math.max(0, prev - 20));
          addLog('冷却スプレー：スーツ耐久-20（スーツに刺激が強すぎた）', 'danger');
          playBeep(200, 0.15);
        } else {
          setHp(prev => Math.min(maxHp, prev + 30));
          addLog('冷却スプレー：HP+30（素肌に直接噴射！）', 'success');
          playBeep(500, 0.1);
        }
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        break;
      case 'repair_kit': {
        const newHp = hp - 20;
        setSuitCondition(prev => Math.min(maxSuit, prev + 40));
        setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road' } : t));
        if (newHp <= 0) {
          setHp(0);
          addLog('リペアキットを使用：スーツを緊急補修したが、体に負担がかかった！', 'warning');
          playBeep(300, 0.2);
          handleDeath('リペアキットの副作用で限界を超えた...');
        } else {
          setHp(newHp);
          addLog('リペアキットを使用：スーツを緊急補修したが、体に負担がかかった！', 'warning');
          playArp([500, 400, 350]);
        }
        break;
      }
      case 'vent':
        const isUp = Math.random() < 0.7;
        addLog(isUp ? '蒸気噴出！上空へ吹き飛ばされた！' : '乱気流！地面へ叩きつけられた...', isUp ? 'warning' : 'danger');
        setCentralMessage(isUp ? '上昇気流！' : '下降気流！？');
        setTimeout(() => setCentralMessage(null), 800);
        playBeep(isUp ? 300 : 150, 0.2);
        
        setTimeout(() => {
          let targets = tiles.filter(t => t.type === 'road' && (isUp ? t.y < y : t.y > y) && t.y < lavaLevel);
          if (targets.length === 0) {
            targets = tiles.filter(t => t.type === 'road' && (isUp ? t.y > y : t.y < y) && t.y < lavaLevel);
          }
          if (targets.length > 0) {
            const dest = targets[Math.floor(Math.random() * targets.length)];
            setPlayerPos({ x: dest.x, y: dest.y });
          }
        }, 300);
        break;
      case 'heli': {
        // Refill tanks when reaching HCP
        if (tankInventory < maxTanks) {
          setTankInventory(maxTanks);
          addLog('ヘリポートに帰還：タンクを補充！', 'success');
          setCentralMessage('タンク補充完了！');
          setTimeout(() => setCentralMessage(null), 1000);
        }

        // Egg is always required
        if (eggs === 0) {
          addLog('卵がない！ドラゴンの卵を確保してから脱出しろ！', 'danger');
          break;
        }

        // Sub-item quota check
        const required = getRequiredSubItems(difficulty);
        const currentSubTypes = (() => {
          const types = new Set<string>();
          if (inventory.ores > 0) types.add('ore');
          if (inventory.scales > 0) types.add('scale');
          if (inventory.data > 0) types.add('data');
          inventory.treasures.forEach(t => types.add(t.type));
          return types.size;
        })();

        if (currentSubTypes < required) {
          const shortfall = required - currentSubTypes;
          addLog(`まだお宝が足りない！最低でもあと${shortfall}種類は必要だ！`, 'danger');
          break;
        }

        setGameState('won');
        setIsGameOver(true);
        addLog('救助成功：卵とお宝を回収した！', 'success');

        // Score: floor(totalItemValue × diffMult) + remainingHP
        const diffMult = difficulty === 'EASY' ? 1.0 : difficulty === 'NORMAL' ? 1.2 : difficulty === 'HARD' ? 1.5 : 2.0;
        const totalItemValue = (eggs * 100) + (inventory.ores * 30) + (inventory.scales * 10) + (inventory.data * 20)
          + inventory.treasures.reduce((sum, t) => sum + t.value * 20, 0);
        const finalScore = Math.floor(totalItemValue * diffMult) + Math.round(hp);

        const calculateRank = (score: number) => {
          if (score >= 600) return 'S';
          if (score >= 350) return 'A';
          if (score >= 200) return 'B';
          if (score >= 80) return 'C';
          return 'D';
        };

        const calculateTitle = (score: number) => {
          const rk = calculateRank(score);
          if (rk === 'S') return '火山の覇者';
          if (rk === 'A') return 'エリート登山家';
          if (rk === 'B') return '熟練の調査員';
          if (rk === 'C') return '生存者';
          return '新人調査員';
        };

        const result: Omit<GameResult, 'rank' | 'title'> = {
          treasures: inventory.treasures,
          totalValue: finalScore,
          totalWeight: inventoryWeight,
          hpRemaining: Math.round(hp),
          turnCount: turnCount,
          difficulty: difficulty,
        };

        setGameResult({
          ...result,
          rank: calculateRank(finalScore),
          title: calculateTitle(finalScore)
        });

        const newEntry: RankEntry = {
          score: finalScore,
          rank: calculateRank(finalScore),
          difficulty,
          job: selectedJob ?? 'leader',
          turns: turnCount,
          date: new Date().toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        };
        const updatedRankings = [...(persistent.rankings ?? []), newEntry]
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        const newState = { ...persistent, points: persistent.points + finalScore, rankings: updatedRankings };
        setPersistent(newState);
        savePersistentState(newState);
        playFanfare();
        setCentralMessage('【ミッション完了】\n卵の確保に成功した！');
        break;
      }
    }
  }, [getTileAt, tiles, eggs, inventory, difficulty, inventoryWeight, hp, tankInventory, maxTanks, turnCount, persistent, addLog]);

  const rollDice = useCallback(async () => {
    if (isGameOver || isMoving || stepsRemaining > 0 || isRolling) return;
    
    setIsRolling(true);
    setIsRobotConvertActive(false);
    startBGM();
    setScoutExtraStepAvailable(selectedJob === 'scout'); // Reset extra step for Scout
    playSE(1000, 'square', 0.05, 0.05); // Pip
    setTimeout(() => playSE(1200, 'square', 0.05, 0.05), 100);
    setTimeout(() => playSE(1400, 'square', 0.05, 0.05), 200);

    // Dice animation loop
    const rollDuration = 250;
    const startTime = Date.now();
    const animInterval = setInterval(() => {
      setVisualRoll(Math.floor(Math.random() * 6) + 1);
      if (Date.now() - startTime > rollDuration) {
        clearInterval(animInterval);
      }
    }, 30);

    await new Promise(resolve => setTimeout(resolve, rollDuration));

    let rawRoll = Math.floor(Math.random() * 6) + 1;
    if (scoutFixedRoll) {
      rawRoll = 6;
      setScoutFixedRoll(false);
      addLog('登山家：精密スキャン（出目を6に固定）', 'success');
    }
    setIsRolling(false);

    // Calculate Bonuses
    let jobBonus = selectedJob === 'scout' ? 1 : 0;

    // Weight Penalty: -1 step per 2 units of weight, max -3
    const weightPenaltyVal = Math.min(3, Math.floor(inventoryWeight / 2));

    // Final Calculation: min 1 guaranteed
    const finalSteps = Math.max(1, rawRoll + jobBonus - weightPenaltyVal);

    // Dice face shows final steps (not raw roll) so players aren't confused
    setVisualRoll(Math.min(6, finalSteps));

    setLastRollDetails({
      raw: rawRoll,
      weightPenalty: weightPenaltyVal,
      jobBonus,
      final: finalSteps
    });

    if (weightPenaltyVal > 0) {
      addLog(`荷物ペナルティ：-${weightPenaltyVal}（重量${inventoryWeight}）`, 'warning');
    }

    setStepsRemaining(finalSteps);
    addLog(`移動：${finalSteps} (出目:${rawRoll} 職能:${jobBonus} 荷物:-${weightPenaltyVal})`, 'info');
    playBeep(200, 0.05);

    const nextTurn = turnCount + 1;
    setTurnCount(nextTurn);

    if (heliTurnsLeft !== null) {
      const remaining = heliTurnsLeft - 1;
      setHeliTurnsLeft(remaining);
      if (remaining <= 0) {
        setGameState('lost');
        setIsGameOver(true);
        addLog('救助ヘリが出発！ミッション失敗。', 'danger');
        setCentralMessage('タイムアップ：ヘリ離陸！');
      } else if (remaining <= 3) {
        addLog(`警告：あと${remaining}ターンでヘリが離陸！`, 'danger');
        playBeep(300, 0.2);
      }
    }

    // --- Magma Cooling Logic ---
    setTiles(prev => prev.map(t => {
      if (t.type === 'magma' && t.magmaCooldown !== undefined) {
        const nextCooldown = t.magmaCooldown - 1;
        if (nextCooldown <= 0) {
          return { ...t, type: 'road', magmaCooldown: undefined };
        }
        return { ...t, magmaCooldown: nextCooldown };
      }
      return t;
    }));

    // --- Disaster Phase Logic ---
    const hasCursed = inventory.treasures.some(t => t.type === 'cursed');
    
    // Handle safe turns (no disasters)
    if (safeTurns > 0) {
      setSafeTurns(prev => prev - 1);
      setBombs([]);
      setIsHeatwave(false);
      setIsSmoke(false);
      return;
    }

    setIsHeatwave(false);
    setIsSmoke(false);

    // Resolve existing bomb impacts
    const survivingBombs: VolcanicBomb[] = [];
    let impactedTiles: {x: number, y: number}[] = [];

    bombs.forEach(b => {
      if (b.turnsToImpact <= 1) {
        impactedTiles.push({x: b.x, y: b.y});
        playBeep(150, 0.2);
      } else {
        survivingBombs.push({ ...b, turnsToImpact: b.turnsToImpact - 1 });
      }
    });

    if (impactedTiles.length > 0) {
      setTiles(prev => {
        const eggTile = prev.find(t => t.type === 'egg');
        const heliTile = prev.find(t => t.type === 'heli');
        return prev.map(t => {
          if (impactedTiles.some(it => it.x === t.x && it.y === t.y)) {
            const isProtected =
              (t.x === 0 && t.y === GRID_ROWS - 1) || t.type === 'heli' ||
              (eggTile  && Math.abs(t.x - eggTile.x)  + Math.abs(t.y - eggTile.y)  === 1) ||
              (heliTile && Math.abs(t.x - heliTile.x) + Math.abs(t.y - heliTile.y) === 1);
            if (!isProtected && (t.type === 'road' || t.type === 'vent' || t.type === 'spray' || t.type === 'repair_kit')) {
              return { ...t, type: 'magma', magmaCooldown: 5 };
            }
          }
          return t;
        });
      });
    }
    
    // 5. Roll for new disasters (Smart Targeting)
    const isIntensified = turnCount >= 8;

    // Disaster chance scales with difficulty
    const diffDisasterHigh = difficulty === 'EASY' ? 0.65 : difficulty === 'NORMAL' ? 0.80 : difficulty === 'HARD' ? 0.90 : 1.0;
    const diffDisasterLow  = difficulty === 'EASY' ? 0.20 : difficulty === 'NORMAL' ? 0.35 : difficulty === 'HARD' ? 0.50 : 0.70;
    const disasterChance = isIntensified || eggs > 0 || hasCursed ? diffDisasterHigh : (turnCount >= 3 ? diffDisasterLow : 0);
    
    if (Math.random() < disasterChance) {
      // Weight the random roll: Case 0 (Bombs) is now much more common
      const rollValue = Math.floor(Math.random() * 10);
      let eventId = rollValue < 6 ? 0 : (rollValue === 6 ? 1 : (rollValue === 7 ? 2 : (rollValue === 8 ? 3 : 4)));
      
      // Early turns (3-7) only bombs
      if (turnCount < 8) eventId = 0;

      playBeep(600, 0.3);

      const isPathBlocked = (bx: number, by: number, currentSurvivingBombs: VolcanicBomb[], currentNewBombs: VolcanicBomb[]) => {
          const blockers = new Set(tiles.filter(t => t.type === 'wall' || t.type === 'magma').map(t => `${t.x},${t.y}`));
          currentSurvivingBombs.forEach(b => blockers.add(`${b.x},${b.y}`));
          currentNewBombs.forEach(b => blockers.add(`${b.x},${b.y}`));
          blockers.add(`${bx},${by}`);

          const checkPath = (sx: number, sy: number, gx: number, gy: number) => {
            const q: {x: number, y: number}[] = [{x: sx, y: sy}];
            const visited = new Set([`${sx},${sy}`]);
            while(q.length > 0) {
              const {x, y} = q.shift()!;
              if (x === gx && y === gy) return true;
              for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
                const nx = x + dx, ny = y + dy;
                const key = `${nx},${ny}`;
                if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS && !blockers.has(key) && !visited.has(key)) {
                  visited.add(key);
                  q.push({x: nx, y: ny});
                }
              }
            }
            return false;
          };

          const canReachHeli = checkPath(playerPos.x, playerPos.y, 0, GRID_ROWS - 1);
          if (eggs > 0) return !canReachHeli;

          const canReachEgg = checkPath(playerPos.x, playerPos.y, GRID_COLS - 1, 0);
          return !(canReachHeli && canReachEgg);
        };

        switch(eventId) {
          case 0: // Volcanic Bombs (Smart Targeting)
            const newBombs: VolcanicBomb[] = [];
            const diffBombBase = difficulty === 'EASY' ? 2 : difficulty === 'NORMAL' ? 3 : difficulty === 'HARD' ? 4 : 5;
            let baseCount = eggs > 0 ? diffBombBase + 3 : diffBombBase;
            if (hasCursed) baseCount += 2;

            // Intensification scaling
            if (turnCount >= 8 && eggs === 0) baseCount += (difficulty === 'LEGEND' ? 2 : 1);

            const count = baseCount;
            // Harder = less warning time (EASY:3t, NORMAL:2t, HARD:2t, LEGEND:1t)
            const warningTurns = difficulty === 'EASY' ? 3 : difficulty === 'LEGEND' ? 1 : 2;
            
            // Early pressure can target near Heliport (0, GRID_ROWS-1)
            const isEarlyPressure = turnCount >= 3 && turnCount < 8 && eggs === 0;
            
            const targetPosX = (eggs > 0) ? 0 : GRID_COLS - 1;
            const targetPosY = (eggs > 0) ? GRID_ROWS - 1 : 0;

            const getPath = (sx: number, sy: number, gx: number, gy: number) => {
              const q: {x: number, y: number, path: {x: number, y: number}[]}[] = [{x: sx, y: sy, path: []}];
              const visited = new Set([`${sx},${sy}`]);
              const blockers = new Set(tiles.filter(t => t.type === 'wall' || t.type === 'magma').map(t => `${t.x},${t.y}`));
              while(q.length > 0) {
                const {x, y, path} = q.shift()!;
                if (x === gx && y === gy) return path;
                for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
                  const nx = x + dx, ny = y + dy;
                  const key = `${nx},${ny}`;
                  if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS && !blockers.has(key) && !visited.has(key)) {
                    visited.add(key);
                    q.push({x: nx, y: ny, path: [...path, {x: nx, y: ny}]});
                  }
                }
              }
              return [];
            };

            const shortestPath = getPath(playerPos.x, playerPos.y, targetPosX, targetPosY);

            for (let i = 0; i < count; i++) {
              let attempts = 0;
              while (attempts < 40) {
                let bx, by;
                const rand = Math.random();
                
                if (isEarlyPressure && rand < 0.3) {
                  // SOUTH-WEST: Targeted pressure near Heliport
                  bx = Math.floor(Math.random() * 3);
                  by = (GRID_ROWS - 1) - Math.floor(Math.random() * 5);
                } else if (rand < 0.2) {
                  // LOCAL: Target near player current position
                  bx = Math.max(0, Math.min(GRID_COLS - 1, playerPos.x + (Math.floor(Math.random() * 5) - 2)));
                  by = Math.max(0, Math.min(GRID_ROWS - 1, playerPos.y + (Math.floor(Math.random() * 5) - 2)));
                } else if (shortestPath.length > 5 && rand < 0.5) {
                  // PATH: Block current optimal route
                  const idx = Math.floor(Math.random() * (shortestPath.length - 4)) + 3;
                  bx = shortestPath[idx].x;
                  by = shortestPath[idx].y;
                } else if (rand < 0.8) {
                  // GLOBAL: Uniformly random across the entire grid
                  bx = Math.floor(Math.random() * GRID_COLS);
                  by = Math.floor(Math.random() * GRID_ROWS);
                } else {
                  // GOAL: Egg or Heliport area depending on game state
                  bx = (eggs > 0) ? Math.floor(Math.random() * 3) : (GRID_COLS - 1) - Math.floor(Math.random() * 3);
                  by = (eggs > 0) ? (GRID_ROWS - 1) - Math.floor(Math.random() * 3) : Math.floor(Math.random() * 3);
                }

                // Restriction: Not same as player, not adjacent to player
                const isNearPlayer = Math.abs(bx - playerPos.x) <= 1 && Math.abs(by - playerPos.y) <= 1;
                const tile = tiles.find(t => t.x === bx && t.y === by);
                
                // Safety Zone Definition: 1-tile radius around Egg (GRID_COLS-1, 0) and Heliport (0, GRID_ROWS-1)
                const isNearEgg = Math.abs(bx - (GRID_COLS - 1)) <= 1 && Math.abs(by - 0) <= 1;
                const isNearHeli = Math.abs(bx - 0) <= 1 && Math.abs(by - (GRID_ROWS - 1)) <= 1;

                // Restriction: Critical non-destructible tiles and safety zones
                const isCritical = isNearEgg || isNearHeli || 
                                   tile?.type === 'heli' || 
                                   tile?.type === 'egg' ||
                                   tile?.type === 'statue';
                
                const alreadyHasBomb = survivingBombs.some(sb => sb.x === bx && sb.y === by) || 
                                     newBombs.some(nb => nb.x === bx && nb.y === by);
                
                if (!isNearPlayer && !isCritical && !alreadyHasBomb && tile?.type === 'road' && !isPathBlocked(bx, by, survivingBombs, newBombs)) {
                  newBombs.push({ x: bx, y: by, turnsToImpact: warningTurns });
                  break;
                }
                attempts++;
              }
            }
            setBombs([...survivingBombs, ...newBombs]);
            addLog('火山弾が接近中！回避するか防御しろ！', 'danger');
            setCentralMessage('警告：火山弾接近中！');
            break;

          case 1: // Earthquake
            setTiles(prev => {
              const walls = prev.filter(t => t.type === 'wall' && Math.abs(t.y - playerPos.y) < 5);
              if (walls.length > 0) {
                const target = walls[Math.floor(Math.random() * walls.length)];
                addLog('地震発生！壁が崩落した。', 'warning');
                setCentralMessage('地震：壁が崩落！');
                return prev.map(t => t.id === target.id ? { ...t, type: 'road' } : t);
              }
              return prev;
            });
            setBombs(survivingBombs);
            break;

          case 2: // Heatwave
            setIsHeatwave(true);
            addLog('警告：猛烈な熱波を検知！', 'danger');
            setCentralMessage('異常気象：極限熱波！');
            setBombs(survivingBombs);
            break;

          case 3: // Volcanic Smoke
            setIsSmoke(true);
            addLog('視界不良：火山灰が蔓延している。', 'info');
            setCentralMessage('警告：煙害発生！');
            setBombs(survivingBombs);
            break;

          case 4: // Small Eruption
            let eruptionX = Math.floor(Math.random() * GRID_COLS);
            let eruptionY = Math.max(0, playerPos.y - 3);
            
            // Safety: Ensure eruption isn't right on top of player and doesn't block path
            const testEruption = (ex: number, ey: number) => {
              const blockers = new Set(tiles.filter(t => t.type === 'wall' || t.type === 'magma').map(t => `${t.x},${t.y}`));
              survivingBombs.forEach(b => blockers.add(`${b.x},${b.y}`));
              
              // Add proposed eruption tiles to blockers temporarily
              for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                  if (Math.abs(dx) + Math.abs(dy) <= 1) {
                    blockers.add(`${ex + dx},${ey + dy}`);
                  }
                }
              }

              const q: {x: number, y: number}[] = [{x: playerPos.x, y: playerPos.y}];
              const visited = new Set([`${playerPos.x},${playerPos.y}`]);
              let reachedGoal = false;
              while(q.length > 0) {
                const {x, y} = q.shift()!;
                if (x === 0 && y === GRID_ROWS - 1) { reachedGoal = true; break; }
                for (const [mdx, mdy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
                  const nx = x + mdx, ny = y + mdy;
                  const key = `${nx},${ny}`;
                  if (nx >= 0 && nx < GRID_COLS && ny >= 0 && ny < GRID_ROWS && !blockers.has(key) && !visited.has(key)) {
                    visited.add(key);
                    q.push({x: nx, y: ny});
                  }
                }
              }
              return reachedGoal;
            };

            let eruptionAttempts = 0;
            while (eruptionAttempts < 15) {
              const ex = Math.floor(Math.random() * GRID_COLS);
              const ey = Math.floor(Math.random() * GRID_ROWS);
              const isNearPlayer = Math.abs(ex - playerPos.x) <= 2 && Math.abs(ey - playerPos.y) <= 2;
              const tile = tiles.find(t => t.x === ex && t.y === ey);
              const isCritical = tile?.type === 'heli' || (ex === 0 && ey === GRID_ROWS - 1);

              if (!isNearPlayer && !isCritical && testEruption(ex, ey)) {
                eruptionX = ex;
                eruptionY = ey;
                break;
              }
              eruptionAttempts++;
            }

            setTiles(prev => prev.map(t => {
               const dist = Math.abs(t.x - eruptionX) + Math.abs(t.y - eruptionY);
               const isHeliOrStart = (t.x === 0 && t.y === GRID_ROWS - 1) || t.type === 'heli';
               if (dist <= 1 && t.type === 'road' && !isHeliOrStart) {
                 return { ...t, type: 'magma', magmaCooldown: 1 };
               }
               return t;
            }));
            addLog('小規模噴火！地面が一時的にマグマ化した。', 'danger');
            setCentralMessage('小規模噴火を検知！');
            setBombs(survivingBombs);
            break;
        }
        setTimeout(() => setCentralMessage(null), 1200);
      } else {
        setBombs(survivingBombs);
      }
  }, [isGameOver, isMoving, stepsRemaining, isRolling, selectedJob, scoutFixedRoll, inventoryWeight, turnCount, heliTurnsLeft, inventory.treasures, eggs, safeTurns, bombs, tiles, addLog]);

  const handleDeath = useCallback(() => {
    playDoomSE();
    setGameState('lost');
    setIsGameOver(true);

    const finalScore = 0;

    const result: Omit<GameResult, 'rank' | 'title'> = {
      treasures: inventory.treasures,
      totalValue: finalScore,
      totalWeight: inventoryWeight,
      hpRemaining: 0,
      turnCount: turnCount,
      difficulty: difficulty,
    };

    setGameResult({
      ...result,
      rank: 'D',
      title: '焼かれた新人'
    });

    const newState = {
      ...persistent,
      points: persistent.points + finalScore,
      lastDeath: {
        x: playerPos.x,
        y: playerPos.y,
        items: { 
          scales: inventory.scales,
          ores: inventory.ores,
          data: inventory.data
        }
      }
    };
    setPersistent(newState);
    savePersistentState(newState);
  }, [persistent, playerPos.x, playerPos.y, inventory.scales, inventory.ores, inventory.data, inventory.treasures, inventoryWeight, turnCount, difficulty]);

  const findPath = useCallback((tx: number, ty: number): {x: number, y: number}[] => {
    if (ty >= lavaLevel) return [];
    const queue: {x: number, y: number, path: {x: number, y: number}[]}[] = [
      { x: playerPos.x, y: playerPos.y, path: [] }
    ];
    const visited = new Set([`${playerPos.x},${playerPos.y}`]);
    while (queue.length > 0) {
      const { x, y, path } = queue.shift()!;
      if (x === tx && y === ty) return path;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = x + dx, ny = y + dy;
        const key = `${nx},${ny}`;
        if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS || ny >= lavaLevel || visited.has(key)) continue;
        const t = getTileAt(nx, ny);
        if (!t || t.type === 'wall' || t.type === 'hole' || t.type === 'magma') continue;
        visited.add(key);
        queue.push({ x: nx, y: ny, path: [...path, { x: nx, y: ny }] });
      }
    }
    return [];
  }, [playerPos, lavaLevel, getTileAt]);

  const moveToOneStep = useCallback((dx: number, dy: number) => {
    if (isGameOver || isMoving || stepsRemaining <= 0) return;
    
    const nx = playerPos.x + dx;
    const ny = playerPos.y + dy;
    
    if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) return;
    
    const target = getTileAt(nx, ny);
    const current = getTileAt(playerPos.x, playerPos.y);

    if (isTechSkillActive) {
      if (target && target.type === 'wall') {
        setTiles(prev => prev.map(t => t.id === target.id ? { ...t, type: 'road' } : t));
        setIsTechSkillActive(false);
        setSkillAvailable(false);
        addLog('エンジニア：岩壁を破壊した！', 'success');
        playBeep(100, 0.4);
        return;
      } else {
        setIsTechSkillActive(false);
        addLog('破壊をキャンセル', 'info');
      }
    }
    
    // Parkour helper for treasure hunter
    const tryParkour = () => {
      if (selectedJob !== 'treasure_hunter' || treasureHunterJumpUses <= 0) return false;
      const jx = playerPos.x + dx * 2;
      const jy = playerPos.y + dy * 2;
      if (jx < 0 || jx >= GRID_COLS || jy < 0 || jy >= GRID_ROWS || jy >= lavaLevel) return false;
      const jTarget = getTileAt(jx, jy);
      if (!jTarget || jTarget.type === 'wall' || jTarget.type === 'hole' || jTarget.type === 'magma') return false;

      setTreasureHunterJumpUses(prev => prev - 1);
      addLog(`パルクール：障害を飛び越え2マス先へ着地！（残り${treasureHunterJumpUses - 1}回）`, 'success');
      playArp([523, 659, 784, 1047]);

      if (current && current.unstable) {
        setTiles(prev => prev.map(t => t.id === current!.id ? { ...t, type: 'hole', unstable: false } : t));
        playSE(150, 'sawtooth', 0.2, 0.1);
      }
      setIsMoving(true);
      setPlayerPos({ x: jx, y: jy });
      setStepsRemaining(s => s - 1);

      if (jTarget.unstable) {
        playSE(80, 'sawtooth', 0.5, 0.1);
        setCentralMessage('！！床が崩れる！！');
        setLavaRising(true);
        setTimeout(() => { setCentralMessage(null); setLavaRising(false); }, 700);
        addLog('警告：足場が崩落した！後退不能！', 'danger');
      }

      const hazard = getHazardLevel(jx, jy);
      if (suitCondition > 0) {
        let suitLoss = SUIT_COST_PER_STEP;
        if (hazard === 'magma') suitLoss += 10;
        const nextSuit = Math.max(0, suitCondition - suitLoss);
        if (nextSuit === 0) { addLog('スーツ大破！生体汚染の危険。', 'danger'); playBeep(200, 0.5); }
        setSuitCondition(nextSuit);
      } else {
        const hpLoss = hazard === 'magma' ? 15 : 5;
        setHp(h => {
          const nextH = Math.max(0, h - hpLoss);
          if (nextH <= 0) {
            if (selectedJob === 'leader' && hasLeaderLife) {
              setHasLeaderLife(false);
              addLog('リーダー：緊急蘇生プロトコル発動！', 'success');
              return 30;
            }
            handleDeath();
          }
          return nextH;
        });
      }
      playBeep(300 + (36 - jy) * 10, 0.05);
      if (jy >= lavaLevel) { handleDeath(); addLog('マグマに呑み込まれた。', 'danger'); }
      setTimeout(() => { setIsMoving(false); handleTileEffect(jx, jy); }, 40);
      return true;
    };

    // Path blocked by walls, gaps or lava
    if (!target || target.type === 'wall' || target.type === 'hole' || ny >= lavaLevel) {
      tryParkour();
      return;
    }
    if (target.type === 'magma') {
      tryParkour();
      return;
    }

    // Handle floor crumbling after passing
    if (current && current.unstable) {
      setTiles(prev => prev.map(t => t.id === current.id ? { ...t, type: 'hole', unstable: false } : t));
      playSE(150, 'sawtooth', 0.2, 0.1); // Collapse sound
    }

    setIsMoving(true);
    setPlayerPos({ x: nx, y: ny });
    setStepsRemaining(s => s - 1);

    // Unstable tile: sound + screen shake feedback (no visual hint on tile)
    if (target && target.unstable) {
      playSE(80, 'sawtooth', 0.5, 0.1);
      setCentralMessage('！！床が崩れる！！');
      setLavaRising(true);
      setTimeout(() => {
        setCentralMessage(null);
        setLavaRising(false);
      }, 700);
      addLog('警告：足場が崩落した！後退不能！', 'danger');
    }
    
    // --- Suit and HP Logic (Strict Buffer Implementation) ---
    const hazard = getHazardLevel(nx, ny);
    
    if (suitCondition > 0) {
      let suitLoss = SUIT_COST_PER_STEP; 
      if (hazard === 'magma') suitLoss += (selectedJob === 'robot' ? 5 : 10); 
      if (isHeatwave) suitLoss += (selectedJob === 'robot' ? 2 : 5); 
      if (eggs > 0) suitLoss += 2; 

      const nextSuit = Math.max(0, suitCondition - suitLoss);
      if (nextSuit === 0) {
        addLog('スーツ大破！生体汚染の危険。', 'danger');
        playBeep(200, 0.5);
      }
      setSuitCondition(nextSuit);
      // HP remains safe this step as suit had gauge
    } else {
      // Suit is already 0, subtract from HP directly
      let hpLoss = (selectedJob === 'robot' ? 3 : 5);
      if (hazard === 'magma') hpLoss = (selectedJob === 'robot' ? 8 : 15);
      if (isHeatwave) hpLoss += (selectedJob === 'robot' ? 1 : 2);
      
      setHp(h => {
        const nextH = Math.max(0, h - hpLoss);
        if (nextH <= 0) {
          if (selectedJob === 'leader' && hasLeaderLife) {
            setHasLeaderLife(false);
            addLog('リーダー：緊急蘇生プロトコル発動！', 'success');
            setCentralMessage('生存：緊急蘇生完了');
            setTimeout(() => setCentralMessage(null), 1000);
            return 30;
          }
          handleDeath();
        }
        return nextH;
      });
    }

    playBeep(300 + (36 - ny) * 10, 0.05); 

    if (ny >= lavaLevel) {
      handleDeath();
      addLog('マグマに呑み込まれた。', 'danger');
    }

    setTimeout(() => {
      setIsMoving(false);
      handleTileEffect(nx, ny);
    }, 40);
  }, [isGameOver, isMoving, stepsRemaining, playerPos.x, playerPos.y, getTileAt, isTechSkillActive, tiles, setTiles, setIsTechSkillActive, setSkillAvailable, addLog, getHazardLevel, suitCondition, setSuitCondition, setHp, selectedJob, hasLeaderLife, handleDeath, lavaLevel, handleTileEffect, treasureHunterJumpUses]);

  const setTank = useCallback(() => {
    if (isMoving || stepsRemaining > 0 || isGameOver || tankInventory <= 0) return;
    
    // Toggle set mode.
    if (!isSettingTank) {
      setIsSettingTank(true);
      addLog('設置ポイントを選択（隣接マスのみ）', 'warning');
      playBeep(400, 0.1);
    } else {
      setIsSettingTank(false);
      addLog('設置キャンセル', 'info');
    }
  }, [isMoving, stepsRemaining, isGameOver, tankInventory, isSettingTank, setIsSettingTank, addLog]);

  const deployTank = (tx: number, ty: number) => {
    setTankInventory(prev => prev - 1);
    setIsSettingTank(false);
    setTiles(prev => prev.map(t => (t.x === tx && t.y === ty) ? { ...t, type: 'tank', durability: 2 } : t));
    addLog('冷却タンクを設置した', 'info');
    setTurnCount(prev => prev + 1);
    playBeep(450, 0.1);
    
    // Trigger turn impacts manually (Magma Cooling)
    setTiles(prev => prev.map(t => {
      if (t.type === 'magma' && t.magmaCooldown !== undefined) {
        const nextCooldown = t.magmaCooldown - 1;
        if (nextCooldown <= 0) return { ...t, type: 'road', magmaCooldown: undefined };
        return { ...t, magmaCooldown: nextCooldown };
      }
      return t;
    }));
    
    // Note: No more automatic lava rise here.
  };

  // Keyboard Controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isGameOver || showBriefing || !selectedJob) return;

      switch(e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          moveToOneStep(0, -1);
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          moveToOneStep(0, 1);
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          moveToOneStep(-1, 0);
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          moveToOneStep(1, 0);
          break;
        case ' ':
        case 'Enter':
          if (stepsRemaining === 0 && !isRolling) {
            rollDice();
          }
          break;
        case 't':
        case 'T':
          setTank();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGameOver, showBriefing, selectedJob, stepsRemaining, isRolling, moveToOneStep, rollDice, setTank]);


  // Auto-walk along autoPath
  useEffect(() => {
    if (autoPath.length === 0 || isMoving || stepsRemaining <= 0 || isGameOver) return;
    const timer = setTimeout(() => {
      const next = autoPath[0];
      const dx = next.x - playerPos.x;
      const dy = next.y - playerPos.y;
      moveToOneStep(dx, dy);
      setAutoPath(prev => prev.slice(1));
    }, 130);
    return () => clearTimeout(timer);
  }, [autoPath, isMoving, stepsRemaining, isGameOver, playerPos, moveToOneStep]);

  const resetAndSelectJob = useCallback(() => {
    setSelectedJob(null);
    setShowSystemMenu(false);
    setShowBriefing(false);
    setPlayerPos({ x: 0, y: GRID_ROWS - 1 });
    setHp(BASE_INITIAL_HP);
    setMaxHp(BASE_INITIAL_HP);
    setSuitCondition(100);
    setEggs(0);
    setInventory({ scales: 0, ores: 0, data: 0, treasures: [] });
    setGameResult(null);
    setLavaLevel(GRID_ROWS);
    setTurnCount(0);
    setLastBaseRoll(null);
    setIsGameOver(false);
    setGameState('playing');
    setLogs([]);
    setStepsRemaining(0);
    setIsMoving(false);
    setCentralMessage(null);
    setTankInventory(3);
    setMaxTanks(3);
    setBombs([]);
    setHeliTurnsLeft(null);
    setIsHeatwave(false);
    setIsSmoke(false);
    setSafeTurns(0);
    setSkillAvailable(true);
    setSkillActiveTurns(0);
    setScoutFixedRoll(false);
    setIsTechSkillActive(false);
    setHasLeaderLife(true);
    setHasRemoteTankSkill(true);
    setScoutExtraStepAvailable(false);
    setRobotJumpUses(2);
    setIsRobotConvertActive(false);
    setTreasureHunterJumpUses(3);
    setGeologistScanUsed(false);
    setIsSettingTank(false);
    setLastRollDetails(null);
    setTiles(initialMap);
  }, [initialMap]);

  const buyUpgrade = (type: keyof PersistentState['upgrades']) => {
    const cost = (persistent.upgrades[type] + 1) * 50;
    if (persistent.points >= cost) {
      const newState = {
        ...persistent,
        points: persistent.points - cost,
        upgrades: {
          ...persistent.upgrades,
          [type]: persistent.upgrades[type] + 1
        }
      };
      setPersistent(newState);
      savePersistentState(newState);
      playBeep(900, 0.1);
    }
  };

  const useSkill = () => {
    if (!skillAvailable || isGameOver || isMoving || !selectedJob) return;

    switch (selectedJob) {
      case 'leader':
        setHp(prev => Math.min(maxHp, prev + 30));
        setSkillAvailable(false);
        addLog('リーダー：応急処置を実行！ (HP+30)', 'success');
        playArp([440, 554, 659, 880]); // Sparkle
        break;
      case 'tech':
        setIsTechSkillActive(true);
        addLog('エンジニア：ターゲット選択モード（岩壁なら破壊、道なら遠隔タンク設置）', 'warning');
        playArp([330, 440, 523]); 
        break;
      case 'carrier':
        addLog('軍人：予備タンクは既に装備済みです。(初期数+2)', 'info');
        break;
      case 'scout':
        setScoutFixedRoll(true);
        setSkillAvailable(false);
        addLog('登山家：精密スキャン！次回のダイス目を6に固定', 'success');
        playArp([392, 493, 587, 783]); 
        break;
      case 'robot': {
        if (robotJumpUses <= 0) {
          addLog('ROBOT：岩場投下のエネルギーが空です。', 'warning');
          break;
        }
        if (isRobotConvertActive) {
          setIsRobotConvertActive(false);
          addLog('岩場投下：キャンセルしました。', 'info');
        } else {
          setIsRobotConvertActive(true);
          addLog('ROBOT：変換するマグマ壁を選択してください。', 'warning');
          playBeep(400, 0.1);
        }
        break;
      }
      case 'geologist': {
        if (geologistScanUsed) break;
        setGeologistScanUsed(true);
        setSkillAvailable(false);
        setTiles(prev => prev.map(t =>
          t.type === 'hidden_tank' ? { ...t, type: 'tank', durability: 2 } : t
        ));
        addLog('地質学者：地層スキャン！全マップの隠し補給タンクを開示した！', 'success');
        playArp([330, 440, 554, 659, 880]);
        break;
      }
    }
  };

  const takeScoutStep = () => {
    if (selectedJob !== 'scout' || !scoutExtraStepAvailable || isMoving || isGameOver || stepsRemaining > 0) return;
    setStepsRemaining(1);
    setScoutExtraStepAvailable(false);
    addLog('登山家：ブースト！追加1歩を取得。', 'success');
    playBeep(500, 0.1);
  };

  const useTechRemote = (nx: number, ny: number) => {
    if (selectedJob !== 'tech' || !isTechSkillActive || !hasRemoteTankSkill) return false;
    const target = getTileAt(nx, ny);
    if (!target) return false;

    if (target.type === 'road') {
      if (tankInventory > 0) {
        setTankInventory(prev => prev - 1);
        setTiles(prev => prev.map(t => t.id === target.id ? { ...t, type: 'tank', durability: 2 } : t));
        setHasRemoteTankSkill(false);
        setIsTechSkillActive(false);
        setSkillAvailable(false);
        addLog('エンジニア：ドローンでタンクを遠隔設置！', 'success');
        playBeep(450, 0.3);
        return true;
      } else {
        addLog('タンクがありません。', 'warning');
      }
    } else if (target.type === 'wall') {
      setTiles(prev => prev.map(t => t.id === target.id ? { ...t, type: 'road' } : t));
      setIsTechSkillActive(false);
      setSkillAvailable(false);
      addLog('エンジニア：障害壁を爆破した！', 'success');
      playBeep(100, 0.4);
      return true;
    }
    return false;
  };

  const getRank = () => {
    if (gameState === 'won') {
      const eggPts = eggs * 100;
      const lootPts = inventory.ores * 30 + inventory.scales * 10 + inventory.data * 20;
      const total = eggPts + lootPts + Math.max(0, 100 - turnCount);
      
      if (total > 250) return 'S';
      if (total > 180) return 'A';
      if (total > 120) return 'B';
      return 'C';
    }
    const lootPts = inventory.ores * 30 + inventory.scales * 10 + inventory.data * 20;
    if (lootPts > 50) return 'C';
    return 'D';
  };

  const suitDisplayPercent = selectedJob === 'robot' ? suitCondition / 1.5 : suitCondition;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 px-0 lg:px-0">
      <div className="w-full max-w-2xl h-[100dvh] bg-[#000] text-[#FFD600] font-pixel flex flex-col relative overflow-hidden select-none border-x-4 border-[#1A110D]">
        <GlobalStyles />
      {/* --- Compact Mobile Header --- */}
      <header className="px-1.5 py-0.5 bg-[#000] border-b-4 border-[#FF0000]/30 z-30 shadow-[0_4px_10px_rgba(255,0,0,0.2)] shrink-0">
          <div className="flex items-center justify-between gap-2 overflow-hidden">
             {/* Mini HP Bar Section */}
             <div className="flex-1 min-w-0">
               <div className="flex justify-between items-baseline mb-0.5">
                  <span className="text-[8px] text-white/50 font-bold uppercase">🔥 スーツ耐久値</span>
                  <span className={`text-[10px] font-black ${suitDisplayPercent < 30 ? 'text-white animate-pulse' : 'text-white/80'}`}>
                    {Math.round(suitCondition)}%
                  </span>
               </div>
               <div className="h-2 w-full bg-black/40 border border-black/20 p-[0.5px] mb-1">
                  <motion.div 
                    className={`h-full ${
                      suitDisplayPercent > 70 ? 'bg-emerald-500' :
                      suitDisplayPercent > 40 ? 'bg-yellow-400' :
                      suitDisplayPercent > 20 ? 'bg-orange-500' : 'bg-red-600'
                    }`} 
                    animate={{ width: `${suitDisplayPercent}%` }} 
                  />
               </div>
               <div className="flex justify-between items-baseline mb-0.5 leading-none">
                  <span className="text-[8px] text-white/80 font-bold uppercase leading-none">❤️ HP</span>
                  <span className={`text-[10px] font-black leading-none ${hp < 30 ? 'text-white animate-pulse' : 'text-white'}`}>
                    {Math.round(hp)}
                  </span>
               </div>
               <div className="h-2 w-full bg-black/40 border border-black/20 p-[0.5px]">
                  <motion.div 
                    className="h-full bg-gradient-to-r from-red-600 to-red-400" 
                    animate={{ width: `${(hp / maxHp) * 100}%` }} 
                  />
               </div>
             </div>

             {/* Items Row */}
             <div className="flex items-center gap-1 shrink-0">
                {heliTurnsLeft !== null && (
                  <div className="flex items-center bg-black/60 px-1 py-1 border border-[#FF5252] rounded-sm mr-1 animate-pulse">
                    <Plane className="w-3 h-3 text-[#FF5252]" />
                    <span className="text-[8px] text-[#FF5252] ml-0.5 font-black">{heliTurnsLeft}T</span>
                  </div>
                )}
                <div className="flex items-center bg-black/40 px-1.5 py-1 border border-white/5 rounded-sm">
                   <PixelGem color="#4FC3F7" size="w-3.5 h-3.5" />
                   <span className="text-[8px] text-white ml-0.5">{inventory.ores}</span>
                </div>
                <div className="flex items-center bg-black/40 px-1.5 py-1 border border-white/5 rounded-sm">
                   <div className="w-3 h-3 bg-[#FFEB3B] rounded-full border border-black/10 shrink-0" />
                   <span className="text-[8px] text-white ml-0.5">{inventory.scales}</span>
                </div>
                <div className="flex items-center bg-black/40 px-1.5 py-1 border border-white/5 rounded-sm">
                   <Database className="w-3 h-3 text-emerald-400" />
                   <span className="text-[8px] text-white ml-0.5">{inventory.data}</span>
                </div>
                <div className={`flex items-center px-1.5 py-1 border rounded-sm transition-all ${eggs > 0 ? 'bg-orange-500/40 border-[#FFD600] shadow-[0_0_10px_rgba(255,214,0,0.5)]' : 'bg-black/40 border-white/5 opacity-50'}`}>
                   <PixelEgg size="w-3.5 h-3.5" />
                   <span className="text-[8px] text-white ml-0.5 font-black">{eggs}</span>
                </div>
             </div>

             {/* Volcanic Activity Countdown */}
             <div className="flex flex-col items-end shrink-0 ml-1 min-w-[70px]">
                <div className={`flex items-center gap-1 px-1.5 py-0.5 border rounded-sm transition-colors ${turnCount >= 8 ? 'bg-red-600/30 border-red-500 animate-pulse' : 'bg-black/40 border-white/10'}`}>
                  <Flame className={`w-3 h-3 ${turnCount >= 8 ? 'text-red-400' : 'text-orange-400'}`} />
                  <span className={`text-[8px] font-black ${turnCount >= 8 ? 'text-red-400' : 'text-white'}`}>
                    {turnCount >= 8 ? '火山活動激化' : `激化まであと${8 - turnCount}T`}
                  </span>
                </div>
                <span className="text-[5px] text-white/30 uppercase mt-0.5 font-bold">Volcanic Activity</span>
             </div>
          </div>
          
          {/* Latest Log Display Line */}
          <div className="mt-1 border-t border-white/10 pt-1 flex items-center justify-between overflow-hidden">
             <div className="flex items-center gap-1.5 overflow-hidden flex-1">
               <div className={`w-2 h-2 rounded-full shrink-0 ${logs[0]?.type === 'danger' ? 'bg-red-500 animate-pulse' : logs[0]?.type === 'success' ? 'bg-green-500' : logs[0]?.type === 'warning' ? 'bg-yellow-400' : 'bg-white/30'}`} />
               <span className={`text-[11px] font-black uppercase tracking-tight truncate leading-none ${logs[0]?.type === 'danger' ? 'text-red-400' : logs[0]?.type === 'success' ? 'text-green-400' : logs[0]?.type === 'warning' ? 'text-yellow-300' : 'text-white/80'}`}>
                 {logs[0]?.message || 'ミッション開始待機中...'}
               </span>
             </div>
             <div className="text-[9px] text-white/50 font-black ml-2 shrink-0">
               T:{turnCount}
             </div>
          </div>
          {/* Current Objective */}
          <div className={`mt-0.5 flex items-center gap-1.5 px-1 py-0.5 rounded-sm border ${eggs > 0 ? 'bg-orange-500/20 border-orange-500/50' : 'bg-[#FFD600]/10 border-[#FFD600]/30'}`}>
            <span className="text-[8px]">{eggs > 0 ? '🚁' : '🥚'}</span>
            <span className={`text-[10px] font-black uppercase tracking-tight ${eggs > 0 ? 'text-orange-300' : 'text-[#FFD600]'}`}>
              {eggs > 0 ? 'ヘリポート(左下)まで帰還せよ！' : '山頂(右上)の卵を確保せよ'}
            </span>
          </div>
      </header>


      {/* Tile Info Popup */}
      <AnimatePresence>
        {tilePopup && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute bottom-[180px] left-2 right-2 z-50 pointer-events-none"
          >
            <div className="bg-black/90 border-2 p-2 flex items-start gap-2 shadow-xl" style={{ borderColor: tilePopup.color }}>
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-[9px] font-black" style={{ color: tilePopup.color }}>{tilePopup.name}</span>
                <span className="text-[7px] text-white/80 leading-relaxed">{tilePopup.effect}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Central Message Overlay */}
      <AnimatePresence>
        {centralMessage && (
          <motion.div 
            initial={{ opacity: 0, scale: 2, y: -50 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5 }}
            className="fixed top-1/3 left-0 right-0 z-40 flex justify-center pointer-events-none px-4"
          >
            <div className="bg-black/80 border-4 border-[#FFEB3B] p-4 text-center shadow-2xl max-w-[280px]">
              <span className="text-white text-[12px] font-black uppercase leading-relaxed drop-shadow-[0_2px_0_#FF5252]">
                {centralMessage}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grid Map (Maximizing 55%+) */}
      <motion.main 
        ref={scrollContainerRef}
        animate={lavaRising ? { 
          x: [0, -3, 3, -3, 3, 0],
          y: [0, 1, -1, 1, -1, 0]
        } : {}}
        transition={{ duration: 0.15, repeat: 2 }}
        className="flex-grow relative overflow-auto bg-[#050200] scroll-smooth scrollbar-hide"
      >
        {/* Vignette overlay */}
        <div className="absolute inset-0 z-10 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)' }} />
        {/* Environment Overlays */}
        <AnimatePresence>
          {suitCondition <= 0 && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.4, 0] }}
              transition={{ repeat: Infinity, duration: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-red-600 z-30 pointer-events-none mix-blend-overlay"
              id="suit-broken-flash"
            />
          )}
          {isSmoke && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.3 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-gray-500 z-20 pointer-events-none mix-blend-multiply opacity-30"
              style={{ filter: 'blur(8px)' }}
            />
          )}
          {isHeatwave && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.2 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-red-600 z-20 pointer-events-none mix-blend-color"
            />
          )}
        </AnimatePresence>

        <div
          className="grid gap-[1px] bg-[#1A0800]/60 p-1"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
            gridAutoRows: '1fr',
            width: '100%',
            aspectRatio: `${GRID_COLS} / ${GRID_ROWS}`,
          }}
        >
          {tiles.map((tile) => {
            if (!tile || !tile.type) {
              console.warn(`[TileRender] undefined tile at index`, tile);
              return null;
            }
            const isLava = tile.y >= lavaLevel;
            const isMoveSelectable = stepsRemaining > 0 && !isMoving &&
              Math.abs(tile.x - playerPos.x) + Math.abs(tile.y - playerPos.y) === 1 &&
              tile.type !== 'wall' && tile.type !== 'hole' && tile.y < lavaLevel && tile.type !== 'magma';

            const isRobotConvertSelectable = isRobotConvertActive && !isMoving && !isGameOver &&
              Math.abs(tile.x - playerPos.x) + Math.abs(tile.y - playerPos.y) === 1 &&
              (tile.type === 'wall' || tile.type === 'magma') && tile.y < lavaLevel;

            const isTechSelectable = isTechSkillActive && !isMoving && !isGameOver;

            const isTankSelectable = isSettingTank && !isMoving && !isGameOver &&
              Math.abs(tile.x - playerPos.x) + Math.abs(tile.y - playerPos.y) === 1 &&
              tile.type === 'road' && !isLava;

            // Parkour jump target: 2 tiles ahead in cardinal direction, middle is blocked
            const isParkourTarget = (() => {
              if (selectedJob !== 'treasure_hunter' || treasureHunterJumpUses <= 0 || stepsRemaining <= 0 || isMoving || isGameOver) return false;
              const dx = tile.x - playerPos.x;
              const dy = tile.y - playerPos.y;
              if (Math.abs(dx) + Math.abs(dy) !== 2 || (dx !== 0 && dy !== 0)) return false;
              const sdx = dx / 2, sdy = dy / 2;
              const mid = getTileAt(playerPos.x + sdx, playerPos.y + sdy);
              const midY = playerPos.y + sdy;
              const midBlocked = !mid || mid.type === 'wall' || mid.type === 'hole' || mid.type === 'magma' || midY >= lavaLevel;
              if (!midBlocked) return false;
              return tile.type !== 'wall' && tile.type !== 'hole' && tile.type !== 'magma' && tile.y < lavaLevel;
            })();

            const isPlayer = playerPos.x === tile.x && playerPos.y === tile.y;

            return (
              <div
                key={tile.id}
                ref={isPlayer ? playerRef : null}
                onClick={() => {
                  if (isMoveSelectable) {
                    moveToOneStep(tile.x - playerPos.x, tile.y - playerPos.y);
                  } else if (isTechSelectable) {
                    useTechRemote(tile.x, tile.y);
                  } else if (isTankSelectable) {
                    deployTank(tile.x, tile.y);
                  } else if (isRobotConvertSelectable) {
                    setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road', magmaCooldown: undefined } : t));
                    setRobotJumpUses(prev => prev - 1);
                    setIsRobotConvertActive(false);
                    addLog('ロボット：マグマ壁を岩場に変換した！', 'success');
                    playArp([440, 659, 880]);
                  } else if (isParkourTarget) {
                    const sdx = Math.sign(tile.x - playerPos.x);
                    const sdy = Math.sign(tile.y - playerPos.y);
                    moveToOneStep(sdx, sdy);
                  } else {
                    if (stepsRemaining > 0 && !isMoving) {
                      const path = findPath(tile.x, tile.y);
                      if (path.length > 0) {
                        setAutoPath(path);
                        return;
                      }
                    }
                    const info = TILE_INFO[tile.type];
                    if (info) {
                      if (tilePopupTimerRef.current) clearTimeout(tilePopupTimerRef.current);
                      setTilePopup(info);
                      tilePopupTimerRef.current = setTimeout(() => setTilePopup(null), 2500);
                    }
                  }
                }}
                onTouchEnd={(e) => {
                  if (isRobotConvertSelectable) {
                    e.preventDefault();
                    setTiles(prev => prev.map(t => t.id === tile.id ? { ...t, type: 'road', magmaCooldown: undefined } : t));
                    setRobotJumpUses(prev => prev - 1);
                    setIsRobotConvertActive(false);
                    addLog('ロボット：マグマ壁を岩場に変換した！', 'success');
                    playArp([440, 659, 880]);
                  } else if (isParkourTarget) {
                    e.preventDefault();
                    const sdx = Math.sign(tile.x - playerPos.x);
                    const sdy = Math.sign(tile.y - playerPos.y);
                    moveToOneStep(sdx, sdy);
                  }
                }}
                className={`
                  relative flex items-center justify-center h-full w-full
                  ${isMoveSelectable ? 'ring-2 ring-inset ring-[#FFEB3B] z-10 cursor-pointer shadow-[0_0_8px_#FFD600] brightness-110' : ''}
                  ${isTechSelectable ? 'ring-2 ring-inset ring-cyan-400 z-10 cursor-crosshair' : ''}
                  ${isTankSelectable ? 'ring-2 ring-inset ring-white z-10 cursor-pointer' : ''}
                  ${isRobotConvertSelectable ? 'cursor-pointer' : ''}
                  ${isParkourTarget ? 'ring-2 ring-inset ring-lime-400 z-10 cursor-pointer brightness-125' : ''}
                  border-[0.5px] border-black/25
                `}
                style={{
                  imageRendering: 'pixelated',
                  backgroundColor: isLava
                    ? (tile.y % 2 === 0 ? '#C62828' : '#B71C1C')
                    : tile.type === 'magma'
                    ? ((tile.x + tile.y) % 2 === 0 ? '#C62828' : '#B71C1C')
                    : tile.type === 'wall'
                    ? ((tile.x + tile.y) % 2 === 0 ? '#3E1A1A' : '#4A2020')
                    : tile.type === 'hole'
                    ? '#050505'
                    : '#795548',
                }}
              >
                {/* Visual Elements */}
                {(isLava || tile.type === 'magma' || tile.type === 'wall') && <PixelMagma />}
                {isRobotConvertSelectable && (
                  <div className="absolute inset-0 z-10 pointer-events-none animate-pulse"
                       style={{ border: '2px solid #fb923c', boxShadow: 'inset 0 0 10px #fb923c, 0 0 6px #fb923c' }} />
                )}
                {tile.type === 'hole' && <PixelHole />}
                {(tile.type === 'road' || tile.type === 'hidden_tank') && !isLava && <PixelRock />}
                {tile.type === 'hidden_tank' && !isLava && selectedJob === 'geologist' && (
                  <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-[#F9A825] opacity-80 animate-pulse shadow-[0_0_4px_#F9A825]" />
                  </div>
                )}
                
                {/* Volcanic Bomb Warning */}
                {bombMap.has(`${tile.x},${tile.y}`) && (
                  <PixelBombMark turns={bombMap.get(`${tile.x},${tile.y}`)!.turnsToImpact} />
                )}
                {selectedJob === 'scout' && tile.type === 'vent' && (
                  <div className="absolute inset-0 border border-cyan-400/30 animate-pulse bg-cyan-400/5" />
                )}
                {!isLava && tile.type === 'heli' && <PixelHeli />}
                {!isLava && tile.type === 'egg' && <PixelEgg />}
                {!isLava && tile.type === 'spray' && <PixelSpray />}
                {!isLava && tile.type === 'repair_kit' && <PixelRepairKit />}
                {!isLava && tile.type === 'vent' && <div className="w-full h-full flex items-center justify-center opacity-30"><Wind className="w-4 h-4 text-white" /></div>}
                {!isLava && tile.type === 'tank' && <PixelTank />}
                {!isLava && tile.type === 'scale' && <div className="w-full h-full flex items-center justify-center p-2"><div className="w-full h-full bg-[#FFEB3B] rounded-full border border-black/10" /></div>}
                {!isLava && tile.type === 'ore' && <div className="p-1 w-full h-full"><PixelGem color="#4FC3F7" /></div>}
                {!isLava && tile.type === 'data' && <div className="w-full h-full bg-emerald-900 border border-emerald-400/50 flex items-center justify-center p-1"><Database className="w-3 h-3 text-emerald-400" /></div>}
                {!isLava && tile.type === 'gem' && <div className="p-1 w-full h-full"><PixelGem color="#F06292" /></div>}
                {!isLava && tile.type === 'document' && <PixelDocument />}
                {!isLava && tile.type === 'statue' && <PixelStatue />}
                {!isLava && tile.type === 'crystal' && <PixelCrystal />}
                {!isLava && tile.type === 'cursed' && <PixelCursed />}
                {!isLava && tile.type === 'remains' && (
                  <div className="flex items-center justify-center relative w-full h-full">
                    <Skull className="w-5 h-5 text-gray-400/80" />
                    <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full animate-ping" />
                  </div>
                )}
                {isPlayer && (
                  <div className="absolute inset-0 z-20">
                    <PixelCharacter isMoving={isMoving} isReturning={eggs > 0} jobColor={JOBS.find(j => j.id === selectedJob)?.color || '#FFF'} jobId={selectedJob ?? undefined} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </motion.main>

      {/* Mobile Footer Area */}
      <footer className="bg-[#000] border-t-2 border-[#FF0000]/30 z-30 shadow-2xl flex flex-col p-1.5 gap-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        {/* Row 1: Dashboard */}
        <div className="grid grid-cols-12 gap-2 h-24">
          
          {/* Left: Inventory Info (Col 5) */}
          <div className="col-span-5 bg-black/40 border-2 border-[#3E2723] rounded p-1.5 flex flex-col overflow-hidden">
            <div className="flex justify-between items-center mb-1 border-b border-white/10 pb-0.5">
               <span className="text-[8px] text-white/40 font-black uppercase tracking-[0.05em]">回収品</span>
               <div className="flex flex-col items-end leading-tight shrink-0 pl-1">
                 <span className="text-[9px] text-cyan-400 font-black whitespace-nowrap">価値 {inventoryValue}</span>
                 {getRequiredSubItems(difficulty) > 0 ? (
                   uniqueSubItemTypes >= getRequiredSubItems(difficulty) ? (
                     <span className="text-[9px] text-green-400 font-black whitespace-nowrap">条件✅クリア可</span>
                   ) : (
                     <span className="text-[9px] text-[#FF5252] font-black whitespace-nowrap animate-pulse">
                       あと{getRequiredSubItems(difficulty) - uniqueSubItemTypes}種類必要
                     </span>
                   )
                 ) : (
                   <span className="text-[9px] text-green-400 font-black whitespace-nowrap">条件✅クリア可</span>
                 )}
               </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-hide space-y-1">
               {eggs > 0 && <div className="flex justify-between text-[7px] text-[#FFD600] font-bold"><span><PixelEgg size="w-3.5 h-3.5 inline-block" /> ドラゴンの卵</span><span>x1</span></div>}
               {inventory.treasures.map((t) => (
                 <div key={t.id} className="flex justify-between text-[7px] text-white border-b border-white/5 py-0.5">
                    <span className="flex items-center gap-1 truncate pr-1">
                      {t.type === 'gem' ? <PixelGem size="w-3 h-3" /> : 
                       t.type === 'document' ? <PixelDocument size="w-3 h-3" /> : 
                       t.type === 'statue' ? <PixelStatue size="w-3 h-3" /> : 
                       t.type === 'crystal' ? <PixelCrystal size="w-3 h-3" /> : 
                       t.type === 'cursed' ? <PixelCursed size="w-3 h-3" /> : '📦 '}
                      {t.name}
                    </span>
                    <span className="shrink-0 font-black opacity-60">重{t.weight}</span>
                 </div>
               ))}
               {inventory.ores > 0 && <div className="flex justify-between text-[7px] text-cyan-300"><span><PixelGem color="#4FC3F7" size="w-3 h-3 inline-block" /> 貴重な鉱石</span><span>x{inventory.ores}</span></div>}
               {inventory.scales > 0 && <div className="flex justify-between text-[7px] text-[#FFEB3B]"><span>🪙 鱗</span><span>x{inventory.scales}</span></div>}
               {inventory.data > 0 && <div className="flex justify-between text-[7px] text-emerald-400"><span>💾 データ</span><span>x{inventory.data}</span></div>}
               {eggs === 0 && inventory.treasures.length === 0 && inventory.ores === 0 && inventory.scales === 0 && inventory.data === 0 && (
                 <div className="h-full flex items-center justify-center text-[7px] text-white/20 italic uppercase tracking-widest">空っぽ</div>
               )}
            </div>
          </div>

          {/* Center: Dice / Move (Col 4) */}
          <div className="col-span-4 flex flex-col gap-1.5">
            {turnCount === 0 && stepsRemaining === 0 && !isRolling && (
              <div className="text-center text-[8px] text-[#FFD600] font-black animate-bounce leading-none mb-0.5">
                ↓ まずここを押す！
              </div>
            )}
            <div className={`flex-1 border-b-4 rounded-md flex flex-col items-center justify-center relative overflow-hidden transition-all
              ${isRolling ? 'bg-[#FFEB3B] border-black scale-95' : 'bg-[#B71C1C] border-black shadow-[0_6px_0_#3E2723] active:translate-y-1 active:shadow-[0_2px_0_#3E2723]'}
              ${stepsRemaining > 0 ? 'opacity-30' : ''}
              ${turnCount === 0 && stepsRemaining === 0 && !isRolling ? 'ring-2 ring-[#FFD600] ring-offset-1 ring-offset-black animate-pulse' : ''}
            `}>
              <button 
                onClick={rollDice}
                disabled={isGameOver || isMoving || stepsRemaining > 0 || isRolling}
                className="absolute inset-0 z-10 w-full h-full touch-manipulation"
              />
              <motion.div
                animate={isRolling ? { rotate: [0, -15, 15, -10, 10, 0], scale: [1, 1.15, 0.9, 1.05, 1] } : { rotate: 0, scale: 1 }}
                transition={isRolling ? { repeat: Infinity, duration: 0.18, ease: 'easeInOut' } : { duration: 0.15 }}
                style={{ willChange: 'transform' }}
              >
                <DiceFace value={visualRoll} rolling={isRolling} />
              </motion.div>
              <div className={`text-[8px] font-black uppercase mt-1.5 tracking-tighter ${isRolling ? 'text-black' : 'text-white/80'}`}>
                {isRolling ? '抽出中...' : (stepsRemaining > 0 ? '移動中...' : 'ダイスを振る')}
              </div>
            </div>
            
            {/* Real-time Stat calc */}
            <div className="bg-black/80 border-2 border-white/10 p-1 rounded flex flex-col items-center gap-0.5">
               {lastRollDetails ? (
                 <>
                   <div className="flex gap-2 text-[7px] font-black leading-none">
                     <span className="text-white/60">出目:{lastRollDetails.raw}</span>
                     <span className="text-[#FF5252]">-荷物:{lastRollDetails.weightPenalty}</span>
                     <span className="text-cyan-400">+職能:{lastRollDetails.jobBonus}</span>
                   </div>
                   <div className="text-[12px] font-black text-[#FFEB3B] leading-none mt-1">移動歩数 {lastRollDetails.final}</div>
                 </>
               ) : (
                 <span className="text-[6px] text-white/20 uppercase tracking-widest font-black">機動待機中</span>
               )}
            </div>
          </div>

          {/* Right: Actions (Col 3) */}
          <div className="col-span-3 flex flex-col gap-1">
             <button 
               onClick={() => setShowSystemMenu(true)}
               className="flex-[0.5] bg-zinc-900 border-b-2 border-black text-[#FFD600] text-[7px] font-black rounded flex items-center justify-center active:translate-y-0.5 transition-all shadow-inner uppercase"
             >
               <Settings size={10} className="mr-1" /> メニュー
             </button>
             <button 
               onClick={() => setShowDropModal(true)}
               className="flex-1 bg-[#B71C1C] border-b-4 border-black text-white text-[9px] font-black rounded-md flex items-center justify-center active:translate-y-1 active:shadow-[0_0_0_transparent] active:border-b-0 uppercase transition-all shadow-xl touch-manipulation"
             >
               捨てる
             </button>
             <button
               onClick={useSkill}
               disabled={
                 selectedJob === 'treasure_hunter' ||
                 (selectedJob === 'robot' && robotJumpUses <= 0) ||
                 (selectedJob === 'geologist' && geologistScanUsed) ||
                 (!skillAvailable && selectedJob !== 'robot' && selectedJob !== 'geologist') ||
                 isGameOver || isMoving
               }
               className={`flex-1 border-b-4 border-black text-[9px] font-black rounded-md flex flex-col items-center justify-center uppercase transition-all touch-manipulation
                 ${isRobotConvertActive
                   ? 'bg-orange-400 text-black translate-y-1 border-b-0 shadow-inner animate-pulse'
                   : (skillAvailable || (selectedJob === 'robot' && robotJumpUses > 0) || (selectedJob === 'geologist' && !geologistScanUsed))
                     ? 'bg-[#FFD600] text-black active:translate-y-1 active:border-b-0 shadow-lg'
                     : 'bg-zinc-800 text-white/20 border-b-0'}
               `}
             >
               <span>スキル</span>
               {selectedJob === 'robot' && <span className="text-[6px] opacity-70">岩場投下 x{robotJumpUses}</span>}
               {selectedJob === 'treasure_hunter' && <span className="text-[6px] opacity-70">跳躍 x{treasureHunterJumpUses}</span>}
               {selectedJob === 'geologist' && <span className="text-[6px] opacity-70">地層スキャン {geologistScanUsed ? '済' : '1回'}</span>}
             </button>
             <button 
               onClick={setTank}
               disabled={isGameOver || isMoving || stepsRemaining > 0 || tankInventory <= 0}
               className={`flex-1 border-b-4 border-black text-[9px] font-black rounded-md flex flex-col items-center justify-center uppercase transition-all touch-manipulation
                 ${isSettingTank ? 'bg-white text-black translate-y-1 border-b-0 shadow-inner' : 'bg-orange-600 text-white active:translate-y-1 active:border-b-0 shadow-lg'}
               `}
             >
               <span>タンク</span>
               <span className="text-[6px] opacity-70">x{tankInventory}</span>
             </button>
          </div>
        </div>

        {/* Row 2: Controls */}
        <div className="flex items-center justify-between gap-4 mt-0.5 border-t border-white/5 pt-1">
           <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                 <div className={`w-1 h-1 rounded-full ${eggs > 0 ? 'bg-red-500 animate-ping' : 'bg-gray-700'}`} />
                 <span className="text-[5px] text-white/40 uppercase">プレート移動</span>
              </div>
              <div className="flex gap-0.5">
                 {[0,1,2,3].map(i => (
                   <div key={`seg-${i}`} className={`w-3 h-1 ${eggs > 0 ? 'bg-[#FF5252]' : 'bg-white/5'}`} />
                 ))}
              </div>
           </div>

           <div className="flex items-center gap-2">
              {selectedJob === 'scout' && (
                <button 
                  onClick={takeScoutStep}
                  disabled={!scoutExtraStepAvailable || stepsRemaining > 0}
                  className="w-10 h-10 bg-cyan-600 border-2 border-cyan-400 text-white rounded flex flex-col items-center justify-center active:bg-white active:text-cyan-600 disabled:opacity-20"
                >
                  <Zap size={14} />
                  <span className="text-[5px] font-black">ブースト</span>
                </button>
              )}
              <div className="flex flex-col gap-1">
                <div className="grid grid-cols-3 gap-1.5 bg-black/80 p-1.5 border-2 border-[#3E2723] rounded shadow-inner">
                   <div />
                   <button onClick={() => { setAutoPath([]); moveToOneStep(0, -1); }} className="w-11 h-11 bg-[#B71C1C] border-b-4 border-black text-white flex items-center justify-center active:translate-y-0.5 active:border-b-2 rounded shadow-md touch-manipulation"><ChevronUp className="w-7 h-7" /></button>
                   <div />
                   <button onClick={() => { setAutoPath([]); moveToOneStep(-1, 0); }} className="w-11 h-11 bg-[#B71C1C] border-b-4 border-black text-white flex items-center justify-center active:translate-y-0.5 active:border-b-2 rounded shadow-md touch-manipulation"><ChevronLeft className="w-7 h-7" /></button>
                   <div className="w-11 h-11 flex flex-col items-center justify-center bg-zinc-900 rounded border-2 border-white/5 shadow-inner">
                     <span className="text-[14px] font-black text-[#FFEB3B] leading-none">{stepsRemaining || '0'}</span>
                     <span className="text-[5px] text-white/40 font-black uppercase tracking-tighter">のこり</span>
                   </div>
                   <button onClick={() => { setAutoPath([]); moveToOneStep(1, 0); }} className="w-11 h-11 bg-[#B71C1C] border-b-4 border-black text-white flex items-center justify-center active:translate-y-0.5 active:border-b-2 rounded shadow-md touch-manipulation"><ChevronRight className="w-7 h-7" /></button>
                   <div />
                   <button onClick={() => { setAutoPath([]); moveToOneStep(0, 1); }} className="w-11 h-11 bg-[#B71C1C] border-b-4 border-black text-white flex items-center justify-center active:translate-y-0.5 active:border-b-2 rounded shadow-md touch-manipulation"><ChevronDown className="w-7 h-7" /></button>
                   <div />
                </div>
                <button
                  onClick={() => { setStepsRemaining(0); setAutoPath([]); }}
                  disabled={!(stepsRemaining > 0 && !isMoving)}
                  className={`w-full py-1 bg-zinc-700 border-b-2 border-black text-white text-[9px] font-black uppercase rounded touch-manipulation
                    ${stepsRemaining > 0 && !isMoving ? 'active:translate-y-0.5 active:border-none' : 'invisible pointer-events-none'}`}
                >
                  ターン終了
                </button>
              </div>
           </div>
        </div>
      </footer>

      {/* Overlays */}
      <AnimatePresence>
        {showDropModal && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 z-[160] flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <div className="bg-[#1A110D] border-4 border-[#3E2723] w-full max-w-xs shadow-[0_8px_0_#000] p-4 flex flex-col max-h-[80vh]">
               <div className="flex justify-between items-center mb-4 border-b-2 border-white/10 pb-2">
                  <h3 className="text-[10px] font-black text-white uppercase tracking-widest flex items-center gap-2">
                    <Skull className="w-4 h-4 text-[#FF5252]" /> アイテムを捨てる
                  </h3>
                  <button onClick={() => setShowDropModal(false)} className="text-white/40 hover:text-white"><Wind size={16} /></button>
               </div>
               
               <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                  {eggs > 0 && (
                    <div className="bg-black/40 p-3 border-2 border-red-500/50 flex justify-between items-center">
                       <div className="flex items-center gap-3">
                          <PixelEgg size="w-8 h-8" />
                          <div className="flex flex-col">
                            <span className="text-[8px] font-black text-[#FFD600] uppercase">ドラゴンの卵</span>
                            <span className="text-[5px] text-red-400 font-bold">警告：ミッション重要目標</span>
                          </div>
                       </div>
                       <button onClick={() => dropItem('egg')} className="px-3 py-1 bg-red-600 text-white text-[6px] font-black rounded border-b-2 border-black active:translate-y-0.5">破棄する</button>
                    </div>
                  )}

                  {inventory.treasures.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[5px] text-white/30 uppercase font-black">回収した宝物</span>
                      {inventory.treasures.map((t, i) => (
                        <div key={t.id} className="bg-black/40 p-2 border border-white/5 flex justify-between items-center">
                          <div className="flex items-center gap-3">
                             <div className="w-6 h-6">
                               {t.type === 'gem' ? <PixelGem size="w-full h-full" /> : 
                                t.type === 'document' ? <PixelDocument size="w-full h-full" /> : 
                                t.type === 'statue' ? <PixelStatue size="w-full h-full" /> : 
                                t.type === 'crystal' ? <PixelCrystal size="w-full h-full" /> : 
                                t.type === 'cursed' ? <PixelCursed size="w-full h-full" /> : null}
                             </div>
                             <div className="flex flex-col">
                               <span className="text-[7px] font-bold text-white uppercase">{t.name}</span>
                               <span className="text-[5px] text-white/40">価値:{t.value} 重量:{t.weight}</span>
                             </div>
                          </div>
                          <button onClick={() => dropItem('treasure', i)} className="px-2 py-1 bg-gray-700 text-white text-[6px] font-black rounded border-b-2 border-black active:translate-y-0.5">破棄する</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {(inventory.ores > 0 || inventory.scales > 0 || inventory.data > 0) && (
                    <div className="space-y-1 mt-4">
                      <span className="text-[5px] text-white/30 uppercase font-black">基本物資</span>
                      {inventory.ores > 0 && (
                        <div className="bg-black/40 p-2 border border-white/5 flex justify-between items-center">
                          <div className="flex items-center gap-2">
                             <PixelGem color="#4FC3F7" size="w-5 h-5" />
                             <span className="text-[7px] font-bold text-cyan-300 uppercase">貴重な鉱石 (x{inventory.ores})</span>
                          </div>
                          <button onClick={() => dropItem('ores')} className="px-2 py-1 bg-gray-800 text-white text-[6px] font-black rounded border-b-4 border-black active:translate-y-0.5">1つ捨てる</button>
                        </div>
                      )}
                      {inventory.scales > 0 && (
                        <div className="bg-black/40 p-2 border border-white/5 flex justify-between items-center">
                          <span className="text-[7px] font-bold text-[#FFEB3B] uppercase">ドラゴンの鱗 (x{inventory.scales})</span>
                          <button onClick={() => dropItem('scales')} className="px-2 py-1 bg-gray-800 text-white text-[6px] font-black rounded border-b-4 border-black active:translate-y-0.5">1つ捨てる</button>
                        </div>
                      )}
                      {inventory.data > 0 && (
                        <div className="bg-black/40 p-2 border border-white/5 flex justify-between items-center">
                          <span className="text-[7px] font-bold text-emerald-400 uppercase">調査データ (x{inventory.data})</span>
                          <button onClick={() => dropItem('data')} className="px-2 py-1 bg-gray-800 text-white text-[6px] font-black rounded border-b-4 border-black active:translate-y-0.5">1つ捨てる</button>
                        </div>
                      )}
                    </div>
                  )}

                  {eggs === 0 && inventory.treasures.length === 0 && inventory.ores === 0 && inventory.scales === 0 && inventory.data === 0 && (
                    <div className="text-center py-10 text-[6px] text-white/20 italic">アイテムを持っていません</div>
                  )}
               </div>

               <button 
                 onClick={() => setShowDropModal(false)}
                 className="w-full py-2 mt-4 bg-[#3E2723] text-white text-[8px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none"
               >
                 閉じる
               </button>
            </div>
          </motion.div>
        )}
        {gameResult && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-sm bg-[#1A110D] border-4 border-[#FFD600] shadow-[0_0_50px_rgba(0,0,0,0.8)] relative overflow-hidden"
            >
              {/* MISSION banner */}
              <motion.div
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className={`w-full py-3 text-center border-b-4 ${gameState === 'won' ? 'bg-[#FFD600] border-[#E65100] text-black' : 'bg-[#B71C1C] border-black text-white'}`}
                style={{ transformOrigin: 'left' }}
              >
                <div className="text-[10px] font-black uppercase tracking-[0.18em] drop-shadow-[2px_2px_0_rgba(0,0,0,0.4)]">
                  {gameState === 'won' ? '✦ MISSION COMPLETE ✦' : '✦ MISSION FAILED ✦'}
                </div>
              </motion.div>

              <div className="p-4">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-[0.04]">
                  <Trophy size={200} />
                </div>

                <div className="flex flex-col items-center mb-5 relative">
                  <motion.div
                    initial={{ scale: 0, rotate: -45 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', delay: 0.4 }}
                    className="flex items-baseline gap-2"
                  >
                    <RankReveal rank={gameResult.rank} won={gameState === 'won'} />
                    <span className="text-xl font-bold text-white opacity-40">ランク</span>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 1.2 }}
                    className="mt-2 bg-black/60 border-2 border-[#FFD600] px-6 py-1.5 flex flex-col items-center shadow-[0_0_15px_rgba(255,214,0,0.3)]"
                  >
                    <span className="text-[#FFD600] text-[12px] font-black uppercase tracking-[0.2em]">{gameResult.title}</span>
                  </motion.div>
                </div>

                <div className="space-y-3 mb-5">
                  <div className="bg-black/80 p-2.5 border border-white/10 rounded-sm">
                    <div className="flex justify-between items-center mb-2 border-b border-white/5 pb-1">
                      <span className="text-[8px] text-white/40 uppercase font-black">回収レポート</span>
                      <span className="text-[8px] text-[#FFD600] font-black">{gameState === 'won' ? '回収成功' : '消失'}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-1 max-h-24 overflow-y-auto pr-1">
                      {eggs > 0 && (
                        <div className="flex justify-between text-[8px] font-black text-[#FFD600]">
                          <span>ドラゴンの卵</span><span>+100</span>
                        </div>
                      )}
                      {gameResult.treasures.map((t) => (
                        <div key={t.id} className="flex justify-between text-[8px] border-b border-white/5 pb-0.5">
                          <span className="text-white/60 font-bold truncate pr-4">{t.name}</span>
                          <span className="text-cyan-400 font-black">+{t.value * 10}</span>
                        </div>
                      ))}
                      {inventory.ores > 0 && (
                        <div className="flex justify-between text-[8px] text-white/60 font-bold">
                          <span>貴重な鉱石 (x{inventory.ores})</span>
                          <span>+{inventory.ores * 20}</span>
                        </div>
                      )}
                      {gameResult.treasures.length === 0 && eggs === 0 && inventory.ores === 0 && (
                        <span className="text-[8px] text-white/20 italic text-center py-2">目ぼしい成果なし</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-zinc-900/80 p-2.5 border border-white/5 flex flex-col rounded-sm">
                      <span className="text-[7px] text-white/30 uppercase font-black mb-1">最終スコア</span>
                      <span className="text-[16px] font-black text-[#FFD600] leading-none">
                        <CountUpNumber target={gameResult.totalValue} delay={800} />
                      </span>
                    </div>
                    <div className="bg-zinc-900/80 p-2.5 border border-white/5 flex flex-col rounded-sm">
                      <span className="text-[7px] text-white/30 uppercase font-black mb-1">活動ターン数</span>
                      <span className="text-[16px] font-black text-white leading-none">{gameResult.turnCount}T</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setGameResult(null)}
                  className="w-full py-4 bg-[#FFD600] text-black font-black uppercase tracking-widest border-b-4 border-black active:translate-y-1 active:border-none shadow-[0_4px_0_#9E8500]"
                >
                  報酬を受け取る →
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {showBriefing && (
           <motion.div 
             initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
             className="fixed inset-0 bg-black/95 z-[110] flex items-center justify-center p-6"
           >
             <div className="border-4 border-[#D32F2F] bg-[#1A110D] p-6 w-full max-w-xs shadow-[0_8px_0_#000]">
                <div className="flex items-center gap-2 mb-4 border-b-2 border-[#D32F2F] pb-2">
                  <Flame className="w-5 h-5 text-[#FF5252]" />
                  <h2 className="text-sm font-black text-white">ミッション概要</h2>
                </div>
                <div className="text-[7px] text-white/90 font-bold leading-relaxed space-y-4 mb-6">
                  <p>親ドラゴン： <span className="text-[#FF5252]">死亡を確認</span></p>
                  <p>山頂の巣に「最後の卵」が一つだけ残されています。</p>
                  <p>目的： <span className="text-[#FFD600]">卵を確保し、山麓のヘリポート（H.C.P.）まで運び出してください。</span></p>
                  <p className="text-[#FF5252] font-black leading-none uppercase tracking-tighter">8ターン後に火山活動が激化</p>
                  <p className="text-white/40 italic">* スタート地点は安全ではありません。迅速な移動を推奨します。</p>
                </div>
                <button
                   onClick={() => setShowHowTo(true)}
                   className="w-full py-2 mb-2 bg-zinc-800 text-[#FFD600] font-black uppercase text-[9px] border-b-4 border-black active:translate-y-1 active:border-none"
                >
                  ❓ 遊び方を見る
                </button>
                <button
                   onClick={() => setShowBriefing(false)}
                   className="w-full py-3 bg-[#D32F2F] text-white font-black uppercase text-xs border-b-4 border-black active:translate-y-1 active:border-none"
                >
                  作戦開始
                </button>
             </div>
           </motion.div>
        )}

        {!selectedJob && !showBriefing && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/95 z-[100] flex items-center justify-center p-4"
          >
            <div className="border-4 border-[#D32F2F] bg-[#1A110D] w-full max-w-sm shadow-[0_8px_0_#000] flex flex-col max-h-[90vh] overflow-hidden">
              <div className="p-3 border-b-4 border-black text-center bg-[#D32F2F]">
                <div className="flex items-center justify-between mb-1">
                  <div className="w-8" />
                  <h2 className="text-[12px] font-black text-white drop-shadow-[0_2px_0_#000] tracking-widest uppercase">スペシャリスト選択</h2>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowRanking(true); }}
                    className="text-[6px] font-black text-[#FFD600] border border-[#FFD600] px-1.5 py-0.5 bg-black/40 active:bg-black/70"
                  >🏆 記録</button>
                </div>
                <div className="flex justify-center gap-1 mt-1">
                  {(['EASY', 'NORMAL', 'HARD', 'LEGEND'] as DifficultyType[]).map(d => (
                    <button
                      key={d}
                      onClick={(e) => { e.stopPropagation(); setDifficulty(d); }}
                      className={`px-2 py-0.5 text-[6px] font-black border-2 ${difficulty === d ? 'bg-[#FFD600] text-black border-white' : 'bg-black text-white/40 border-[#3E2723]'}`}
                    >
                      {d === 'EASY' ? 'かんたん' : d === 'NORMAL' ? 'ふつう' : d === 'HARD' ? 'むずかしい' : '極限'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {JOBS.map((job) => (
                  <motion.div
                    key={job.id}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => selectJob(job.id)}
                    className="bg-[#3E2723]/40 border-2 border-[#5D4037] p-3 flex flex-col gap-2 relative overflow-hidden active:bg-[#5D4037]/60 group"
                  >
                    {/* Beginner badge for leader */}
                    {job.id === 'leader' && (
                      <div className="absolute top-2 left-2 bg-green-600 text-white text-[6px] font-black px-1.5 py-0.5 rounded-full z-10">
                        🔰 初心者おすすめ
                      </div>
                    )}
                    {/* Difficulty Stars */}
                    <div className="absolute top-2 right-2 flex gap-0.5">
                      {[0, 1, 2, 3, 4].map((starIdx) => (
                        <span key={`star-${starIdx}`} className={`text-[6px] ${starIdx < job.difficulty ? 'text-[#FFD600]' : 'text-white/20'}`}>★</span>
                      ))}
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 flex items-center justify-center shrink-0" style={{ backgroundColor: job.color + '33', border: `1px solid ${job.color}` }}>
                         <PixelCharacter isMoving={false} isReturning={false} jobColor={job.color} />
                      </div>
                      <div>
                         <h3 className="text-[10px] font-black tracking-tighter" style={{ color: job.color }}>{job.name}</h3>
                         <p className="text-[6px] text-white/40 font-bold uppercase">{job.role}</p>
                      </div>
                    </div>

                    <div className="space-y-1 bg-black/40 p-2 border border-white/5">
                      <div className="flex items-start gap-1">
                        <Zap size={6} className="mt-0.5 text-[#FFD600]" />
                        <span className="text-[6px] text-white font-bold">{job.ability}</span>
                      </div>
                      <p className="text-[6px] text-white/60 leading-normal">{job.description}</p>
                    </div>

                    <div className="text-[6px] italic text-cyan-400 font-bold uppercase">
                      推奨： {job.recommend}
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="p-3 bg-black/40 border-t-2 border-black text-center">
                 <p className="text-[5px] text-white/30 uppercase tracking-[0.2em]">Survivor Protocol v2.5 // Classified Data</p>
              </div>
            </div>
          </motion.div>
        )}

        {isGameOver && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="fixed inset-0 bg-black/95 z-[150] flex flex-col items-center justify-center p-6 overflow-y-auto"
          >
            <div className="border-4 border-[#D32F2F] p-6 bg-[#1A110D] w-full max-w-xs shadow-[0_8px_0_#000] mb-4">
               <h2 className="text-xl font-black mb-2 text-white drop-shadow-[0_4px_0_#000] text-center">
                 {gameState === 'won' ? '卵の回収に成功！' : 'ミッション失敗'}
               </h2>
               <p className="text-[6px] text-[#FF5252] text-center mb-4 font-bold">{gameState === 'won' ? '絶滅は回避された。' : '調査員は二度と戻らなかった。'}</p>
               
               <div className="flex justify-center mb-4">
                  <div className="w-16 h-16 border-4 border-[#FFD600] bg-black flex items-center justify-center transform rotate-3">
                    <span className="text-4xl font-black text-[#FFD600]">{getRank()}</span>
                  </div>
               </div>

               <div className="bg-black text-white p-3 mb-4 uppercase text-[6px] flex flex-col gap-1 font-bold border-2 border-[#3E2723]">
                  <div className="flex justify-between border-b border-white/10 pb-1 mb-1 text-[#FFD600]">
                    <span>回収結果</span>
                    <span>合計 {eggs * 100 + inventory.ores * 30 + inventory.scales * 10 + inventory.data * 20} 点</span>
                  </div>
                  <div className="flex justify-between"><span>ドラゴンの卵</span><span>{eggs}</span></div>
                  <div className="flex justify-between"><span>貴重な鉱石</span><span>{inventory.ores}</span></div>
                  <div className="flex justify-between"><span>ドラゴンの鱗</span><span>{inventory.scales}</span></div>
                  <div className="flex justify-between"><span>調査データ</span><span>{inventory.data}</span></div>
                  <div className="flex justify-between pt-1 mt-1 border-t border-white/10">
                    <span>生存ボーナス</span>
                    <span>+{Math.max(0, 100 - turnCount)}</span>
                  </div>
                  <div className="flex justify-between text-cyan-400"><span>最終スコア</span><span>{persistent.points} pts</span></div>
               </div>
            </div>

            {/* Upgrade Shop */}
            <div className="border-4 border-[#333] bg-[#1A110D] p-4 w-full max-w-xs shadow-[0_4px_0_#000]">
               <h3 className="text-[7px] font-black text-[#FFD600] mb-3 uppercase tracking-tighter flex items-center gap-2">
                 <Zap className="w-3 h-3" /> 永続アップグレード
               </h3>
               <div className="flex flex-col gap-2">
                  <button 
                    onClick={() => buyUpgrade('hp')}
                    className="flex justify-between items-center p-2 bg-black border border-[#3E2723] text-[6px] font-bold disabled:opacity-50"
                    disabled={persistent.points < (persistent.upgrades.hp + 1) * 50}
                  >
                    <div className="flex items-center gap-2 text-white">
                      <Shield className="w-3 h-3 text-red-500" /> 
                      <span>HP上限 Lvl.{persistent.upgrades.hp}</span>
                    </div>
                    <span className="text-[#FFD600]">{(persistent.upgrades.hp + 1) * 50}P</span>
                  </button>
                  <button 
                    onClick={() => buyUpgrade('tanks')}
                    className="flex justify-between items-center p-2 bg-black border border-[#3E2723] text-[6px] font-bold disabled:opacity-50"
                    disabled={persistent.points < (persistent.upgrades.tanks + 1) * 50}
                  >
                    <div className="flex items-center gap-2 text-white">
                      <Briefcase className="w-3 h-3 text-blue-500" /> 
                      <span>予備タンク Lvl.{persistent.upgrades.tanks}</span>
                    </div>
                    <span className="text-[#FFD600]">{(persistent.upgrades.tanks + 1) * 50}P</span>
                  </button>
                  <button 
                    onClick={() => buyUpgrade('speed')}
                    className="flex justify-between items-center p-2 bg-black border border-[#3E2723] text-[6px] font-bold disabled:opacity-50"
                    disabled={persistent.points < (persistent.upgrades.speed + 1) * 50}
                  >
                    <div className="flex items-center gap-2 text-white">
                      <Zap className="w-3 h-3 text-yellow-500" /> 
                      <span>初速(最小出目) Lvl.{persistent.upgrades.speed}</span>
                    </div>
                    <span className="text-[#FFD600]">{(persistent.upgrades.speed + 1) * 50}P</span>
                  </button>
               </div>
            </div>

            <button
              onClick={() => setShowRanking(true)}
              className="mt-3 w-full max-w-xs py-2 bg-black text-[#FFD600] font-black uppercase text-[8px] border-2 border-[#FFD600] active:opacity-70"
            >🏆 ランキングを見る</button>
            <button onClick={() => window.location.reload()} className="mt-2 w-full max-w-xs py-4 bg-[#D32F2F] text-white font-black uppercase text-xs border-b-4 border-black active:translate-y-1 active:border-none shadow-lg">再出撃する</button>
          </motion.div>
        )}

        {showRanking && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/95 z-[300] flex items-center justify-center p-4"
          >
            <div className="bg-[#1A110D] border-4 border-[#FFD600] w-full max-w-xs shadow-[0_8px_0_#000] overflow-hidden">
              <div className="bg-[#FFD600] p-3 text-center">
                <h2 className="text-[11px] font-black text-black tracking-widest uppercase">🏆 ベスト記録</h2>
              </div>
              <div className="p-4">
                {(persistent.rankings ?? []).length === 0 ? (
                  <p className="text-center text-white/40 text-[7px] py-6">まだ記録がありません。<br />ミッションを完了させよう！</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {(persistent.rankings ?? []).map((entry, i) => (
                      <div key={i} className={`flex items-center gap-2 p-2 border ${i === 0 ? 'border-[#FFD600] bg-[#FFD600]/10' : 'border-[#3E2723] bg-black/30'}`}>
                        <span className={`text-[10px] font-black w-5 text-center ${i === 0 ? 'text-[#FFD600]' : i === 1 ? 'text-white/70' : 'text-white/40'}`}>
                          {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}
                        </span>
                        <div className={`text-[10px] font-black w-6 text-center border ${entry.rank === 'S' ? 'text-[#FFD600] border-[#FFD600]' : entry.rank === 'A' ? 'text-cyan-400 border-cyan-400' : 'text-white/60 border-white/30'}`}>
                          {entry.rank}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center">
                            <span className="text-[7px] font-black text-white">{entry.score.toLocaleString()} pts</span>
                            <span className={`text-[5px] font-bold px-1 ${entry.difficulty === 'LEGEND' ? 'text-[#FF5252]' : entry.difficulty === 'HARD' ? 'text-orange-400' : entry.difficulty === 'NORMAL' ? 'text-cyan-400' : 'text-white/50'}`}>
                              {entry.difficulty === 'EASY' ? 'かんたん' : entry.difficulty === 'NORMAL' ? 'ふつう' : entry.difficulty === 'HARD' ? 'むずかしい' : '極限'}
                            </span>
                          </div>
                          <div className="text-[5px] text-white/40">{JOBS.find(j => j.id === entry.job)?.name ?? entry.job} · {entry.turns}T · {entry.date}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowRanking(false)}
                className="w-full py-3 bg-black text-white font-black text-[8px] uppercase border-t-2 border-[#3E2723] active:bg-[#3E2723]"
              >閉じる</button>
            </div>
          </motion.div>
        )}

        {showSystemMenu && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 z-[300] flex items-center justify-center p-6 backdrop-blur-md"
          >
            <div className="bg-[#1A110D] border-4 border-[#3E2723] w-full max-w-xs shadow-[0_12px_0_#000] p-6 flex flex-col text-center">
               <div className="mb-6">
                 <Settings className="w-10 h-10 text-[#FFD600] mx-auto mb-2" />
                 <h2 className="text-sm font-black text-white uppercase tracking-widest">システムメニュー</h2>
                 <p className="text-[7px] text-white/40 mt-1 uppercase">作戦管理</p>
               </div>

               <div className="space-y-4">
                 <button 
                   onClick={() => window.location.reload()}
                   className="w-full py-4 bg-[#B71C1C] text-white text-[10px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none shadow-xl flex items-center justify-center gap-2"
                 >
                   <RefreshCw size={14} /> 最初からやり直す
                 </button>
                 
                 <button
                   onClick={resetAndSelectJob}
                   className="w-full py-4 bg-[#D32F2F] text-white text-[10px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none shadow-xl flex items-center justify-center gap-2"
                 >
                   <Users size={14} /> 職業を選び直す
                 </button>

                 <button
                   onClick={() => { setShowHowTo(true); setShowSystemMenu(false); }}
                   className="w-full py-3 bg-zinc-700 text-[#FFD600] text-[9px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none flex items-center justify-center gap-2"
                 >
                   ❓ 遊び方を確認する
                 </button>
                 <button
                   onClick={() => setShowSystemMenu(false)}
                   className="w-full py-3 bg-zinc-800 text-white text-[8px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none"
                 >
                   戻る
                 </button>
               </div>
            </div>
          </motion.div>
        )}
        {showHowTo && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/95 z-[400] flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <div className="bg-[#1A110D] border-4 border-[#FFD600] w-full max-w-sm shadow-[0_8px_0_#000] flex flex-col max-h-[90vh]">
              <div className="p-3 bg-[#FFD600] flex items-center justify-between shrink-0">
                <h2 className="text-[11px] font-black text-black uppercase tracking-widest">❓ 遊び方</h2>
                <button onClick={() => setShowHowTo(false)} className="text-black font-black text-[10px] px-2 py-0.5 bg-black/20 active:bg-black/40">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-5 text-[10px] text-white/90 leading-loose font-bold scrollbar-hide">

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">🎯 ゴール</h3>
                  <p>右上の山頂にある<span className="text-[#FFD600]">ドラゴンの卵🥚</span>を拾い、左下の<span className="text-cyan-400">ヘリポート(H)</span>まで持ち帰ればクリア！</p>
                </section>

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">🎲 基本の流れ</h3>
                  <ol className="space-y-2 list-none">
                    <li>① <span className="text-[#FFD600]">ダイスを振る</span> → 出た数だけ移動できる歩数を獲得</li>
                    <li>② <span className="text-[#FFD600]">矢印ボタン</span>で1マスずつ移動する</li>
                    <li>③ 歩数を使い切ったら次のターンへ</li>
                  </ol>
                </section>

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">❤️ リソース管理</h3>
                  <ul className="space-y-2">
                    <li>🟢 <span className="text-emerald-400">スーツ耐久値</span>…移動1歩ごとに-2%。0になるとHPが減り始める</li>
                    <li>🔴 <span className="text-red-400">HP</span>…0になるとゲームオーバー</li>
                    <li>🟠 <span className="text-orange-400">酸素タンク</span>…使うとスーツ耐久を+40%回復。大事に使おう</li>
                  </ul>
                </section>

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">⚠️ 危険要素</h3>
                  <ul className="space-y-2">
                    <li>💣 <span className="text-red-400">火山弾</span>…数字で着弾タイミングを予告。その場にいるとダメージ</li>
                    <li>🌊 <span className="text-orange-400">溶岩上昇</span>…卵を拾った後8ターンでヘリが離陸する！急いで戻れ</li>
                    <li>💨 <span className="text-gray-400">煙・熱波</span>…視界が悪くなったりスーツが余計に減ったりする</li>
                    <li>⬜ <span className="text-white/60">不安定な床</span>…通過後に崩れて通れなくなる</li>
                  </ul>
                </section>

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">🏆 勝利条件（難易度別）</h3>
                  <ul className="space-y-2">
                    <li><span className="text-white/50">かんたん</span>…卵だけ持ち帰ればOK</li>
                    <li><span className="text-cyan-400">ふつう</span>…卵 + サブアイテム1種類（鉱石・鱗・データのどれか1つ）</li>
                    <li><span className="text-orange-400">むずかしい</span>…卵 + サブアイテム2種類</li>
                    <li><span className="text-[#FF5252]">極限</span>…卵 + サブアイテム3種類すべて</li>
                  </ul>
                </section>

                <section>
                  <h3 className="text-[#FFD600] font-black uppercase mb-2 text-[12px] border-b border-[#FFD600]/30 pb-1">💡 コツ</h3>
                  <ul className="space-y-2">
                    <li>・初めてなら<span className="text-white/70">リーダー</span>か<span className="text-white/70">軍人</span>がオススメ</li>
                    <li>・スーツ耐久が30%を切ったらタンクを使おう</li>
                    <li>・卵を拾ったらすぐ帰還ルートを確認！</li>
                    <li>・<span className="text-[#FFD600]">マップのタイルをタップ</span>するとそのマスの説明が表示されるよ！</li>
                  </ul>
                </section>
              </div>
              <button
                onClick={() => setShowHowTo(false)}
                className="m-3 py-3 bg-[#D32F2F] text-white text-[10px] font-black uppercase border-b-4 border-black active:translate-y-1 active:border-none shrink-0"
              >
                わかった！
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        .font-pixel { font-family: 'Press Start 2P', cursive; }
        .magma-tile { animation: magma-glow 2.2s ease-in-out infinite; }
        @keyframes magma-glow {
          0%, 100% { opacity: 0.78; }
          50% { opacity: 1.0; }
        }
      `}</style>
      </div>
    </div>
  );
}
