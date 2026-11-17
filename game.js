const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Logical dimensions (crisp High-DPI scaling)
const GAME_WIDTH = 400;
const GAME_HEIGHT = 600;
const GROUND_HEIGHT = 80;
const PLAYABLE_HEIGHT = GAME_HEIGHT - GROUND_HEIGHT;

function setupHighDPICanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = GAME_WIDTH * dpr;
    canvas.height = GAME_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupHighDPICanvas();

// Hover Physics Constants (60 FPS normalized)
const GRAVITY = 0.33;
const THRUST_ACCEL = -0.76; // Net upward acceleration when holding thrusters
const MAX_RISE_SPEED = -6.0;
const MAX_FALL_SPEED = 7.2;
const PIPE_WIDTH = 62;
const PIPE_GAP = 154;
const PIPE_SPEED = 2.65;
const PIPE_SPAWN_INTERVAL = 96;
const BEST_SCORE_KEY = 'teslaRoadsterHoverBestScore_v2';

// Game state
let gameState = 'start'; // 'start' | 'playing' | 'gameover'
let score = 0;
let bestScore = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
let isNewBest = false;
let gameOverTime = 0;
let flashAlpha = 0;
let muted = false;

// Input state (hold to hover!)
let pointerHeld = false;
let keyHeld = false;
function isThrusting() {
    return gameState === 'playing' && (pointerHeld || keyHeld);
}

// Timing & animation
let lastTime = performance.now();
let spawnTimer = 0;
let idleTime = 0;
let groundOffset = 0;
let thrusterFlicker = 0;
let thrustLevel = 0; // Smooth 0..1 visual intensity for thruster plumes

// Player: 2026 Silver Roadster (Cold-Gas Package)
let roadster = createInitialRoadster();

function createInitialRoadster() {
    return {
        x: 72,
        y: PLAYABLE_HEIGHT * 0.48,
        width: 74,
        height: 25,
        velocity: 0,
        rotation: 0
    };
}

// World entities
let pipes = [];
let vaporParticles = [];
let stars = generateStars(46);
let facilityTowers = generateFacilitySilhouette();

function generateStars(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
        arr.push({
            x: Math.random() * GAME_WIDTH,
            y: Math.random() * (PLAYABLE_HEIGHT * 0.72),
            r: 0.7 + Math.random() * 1.4,
            phase: Math.random() * Math.PI * 2
        });
    }
    return arr;
}

function generateFacilitySilhouette() {
    return [
        { x: 18, w: 34, h: 68, type: 'tank' },
        { x: 64, w: 18, h: 108, type: 'tower' },
        { x: 132, w: 58, h: 42, type: 'hangar' },
        { x: 224, w: 22, h: 92, type: 'tower' },
        { x: 270, w: 40, h: 55, type: 'tank' },
        { x: 335, w: 52, h: 46, type: 'hangar' }
    ];
}

// --- Web Audio Synth (Cold-Gas Nitrogen Hisssss + Chime + Thud) ---
let audioCtx = null;
let thrustGainNode = null;

function ensureAudio() {
    if (muted) return null;
    try {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            audioCtx = new Ctx();

            // Create continuous filtered white-noise loop for cold-gas thruster hiss
            const bufferSize = audioCtx.sampleRate * 1.5;
            const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const data = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noiseSource = audioCtx.createBufferSource();
            noiseSource.buffer = noiseBuffer;
            noiseSource.loop = true;

            const bandpass = audioCtx.createBiquadFilter();
            bandpass.type = 'bandpass';
            bandpass.frequency.value = 1850;
            bandpass.Q.value = 0.9;

            thrustGainNode = audioCtx.createGain();
            thrustGainNode.gain.value = 0;

            noiseSource.connect(bandpass);
            bandpass.connect(thrustGainNode);
            thrustGainNode.connect(audioCtx.destination);
            noiseSource.start();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    } catch {
        return null;
    }
}

function updateThrusterAudio(active) {
    if (!audioCtx || !thrustGainNode) return;
    try {
        const target = (!muted && active) ? 0.065 : 0;
        thrustGainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.03);
    } catch {
        // Ignore audio errors
    }
}

function playEventSound(type) {
    const ac = ensureAudio();
    if (!ac || muted) return;
    try {
        const now = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);

        if (type === 'score') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(660, now);
            osc.frequency.setValueAtTime(920, now + 0.06);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
            osc.start(now);
            osc.stop(now + 0.2);
        } else if (type === 'crash') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(160, now);
            osc.frequency.exponentialRampToValueAtTime(42, now + 0.25);
            gain.gain.setValueAtTime(0.14, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
            osc.start(now);
            osc.stop(now + 0.27);
        }
    } catch {
        // Ignore
    }
}

// --- Helper Path ---

function roundedRectPath(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// --- Environment Drawing (Night Test Facility) ---

function drawBackground() {
    // Deep twilight/night sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, PLAYABLE_HEIGHT);
    skyGrad.addColorStop(0, '#020617');
    skyGrad.addColorStop(0.55, '#0b1329');
    skyGrad.addColorStop(1, '#172554');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, GAME_WIDTH, PLAYABLE_HEIGHT);

    // Subtle twinkling stars
    stars.forEach(s => {
        const twinkle = 0.4 + 0.55 * Math.sin(idleTime * 0.04 + s.phase);
        ctx.fillStyle = `rgba(226, 232, 240, ${twinkle.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
    });

    // Subtle horizon floodlight glow from the test pad
    const padGlow = ctx.createRadialGradient(GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 10, GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 240);
    padGlow.addColorStop(0, 'rgba(56, 189, 248, 0.16)');
    padGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.06)');
    padGlow.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = padGlow;
    ctx.fillRect(0, PLAYABLE_HEIGHT - 220, GAME_WIDTH, 220);

    // Distant test-stand & hangar silhouettes
    facilityTowers.forEach(f => {
        const y = PLAYABLE_HEIGHT - f.h;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        if (f.type === 'tower') {
            ctx.fillRect(f.x, y, f.w, f.h);
            // Lattice crossbars & red aviation beacon
            ctx.strokeStyle = 'rgba(51, 65, 85, 0.55)';
            ctx.lineWidth = 1;
            for (let ty = y + 12; ty < PLAYABLE_HEIGHT; ty += 16) {
                ctx.beginPath();
                ctx.moveTo(f.x, ty);
                ctx.lineTo(f.x + f.w, ty + 12);
                ctx.stroke();
            }
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.arc(f.x + f.w / 2, y - 3, 2, 0, Math.PI * 2);
            ctx.fill();
        } else if (f.type === 'tank') {
            roundedRectPath(f.x, y, f.w, f.h + 8, 12);
            ctx.fill();
        } else {
            ctx.fillRect(f.x, y, f.w, f.h);
        }
    });
}

function drawGround() {
    const y = PLAYABLE_HEIGHT;

    // Red LED laser/runway light bar along the top of the test pad (nod to Roadster unveiling)
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, y, GAME_WIDTH, 3);
    const redGlow = ctx.createLinearGradient(0, y - 10, 0, y + 12);
    redGlow.addColorStop(0, 'rgba(239, 68, 68, 0)');
    redGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.45)');
    redGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = redGlow;
    ctx.fillRect(0, y - 10, GAME_WIDTH, 22);

    // Concrete/Asphalt test pad
    const roadGrad = ctx.createLinearGradient(0, y + 3, 0, GAME_HEIGHT);
    roadGrad.addColorStop(0, '#1e293b');
    roadGrad.addColorStop(1, '#090d16');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, y + 3, GAME_WIDTH, GROUND_HEIGHT - 3);

    // Scrolling dashed runway markings & white/cyan edge ticks
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    const tickPeriod = 32;
    const tickStart = -(groundOffset % tickPeriod);
    for (let x = tickStart - tickPeriod; x < GAME_WIDTH + tickPeriod; x += tickPeriod) {
        ctx.fillRect(x, y + 9, 14, 2);
    }

    ctx.fillStyle = '#facc15';
    const dashPeriod = 54;
    const dashStart = -(groundOffset % dashPeriod);
    for (let x = dashStart - dashPeriod; x < GAME_WIDTH + dashPeriod; x += dashPeriod) {
        roundedRectPath(x, y + 40, 28, 4, 2);
        ctx.fill();
    }
}

// --- Pipes Drawing ---

function drawPipes() {
    pipes.forEach(pipe => {
        drawSinglePipe(pipe.x, 0, PIPE_WIDTH, pipe.topHeight, 'top');
        drawSinglePipe(pipe.x, pipe.bottomY, PIPE_WIDTH, PLAYABLE_HEIGHT - pipe.bottomY, 'bottom');
    });
}

function drawSinglePipe(x, y, w, h, side) {
    if (h <= 0) return;

    const capH = 24;
    const overhang = 5;

    const pipeGrad = ctx.createLinearGradient(x, 0, x + w, 0);
    pipeGrad.addColorStop(0, '#064e3b');
    pipeGrad.addColorStop(0.2, '#10b981');
    pipeGrad.addColorStop(0.38, '#6ee7b7');
    pipeGrad.addColorStop(0.7, '#059669');
    pipeGrad.addColorStop(1, '#022c22');

    ctx.fillStyle = pipeGrad;
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.6;

    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Specular highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x + 9, y + 1, 6, h - 2);

    // Flanged pipe cap
    const capY = side === 'top' ? y + h - capH : y;
    const capX = x - overhang;
    const capW = w + overhang * 2;

    const capGrad = ctx.createLinearGradient(capX, 0, capX + capW, 0);
    capGrad.addColorStop(0, '#064e3b');
    capGrad.addColorStop(0.2, '#34d399');
    capGrad.addColorStop(0.36, '#a7f3d0');
    capGrad.addColorStop(0.7, '#059669');
    capGrad.addColorStop(1, '#022c22');

    ctx.fillStyle = capGrad;
    roundedRectPath(capX, capY, capW, capH, 4);
    ctx.fill();
    ctx.stroke();

    // Rim highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(capX + 10, capY + 2, 7, capH - 4);
}

// --- Cold-Gas Nitrogen Vapor Particles ---

function spawnThrusterVapor(intensity) {
    if (intensity < 0.12) return;
    // Nozzle anchor offsets matching the 4 underbody cold-gas jets (front pair + rear pair)
    const cx = roadster.x + roadster.width / 2;
    const cy = roadster.y + roadster.height / 2;
    const cos = Math.cos(roadster.rotation);
    const sin = Math.sin(roadster.rotation);

    const nozzleLocalXs = [-16, -11, 14, 19]; // Rear pair + Front pair underbody
    const localY = roadster.height / 2 + 2;

    // Spawn 2-3 vapor puffs per frame across the nozzles
    const count = intensity > 0.6 ? 3 : 1;
    for (let i = 0; i < count; i++) {
        const lx = nozzleLocalXs[Math.floor(Math.random() * nozzleLocalXs.length)];
        const wx = cx + lx * cos - localY * sin;
        const wy = cy + lx * sin + localY * cos;

        vaporParticles.push({
            x: wx + (Math.random() - 0.5) * 3,
            y: wy + Math.random() * 6,
            vx: -1.1 - Math.random() * 1.4,
            vy: 3.2 + Math.random() * 2.8 * intensity,
            radius: 2.5 + Math.random() * 3.5 * intensity,
            life: 1,
            decay: 0.042 + Math.random() * 0.025
        });
    }
}

function updateVaporParticles(dt) {
    for (let i = vaporParticles.length - 1; i >= 0; i--) {
        const p = vaporParticles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.radius += 0.16 * dt;
        p.life -= p.decay * dt;

        // Billow sideways if hitting the test pad
        if (p.y >= PLAYABLE_HEIGHT - 2) {
            p.y = PLAYABLE_HEIGHT - 2;
            p.vy = -0.3 * Math.random();
            p.vx -= 0.6;
        }

        if (p.life <= 0) {
            vaporParticles.splice(i, 1);
        }
    }
}

function drawVaporParticles() {
    vaporParticles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life * 0.45);
        ctx.fillStyle = '#e0f2fe';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

// --- Cold-Gas Underbody Plumes ---

function drawColdGasPlumes(left, top, w, h, intensity) {
    if (intensity <= 0.04) return;

    // 4 downward-pointing cold-gas thruster jets (2 front, 2 rear — matching the unveiling photo)
    const nozzles = [
        { x: left + 16, scale: 0.92 },
        { x: left + 22, scale: 1.0 },
        { x: left + w - 21, scale: 0.95 },
        { x: left + w - 15, scale: 0.88 }
    ];
    const nozzleY = top + h - 3;

    nozzles.forEach((n, idx) => {
        const jitter = Math.sin(thrusterFlicker * 1.7 + idx * 2.1) * 4;
        const plumeLen = (26 + jitter) * intensity * n.scale;
        const plumeW = (4.8 + intensity * 1.5) * n.scale;

        // Outer pressurized nitrogen mist cone
        const outerGrad = ctx.createLinearGradient(n.x, nozzleY, n.x, nozzleY + plumeLen);
        outerGrad.addColorStop(0, `rgba(224, 242, 254, ${0.9 * intensity})`);
        outerGrad.addColorStop(0.45, `rgba(125, 211, 252, ${0.55 * intensity})`);
        outerGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');

        ctx.fillStyle = outerGrad;
        ctx.beginPath();
        ctx.moveTo(n.x - 1.6, nozzleY);
        ctx.lineTo(n.x + 1.6, nozzleY);
        ctx.lineTo(n.x + plumeW, nozzleY + plumeLen);
        ctx.lineTo(n.x - plumeW, nozzleY + plumeLen);
        ctx.closePath();
        ctx.fill();

        // Bright white supersonic core shock cone
        const coreGrad = ctx.createLinearGradient(n.x, nozzleY, n.x, nozzleY + plumeLen * 0.65);
        coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.98 * intensity})`);
        coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.moveTo(n.x - 1.1, nozzleY);
        ctx.lineTo(n.x + 1.1, nozzleY);
        ctx.lineTo(n.x + plumeW * 0.45, nozzleY + plumeLen * 0.65);
        ctx.lineTo(n.x - plumeW * 0.45, nozzleY + plumeLen * 0.65);
        ctx.closePath();
        ctx.fill();
    });
}

// --- 2026 Tesla Roadster Drawing (Angular Silver Wedge + Aero-Disc Wheels) ---

function drawRoadster() {
    const cx = roadster.x + roadster.width / 2;
    const cy = roadster.y + roadster.height / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(roadster.rotation);

    const w = roadster.width;   // 74
    const h = roadster.height;  // 25
    const left = -w / 2;     // -37
    const top = -h / 2;      // -12.5

    // Draw the 4 downward cold-gas thruster jets first (behind lower wheels/diffuser)
    drawColdGasPlumes(left, top, w, h, thrustLevel);

    // Crisp LED headlight beam in the night test facility
    if (gameState !== 'gameover') {
        const beamGrad = ctx.createLinearGradient(left + w - 2, top + 13, left + w + 58, top + 13);
        beamGrad.addColorStop(0, 'rgba(224, 242, 254, 0.42)');
        beamGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(left + w - 2, top + 13);
        ctx.lineTo(left + w + 58, top + 4);
        ctx.lineTo(left + w + 58, top + 24);
        ctx.closePath();
        ctx.fill();
    }

    // Main angular silver wedge body (matching the 2026 Roadster side profile)
    const bodyGrad = ctx.createLinearGradient(0, top, 0, top + h - 4);
    bodyGrad.addColorStop(0, '#ffffff');
    bodyGrad.addColorStop(0.28, '#e2e8f0');
    bodyGrad.addColorStop(0.68, '#cbd5e1');
    bodyGrad.addColorStop(1, '#94a3b8');

    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    // Rear bottom diffuser corner
    ctx.moveTo(left + 3, top + h - 5);
    // High angular Kamm-tail rear fascia (distinctive sharp rear deck)
    ctx.lineTo(left + 1, top + 9.5);
    ctx.lineTo(left + 6, top + 6.5);
    // Tapered fastback rear haunch up to low coupe roof
    ctx.lineTo(left + 28, top + 0.5);
    ctx.lineTo(left + 40, top + 0.5);
    // Swept angular windshield & low wedge front hood
    ctx.lineTo(left + 57, top + 8.5);
    ctx.lineTo(left + w - 1, top + 13.5);
    // Sharp vertical front nose & chin splitter
    ctx.lineTo(left + w - 1, top + h - 4.5);
    ctx.lineTo(left + 3, top + h - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Dark carbon lower rocker skirt & sculpted rear diffuser (visible in photo!)
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(left + 2, top + h - 5);
    ctx.lineTo(left + 14, top + h - 8.5);
    ctx.lineTo(left + w - 14, top + h - 7.5);
    ctx.lineTo(left + w - 1, top + h - 4.5);
    ctx.lineTo(left + 2, top + h - 4.5);
    ctx.closePath();
    ctx.fill();

    // Aggressive rear diffuser cutout
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(left + 1, top + 13);
    ctx.lineTo(left + 9, top + 13.5);
    ctx.lineTo(left + 7, top + h - 5);
    ctx.lineTo(left + 1.5, top + h - 5);
    ctx.closePath();
    ctx.fill();

    // Angular glass greenhouse / side window (wedge coupe shape)
    const glassGrad = ctx.createLinearGradient(0, top + 1.5, 0, top + 10);
    glassGrad.addColorStop(0, '#020617');
    glassGrad.addColorStop(0.65, '#0f172a');
    glassGrad.addColorStop(1, '#334155');
    ctx.fillStyle = glassGrad;

    ctx.beginPath();
    ctx.moveTo(left + 16, top + 8.5);
    ctx.lineTo(left + 30, top + 2);
    ctx.lineTo(left + 40, top + 2);
    ctx.lineTo(left + 53, top + 8.5);
    ctx.lineTo(left + 16, top + 8.8);
    ctx.closePath();
    ctx.fill();

    // Subtle glass reflection & B-pillar cut
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(left + 25, top + 4.5);
    ctx.lineTo(left + 42, top + 4.5);
    ctx.stroke();

    // Crisp angular body beltline highlight
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(left + 6, top + 9.5);
    ctx.lineTo(left + 57, top + 11.2);
    ctx.stroke();

    // Sharp Red LED Taillight bar on the high rear deck (like in the photo!)
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(left + 1, top + 8.2, 6, 2.3);
    ctx.fillStyle = '#fca5a5';
    ctx.fillRect(left + 1, top + 8.7, 4, 1);

    // Sharp White LED Front Headlight slit
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(left + w - 4.5, top + 13.2, 4, 1.8);

    // Wheel wells
    const rearWheelX = left + 16;
    const frontWheelX = left + w - 16;
    const wheelY = top + h - 5.2;

    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.arc(rearWheelX, wheelY, 7.6, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(frontWheelX, wheelY, 7.4, Math.PI, 0);
    ctx.fill();

    // Signature Roadster Solid Aero-Disc Wheels (seen clearly in the photo!)
    drawAeroDiscWheel(rearWheelX, wheelY, 6.7);
    drawAeroDiscWheel(frontWheelX, wheelY, 6.5);

    ctx.restore();
}

function drawAeroDiscWheel(x, y, radius) {
    ctx.save();
    ctx.translate(x, y);

    // Low-profile tire
    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // Solid metallic aero-disc cover
    const discGrad = ctx.createLinearGradient(-radius, -radius, radius, radius);
    discGrad.addColorStop(0, '#94a3b8');
    discGrad.addColorStop(0.5, '#475569');
    discGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = discGrad;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Outer silver aero lip
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 1.6, 0, Math.PI * 2);
    ctx.stroke();

    // Center hub cap
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

// --- HUD & Overlay Screens ---

function drawScoreHUD() {
    ctx.save();
    ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    ctx.strokeText(String(score), GAME_WIDTH / 2, 26);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(String(score), GAME_WIDTH / 2, 26);
    ctx.restore();
}

function drawTopBadges() {
    // Left badge: Cold-Gas Thruster Status
    ctx.save();
    const active = thrustLevel > 0.25;
    ctx.fillStyle = active ? 'rgba(14, 165, 233, 0.28)' : 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = active ? '#38bdf8' : '#334155';
    ctx.lineWidth = 1.2;
    roundedRectPath(12, 12, 118, 24, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = active ? '#38bdf8' : '#94a3b8';
    ctx.beginPath();
    ctx.arc(24, 24, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('COLD-GAS 10K PSI', 32, 24.5);
    ctx.restore();

    // Right badge: Sound Mute Toggle
    ctx.save();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;
    roundedRectPath(GAME_WIDTH - 78, 12, 66, 24, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(muted ? 'Muted' : 'Sound On', GAME_WIDTH - 22, 18);
    ctx.restore();
}

function drawStartOverlay() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Title Banner
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    roundedRectPath(GAME_WIDTH / 2 - 150, 68, 300, 78, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('ROADSTER HOVER', GAME_WIDTH / 2, 97);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('COLD-GAS THRUSTER EDITION', GAME_WIDTH / 2, 124);

    // Pulsing hover instruction pill
    const pulse = 0.78 + 0.22 * Math.sin(idleTime * 0.08);
    ctx.fillStyle = `rgba(14, 165, 233, ${0.85 * pulse})`;
    roundedRectPath(GAME_WIDTH / 2 - 142, PLAYABLE_HEIGHT - 122, 284, 44, 22);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Hold Click or Space to Hover', GAME_WIDTH / 2, PLAYABLE_HEIGHT - 100);

    if (bestScore > 0) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(`Best Score: ${bestScore}`, GAME_WIDTH / 2, PLAYABLE_HEIGHT - 56);
    }

    ctx.restore();
}

function drawGameOverOverlay() {
    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 23, 0.62)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const cardW = 286;
    const cardH = 228;
    const cardX = (GAME_WIDTH - cardW) / 2;
    const cardY = (PLAYABLE_HEIGHT - cardH) / 2 - 10;

    ctx.fillStyle = '#0f172a';
    roundedRectPath(cardX, cardY, cardW, cardH, 18);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#ef4444';
    ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('GAME OVER', GAME_WIDTH / 2, cardY + 38);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('SCORE', cardX + cardW * 0.3, cardY + 86);
    ctx.fillText('BEST', cardX + cardW * 0.7, cardY + 86);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(String(score), cardX + cardW * 0.3, cardY + 118);
    ctx.fillText(String(bestScore), cardX + cardW * 0.7, cardY + 118);

    if (isNewBest) {
        ctx.fillStyle = '#f59e0b';
        roundedRectPath(GAME_WIDTH / 2 - 48, cardY + 144, 96, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = '800 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('NEW BEST!', GAME_WIDTH / 2, cardY + 155);
    }

    ctx.fillStyle = '#0284c7';
    roundedRectPath(GAME_WIDTH / 2 - 108, cardY + 174, 216, 38, 19);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Click or Space to Restart', GAME_WIDTH / 2, cardY + 193);

    ctx.restore();
}

// --- Update & Collision Logic ---

function updateEnvironment(dt, speedMultiplier = 1) {
    groundOffset += PIPE_SPEED * speedMultiplier * dt;
    thrusterFlicker += 0.45 * dt;
}

function updateRoadster(dt) {
    const thrusting = isThrusting();

    if (thrusting) {
        roadster.velocity = Math.max(roadster.velocity + (GRAVITY + THRUST_ACCEL) * dt, MAX_RISE_SPEED);
        thrustLevel = Math.min(1, thrustLevel + 0.25 * dt);
        spawnThrusterVapor(thrustLevel);
    } else {
        roadster.velocity = Math.min(roadster.velocity + GRAVITY * dt, MAX_FALL_SPEED);
        thrustLevel = Math.max(0, thrustLevel - 0.18 * dt);
    }

    updateThrusterAudio(thrusting);

    roadster.y += roadster.velocity * dt;

    // Gentle ceiling clamp
    if (roadster.y < 2) {
        roadster.y = 2;
        if (roadster.velocity < 0) roadster.velocity = 0;
    }

    // Stabilized thruster attitude: slight pitch up when rising, slight pitch down when falling
    const targetRot = Math.max(-0.22, Math.min(0.28, roadster.velocity * 0.036));
    roadster.rotation += (targetRot - roadster.rotation) * Math.min(1, 0.16 * dt);
}

function updatePipes(dt) {
    spawnTimer += dt;
    if (spawnTimer >= PIPE_SPAWN_INTERVAL) {
        spawnTimer = 0;
        const minHeight = 56;
        const maxHeight = PLAYABLE_HEIGHT - PIPE_GAP - minHeight;
        const topHeight = Math.floor(Math.random() * (maxHeight - minHeight + 1)) + minHeight;

        pipes.push({
            x: GAME_WIDTH + 10,
            topHeight,
            bottomY: topHeight + PIPE_GAP,
            passed: false
        });
    }

    for (let i = pipes.length - 1; i >= 0; i--) {
        const pipe = pipes[i];
        pipe.x -= PIPE_SPEED * dt;

        if (!pipe.passed && pipe.x + PIPE_WIDTH < roadster.x + 10) {
            score++;
            pipe.passed = true;
            playEventSound('score');
        }

        if (pipe.x + PIPE_WIDTH + 12 < 0) {
            pipes.splice(i, 1);
        }
    }
}

function checkCollision() {
    const hitX = roadster.x + 8;
    const hitY = roadster.y + 4;
    const hitW = roadster.width - 16;
    const hitH = roadster.height - 6;

    // Ground collision
    if (hitY + hitH >= PLAYABLE_HEIGHT) {
        roadster.y = PLAYABLE_HEIGHT - roadster.height + 1;
        return true;
    }

    // Pipe collision
    for (const pipe of pipes) {
        if (hitX < pipe.x + PIPE_WIDTH && hitX + hitW > pipe.x) {
            if (hitY < pipe.topHeight || hitY + hitH > pipe.bottomY) {
                return true;
            }
        }
    }

    return false;
}

function triggerGameOver() {
    gameState = 'gameover';
    gameOverTime = performance.now();
    flashAlpha = 0.7;
    thrustLevel = 0;
    updateThrusterAudio(false);
    playEventSound('crash');

    if (score > bestScore) {
        bestScore = score;
        isNewBest = true;
        try {
            localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
        } catch {
            // Ignore
        }
    }
}

function resetToStart() {
    roadster = createInitialRoadster();
    pipes = [];
    vaporParticles = [];
    spawnTimer = PIPE_SPAWN_INTERVAL * 0.65;
    score = 0;
    isNewBest = false;
    thrustLevel = 0.45;
    gameState = 'start';
}

// --- Main Game Loop ---

function gameLoop(now) {
    const rawDt = (now - lastTime) / 16.6667;
    const dt = Math.min(Math.max(rawDt, 0.1), 2.5);
    lastTime = now;

    ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    if (gameState === 'start') {
        idleTime += dt;
        updateEnvironment(dt, 0.55);
        // Gentle idle cold-gas hover demonstration above the McGregor test pad
        roadster.y = PLAYABLE_HEIGHT * 0.48 + Math.sin(idleTime * 0.07) * 6;
        roadster.rotation = Math.sin(idleTime * 0.07) * 0.02;
        thrustLevel = 0.52 + 0.14 * Math.sin(idleTime * 0.14);
        if (Math.random() < 0.45) spawnThrusterVapor(0.45);
        updateVaporParticles(dt);

        drawBackground();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawStartOverlay();
        drawTopBadges();
    } else if (gameState === 'playing') {
        idleTime += dt;
        updateEnvironment(dt, 1);
        updateRoadster(dt);
        updatePipes(dt);
        updateVaporParticles(dt);

        if (checkCollision()) {
            triggerGameOver();
        }

        drawBackground();
        drawPipes();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawScoreHUD();
        drawTopBadges();
    } else if (gameState === 'gameover') {
        idleTime += dt;
        updateVaporParticles(dt);
        if (flashAlpha > 0) {
            flashAlpha = Math.max(0, flashAlpha - 0.06 * dt);
        }

        drawBackground();
        drawPipes();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawGameOverOverlay();
        drawTopBadges();

        if (flashAlpha > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
            ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        }
    }

    requestAnimationFrame(gameLoop);
}

// --- Input Handling (Hold to Hover) ---

function handleStartOrRestart() {
    ensureAudio();
    if (gameState === 'start') {
        gameState = 'playing';
        spawnTimer = PIPE_SPAWN_INTERVAL * 0.65;
        roadster.velocity = -2.2; // Smooth initial lift
    } else if (gameState === 'gameover') {
        if (performance.now() - gameOverTime > 320) {
            resetToStart();
        }
    }
}

canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const scaleX = GAME_WIDTH / rect.width;
    const scaleY = GAME_HEIGHT / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    // Mute badge click
    if (clickX >= GAME_WIDTH - 82 && clickY <= 40) {
        muted = !muted;
        if (muted) updateThrusterAudio(false);
        return;
    }

    pointerHeld = true;
    handleStartOrRestart();
});

window.addEventListener('pointerup', () => {
    pointerHeld = false;
});

window.addEventListener('pointercancel', () => {
    pointerHeld = false;
});

window.addEventListener('blur', () => {
    pointerHeld = false;
    keyHeld = false;
    updateThrusterAudio(false);
});

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        if (!e.repeat) {
            keyHeld = true;
            handleStartOrRestart();
        }
    } else if (e.code === 'KeyM') {
        muted = !muted;
        if (muted) updateThrusterAudio(false);
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        keyHeld = false;
    }
});

// Start loop
requestAnimationFrame((now) => {
    lastTime = now;
    gameLoop(now);
});
