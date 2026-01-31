// --- 0. SOUND ENGINE (Web Audio API) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSound(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    
    if (type === 'buy' || type === 'sell') {
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.start(now); osc.stop(now + 0.3);
    } else if (type === 'close') {
        osc.frequency.setValueAtTime(1200, now);
        osc.type = 'triangle';
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.15);
        osc.start(now); osc.stop(now + 0.15);
    } else if (type === 'error') {
        osc.frequency.setValueAtTime(150, now);
        osc.type = 'sawtooth';
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
    }
}

// --- 1. CORE CONFIG & STATE ---
const SYMBOL = "KRW-BTC";

let state = {
    price: 0,
    balance: 10000000,
    lev: 20,
    mode: 'Cross',
    pos: null, 
    drawings: [], 
    asks: [], bids: [],
    tf: '1' // Default to 1 minute
};

// --- 2. PERSISTENCE (LocalStorage) ---
function saveState() {
    const s = { 
        balance: state.balance, lev: state.lev, mode: state.mode, 
        pos: state.pos, drawings: state.drawings 
    };
    localStorage.setItem('upbit_pro_v1', JSON.stringify(s));
}

function loadState() {
    const s = localStorage.getItem('upbit_pro_v1');
    if (s) {
        const d = JSON.parse(s);
        state.balance = d.balance ?? 10000000;
        state.lev = d.lev ?? 20;
        state.mode = d.mode ?? 'Cross';
        state.pos = d.pos ?? null;
        state.drawings = d.drawings ?? [];
        
        document.getElementById('lev-disp').innerText = state.lev + "x";
        document.getElementById('margin-type').innerText = state.mode;
        updateBal();
        renderPosTable();
    }
}

function resetData() {
    localStorage.removeItem('upbit_pro_v1');
    showToast("데이터가 초기화되었습니다. 새로고침하세요.");
    setTimeout(() => location.reload(), 1000);
}

// --- 3. CHART ENGINE ---
const chart = LightweightCharts.createChart(document.getElementById('chart-container'), {
    layout: { backgroundColor: '#121212', textColor: '#848e9c' },
    grid: { vertLines: { color: '#1e2026' }, horzLines: { color: '#1e2026' } },
    timeScale: { borderColor: '#262930', timeVisible: true },
    rightPriceScale: { borderColor: '#262930' },
    crosshair: { mode: 0 },
});
const candleSeries = chart.addCandlestickSeries({ upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d' });

const canvas = document.getElementById('draw-layer');
const ctx = canvas.getContext('2d');
new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    chart.applyOptions({ width, height });
    canvas.width = width; canvas.height = height;
    draw();
}).observe(document.getElementById('chart-container'));

// --- 4. DATA FEED (Upbit) ---
async function fetchUpbitKlineData(market, unit, interval, count = 200) {
    try {
        const url = `https://api.upbit.com/v1/candles/${unit}/${interval}?market=${market}&count=${count}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Upbit Kline API Network response was not ok');
        const data = await response.json();
        return data.map(d => ({
            time: new Date(d.candle_date_time_utc).getTime() / 1000,
            open: d.opening_price,
            high: d.high_price,
            low: d.low_price,
            close: d.trade_price,
        })).reverse();
    } catch (error) {
        console.error(`Failed to fetch kline data for ${market}:`, error);
        return [];
    }
}

async function updateRealtimeData() {
    try {
        const response = await fetch(`https://api.upbit.com/v1/ticker?markets=${SYMBOL}`);
        if (!response.ok) return;
        const data = await response.json();
        const ticker = data[0];
        if (!ticker) return;

        const newPrice = ticker.trade_price;
        const prev = state.price;
        state.price = newPrice;
        
        // Update Chart
        const lastCandle = candleSeries.dataByIndex(candleSeries.data().length - 1);
        if (lastCandle) {
            const updatedCandle = { ...lastCandle, close: newPrice };
            if (newPrice > updatedCandle.high) updatedCandle.high = newPrice;
            if (newPrice < updatedCandle.low) updatedCandle.low = newPrice;
            candleSeries.update(updatedCandle);
        }

        // Update Header
        document.getElementById('head-price').innerText = newPrice.toLocaleString();
        document.getElementById('head-price').className = `tg-val ${newPrice >= prev ? 'up' : 'down'}`;
        document.getElementById('head-chg').innerText = (ticker.signed_change_rate * 100).toFixed(2) + '%';
        document.getElementById('head-high').innerText = ticker.high_price.toLocaleString();
        document.getElementById('head-low').innerText = ticker.low_price.toLocaleString();

        // Update Mid Price
        const midEl = document.getElementById('mid-price');
        const arrowEl = document.getElementById('mid-arrow');
        midEl.innerText = newPrice.toLocaleString();
        midEl.className = `mid-price ${newPrice >= prev ? 'text-up' : 'text-down'}`;
        arrowEl.innerText = newPrice >= prev ? '▲' : '▼';
        arrowEl.className = `mid-arrow ${newPrice >= prev ? 'text-up' : 'text-down'}`;

        checkTpSl();
        updatePosBadge();
        renderPosTable();

    } catch(e) { console.error(e) }
}

async function init() {
    loadState();
    let [unit, interval] = getTfUnit(state.tf);
    const bars = await fetchUpbitKlineData(SYMBOL, unit, interval);
    candleSeries.setData(bars);
    if(bars.length) state.price = bars[bars.length - 1].close;

    // Init Fake Orderbook
    let p = state.price;
    state.asks = Array.from({length:15}, (_,i) => ({p:p+(i+1)*1000, q:Math.random()}));
    state.bids = Array.from({length:15}, (_,i) => ({p:p-(i+1)*1000, q:Math.random()}));

    // Start Polling
    updateRealtimeData();
    setInterval(updateRealtimeData, 2000); // Poll every 2 seconds
}


// Fake Activity Loop (0.05s) for order book
setInterval(() => {
    const target = Math.random() > 0.5 ? state.asks : state.bids;
    if(target.length) {
        const idx = Math.floor(Math.random()*10);
        target[idx].q += (Math.random()-0.5)*0.5;
        if(target[idx].q < 0) target[idx].q = 0.05;
    }
    renderOrderBook();
}, 50);

function renderOrderBook() {
    const askEl = document.getElementById('asks');
    const bidEl = document.getElementById('bids');
    const draw = (arr, type) => arr.slice(0,14).map(x => {
        let w = Math.min(100, x.q*20);
        let bgClass = type==='ask'?'bg-ask':'bg-bid';
        let txtClass = type==='ask'?'text-down':'text-up';
        return `<div class="ob-row" onclick="setPrice(${x.p})">
            <div class="bg-bar ${bgClass}" style="width:${w}%"></div>
            <span class="ob-price ${txtClass}">${x.p.toLocaleString()}</span>
            <span class="ob-qty">${Math.abs(x.q).toFixed(3)}</span>
            <span class="ob-total">${(x.p*x.q/1000000).toFixed(1)}M</span>
        </div>`
    }).join('');
    askEl.innerHTML = draw(state.asks, 'ask');
    bidEl.innerHTML = draw(state.bids, 'bid');
}

// --- 5. TRADING LOGIC ---
function setPrice(p) { document.getElementById('inp-price').value = p; calcCost(); }

function calcCost() {
    let p = parseFloat(document.getElementById('inp-price').value) || state.price;
    let q = parseFloat(document.getElementById('inp-qty').value) || 0;
    document.getElementById('cost-disp').innerText = ((p*q)/state.lev).toLocaleString(undefined, {maximumFractionDigits: 0}) + " KRW";
}

function setQtyPct(pct) {
    let p = parseFloat(document.getElementById('inp-price').value) || state.price;
    if(p === 0) return;
    let max = (state.balance * state.lev) / p;
    document.getElementById('inp-qty').value = (max * (pct/100)).toFixed(3);
    calcCost();
}

function syncSlider(val) {
    let p = parseFloat(document.getElementById('inp-price').value) || state.price;
    if(p === 0) return;
    let max = (state.balance * state.lev) / p;
    document.getElementById('slider-qty').value = (val/max)*100;
    calcCost();
}

function openPos(side) {
    let q = parseFloat(document.getElementById('inp-qty').value);
    let p = parseFloat(document.getElementById('inp-price').value) || state.price;
    if(!q || p === 0) { playSound('error'); return showToast('수량과 가격을 확인해주세요.'); }
    
    let cost = (p*q)/state.lev;
    if(cost > state.balance) { playSound('error'); return showToast('잔고가 부족합니다.'); }
    
    let fee = -(p * q * 0.0005); // Upbit fee ~0.05%
    state.balance -= cost;
    state.pos = { side, qty: q, entry: p, lev: state.lev, mode: state.mode, realized: fee, tp: 0, sl: 0 };
    
    playSound(side==='long'?'buy':'sell');
    saveState();
    renderPosTable();
    updateBal();
    showToast('주문이 체결되었습니다.');
}

function closePosition() {
    if(!state.pos) return;
    let p = state.price;
    let pnl = (p - state.pos.entry) * state.pos.qty * (state.pos.side==='long'?1:-1);
    let margin = (state.pos.qty * state.pos.entry) / state.pos.lev;
    let fee = -(p * state.pos.qty * 0.0005);
    
    state.balance += (margin + pnl + fee); // Realized PNL doesn't exist yet, so add fee directly
    state.pos = null;
    
    playSound('close');
    saveState();
    renderPosTable();
    updateBal();
    updatePosBadge();
    showToast('포지션이 시장가로 종료되었습니다.');
}

function renderPosTable() {
    const tbody = document.getElementById('pos-body');
    if(!state.pos) { tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#555">보유 중인 포지션이 없습니다.</td></tr>`; return; }
    
    let p = state.pos;
    let cur = state.price;
    let pnl = (cur - p.entry) * p.qty * (p.side==='long'?1:-1);
    let roe = (pnl / ((p.qty*p.entry)/p.lev)) * 100;
    let colorClass = pnl >= 0 ? 'text-up' : 'text-down';
    
    let liq = p.side==='long' ? p.entry*(1 - (1/p.lev)*0.99) : p.entry*(1 + (1/p.lev)*0.99); // Simplified liq price

    tbody.innerHTML = `<tr>
        <td>
            <div style="display:flex;align-items:center;gap:6px">
                <span class="${p.side==='long'?'text-up':'text-down'}" style="font-weight:900;font-size:14px">${p.side==='long'?'Long':'Short'}</span>
                <span style="font-weight:700">${SYMBOL}</span>
            </div>
            <div style="font-size:10px;background:#333;padding:2px 4px;border-radius:3px;width:fit-content;margin-top:4px;color:#aaa">${p.mode} ${p.lev}x</div>
        </td>
        <td>${p.qty.toFixed(3)}</td>
        <td>${(p.qty*cur).toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
        <td>${p.entry.toLocaleString()}</td>
        <td class="${colorClass}">${cur.toLocaleString()}</td>
        <td style="color:var(--accent)">${liq.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
        <td>
            <div class="${colorClass}" style="font-weight:700">${pnl.toLocaleString(undefined, {maximumFractionDigits: 0})} KRW</div>
            <div class="${colorClass}" style="font-size:11px">${roe.toFixed(2)}%</div>
        </td>
        <td class="text-down">${p.realized.toLocaleString(undefined, {maximumFractionDigits: 0})} KRW</td>
        <td>--</td>
        <td><button class="btn-action" onclick="closePosition()">시장가 종료</button></td>
    </tr>`;
}

function checkTpSl() {}

// --- 6. DRAWING TOOLS ---
let tool = 'cursor', isDraw = false, startPt = null;
function setTool(t) {
    tool = t;
    document.querySelectorAll('.dt-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.dt-btn[onclick*="${t}"]`).classList.add('active');
    
    if(t !== 'cursor') {
        chart.applyOptions({ handleScroll: false, handleScale: false });
        document.getElementById('draw-layer').style.pointerEvents = 'auto';
        showToast(`${t==='line'?'추세선':'가로줄'} 그리기 모드`);
    } else {
        chart.applyOptions({ handleScroll: {mouseWheel:true, pressedMouseMove:true}, handleScale: {axisPressedMouseMove:true, mouseWheel:true, pinch:true} });
        document.getElementById('draw-layer').style.pointerEvents = 'none';
    }
    if(t==='eraser'){ state.drawings = []; draw(); saveState(); setTool('cursor'); showToast('모든 드로잉 삭제됨'); }
}
canvas.addEventListener('mousedown', e => {
    if (tool === 'cursor') return;
    const r = canvas.getBoundingClientRect();
    startPt = { x: e.clientX - r.left, y: e.clientY - r.top };
    startPt.t = chart.timeScale().coordinateToTime(startPt.x);
    startPt.p = candleSeries.coordinateToPrice(startPt.y);
    isDraw = true;
});
canvas.addEventListener('mousemove', e => {
    if(!isDraw) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    draw();
    ctx.beginPath(); ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 2;
    const x1 = chart.timeScale().timeToCoordinate(startPt.t);
    const y1 = candleSeries.priceToCoordinate(startPt.p);
    ctx.moveTo(x1, y1);
    if(tool === 'hline') ctx.lineTo(canvas.width, y1);
    else ctx.lineTo(x, y);
    ctx.stroke();
});
canvas.addEventListener('mouseup', e => {
    if (!isDraw) return;
    const r = canvas.getBoundingClientRect();
    const t = chart.timeScale().coordinateToTime(e.clientX - r.left);
    const p = candleSeries.coordinateToPrice(e.clientY - r.top);
    if(tool === 'hline') state.drawings.push({ type:'h', p: startPt.p });
    else if(tool === 'line') state.drawings.push({ type:'l', t1: startPt.t, p1: startPt.p, t2: t, p2: p });
    isDraw = false;
    draw();
    saveState();
});
chart.timeScale().subscribeVisibleTimeRangeChange(draw);
function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    state.drawings.forEach(d => {
        ctx.beginPath(); ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 2;
        if(d.type === 'h') {
            const y1 = candleSeries.priceToCoordinate(d.p);
            if(y1) { ctx.moveTo(0, y1); ctx.lineTo(canvas.width, y1); }
        } else {
            const x1 = chart.timeScale().timeToCoordinate(d.t1);
            const y1 = candleSeries.priceToCoordinate(d.p1);
            const x2 = chart.timeScale().timeToCoordinate(d.t2);
            const y2 = candleSeries.priceToCoordinate(d.p2);
            if(x1 && y1 && x2 && y2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
        }
        ctx.stroke();
    });
}

// --- 7. UTILS & MODALS ---
function updateBal() { document.getElementById('balance').innerText = Math.floor(state.balance).toLocaleString(); }
function updatePosBadge() {
    const b = document.getElementById('pos-badge');
    if(!state.pos) { b.style.display='none'; return; }
    const y = candleSeries.priceToCoordinate(state.pos.entry);
    if(y) {
        b.style.display='block'; b.style.top = y + 'px'; b.style.left = '50%';
        let pnl = (state.price - state.pos.entry) * state.pos.qty * (state.pos.side==='long'?1:-1);
        document.getElementById('pb-pnl').innerText = (pnl>0?'+':'') + pnl.toLocaleString(undefined, {maximumFractionDigits: 0});
        document.getElementById('pb-pnl').className = pnl>=0?'text-up':'text-down';
        document.getElementById('pb-qty').innerText = state.pos.qty + ' BTC';
    } else b.style.display='none';
}
function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg; t.style.display='block';
    setTimeout(()=>t.style.display='none', 2000);
}
function openMarginModal() { 
    document.getElementById('modal-margin').style.display='flex'; 
    document.getElementById('modal-lev-val').innerText = state.lev + 'x';
}
function closeModal(id) { document.getElementById(id).style.display='none'; }
function setMarginMode(m) { 
    state.mode = m; 
    document.getElementById('tab-cross').className = m==='Cross'?'mm-tab active':'mm-tab';
    document.getElementById('tab-isolated').className = m==='Isolated'?'mm-tab active':'mm-tab';
}
function updateModalLev(v) { state.lev = v; document.getElementById('modal-lev-val').innerText = v+'x'; }
function confirmMargin() {
    document.getElementById('lev-disp').innerText = state.lev + 'x';
    closeModal('modal-margin');
    saveState();
    showToast(`레버리지 ${state.lev}x 설정 완료`);
}

function getTfUnit(tf) {
    if (['D', 'W', 'M'].includes(tf)) return ['days', 1]; // Upbit doesn't support W/M in the same way, simplifying to days
    return ['minutes', tf];
}

function setTF(tf) {
    state.tf = tf;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    init(); // Reload chart
}

setInterval(()=>document.getElementById('clock').innerText = new Date().toLocaleTimeString(), 1000);

init(); // Start!