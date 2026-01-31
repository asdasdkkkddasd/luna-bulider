document.addEventListener('DOMContentLoaded', () => {
    console.log('Script started: DOMContentLoaded');

    // --- CONSTANTS ---
    const LEVERAGE = 20; // Fixed leverage for MVP
    const MMR = 0.005; // Maintenance Margin Rate (0.5%)
    const TAKER_FEE_RATE = 0.0004; // 0.04%
    const MAKER_FEE_RATE = 0.0002; // 0.02%
    const SPREAD_BPS = 2; // 2 bps = 0.02% (2/10000) - for spread calculation
    const SYMBOL = 'BTC-USDT'; // Hardcoded symbol

    // Order book constants
    const BOOK_LEVELS = 10;
    const LEVEL_QTY_MIN = 0.01;
    const LEVEL_QTY_MAX = 0.08;
    const TICK_SIZE = 0.5; // Price increment/decrement for order book levels

    // --- SHARED TYPES (from user's prompt, adapted to JS) ---
    /** @typedef { "BUY" | "SELL" } Side */
    /** @typedef { "LONG" | "SHORT" | "FLAT" } PosSide */
    /**
     * @typedef {object} Position
     * @property {PosSide} side
     * @property {number} qty // Always positive
     * @property {number} entryPrice
     * @property {number} [leverage]
     * @property {number} [markPrice]
     * @property {number} [unrealizedPnl]
     * @property {number} [notional]
     * @property {number} [maintenanceMargin]
     * @property {string} [status] // "OPEN" | "CLOSED" | "LIQUIDATED"
     * @property {Date} [updatedAt]
     */
    /**
     * @typedef {object} Fill
     * @property {Side} side
     * @property {number} qty
     * @property {number} price
     */

    // --- STATE (Source of Truth Model - Cross Margin Optimized) ---
    const state = {
        user: {
            uid: 'user-1',
            walletBalance: 10000, // Cash balance
            availableBalance: 10000, // Available for new orders/fees
            equity: 10000, // walletBalance + unrealizedPnlTotal
            unrealizedPnlTotal: 0,
            maintenanceMarginTotal: 0,
            marginMode: "CROSS",
            updatedAt: new Date(),
        },
        positions: {}, // Keyed by symbol, e.g., 'BTC-USDT' -> Position object
        orders: {},    // Keyed by orderId
        trades: {},    // Keyed by tradeId (Note: not fully used yet, but placeholder)
        ledger: [],    // Array of all financial events
        
        // --- Order Book and Tape ---
        orderBook: {
            bids: [], // [{ price, qty, userOrders: [] }]
            asks: [], // [{ price, qty, userOrders: [] }]
        },
        tape: [], // 최근 체결 [{ ts, side, price, qty }]

        // --- Client-side UI state ---
        ui: {
            orderType: 'limit',
            lastPrice: 60000, // Last markPrice
            currentPrice: 60000, // Current markPrice (mid-price)
            bidPrice: 59995,   // For spread
            askPrice: 60005,   // For spread
            lastFill: null, // Tracks last fill for order book flash animation
            tpPrice: null, // TP price for current position
            slPrice: null, // SL price for current position
            drag: { active: false, kind: null, orderId: null }, // Drag state for TP/SL and LIMIT lines
            tpSl: { // TP/SL trigger state
                activeCloseOrderId: null, // ID of the market order created by TP/SL trigger
                lastTrigger: null,        // "TP" | "SL" | null
            },
        },
        
        // --- Sequence for IDs ---
        nextOrderId: 1,
        nextTradeId: 1,
        nextLedgerId: 1,
    };

    // --- DOM ELEMENTS ---
    const bidPriceEl = document.getElementById('bid-price');
    const askPriceEl = document.getElementById('ask-price');
    const balanceDisplayEl = document.getElementById('balance-display');
    const ordersBodyEl = document.getElementById('orders-body');
    const positionsBodyEl = document.getElementById('positions-body');
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');
    const priceInput = document.getElementById('price');
    const quantityInput = document.getElementById('quantity');
    const limitOrderInputs = document.getElementById('limit-order-inputs');
    const tabs = document.querySelectorAll('.tab-btn');
    // New Order Book and Tape DOM elements
    const asksBodyEl = document.getElementById('asks-body');
    const bidsBodyEl = document.getElementById('bids-body');
    const tapeBodyEl = document.getElementById('tape-body');
    // Chart DOM elements
    const chartEl = document.getElementById('chart');
    const overlayEl = document.getElementById('chart-overlay');


    console.log('DOM Elements obtained:', { bidPriceEl, askPriceEl, balanceDisplayEl, ordersBodyEl, positionsBodyEl, buyBtn, sellBtn, priceInput, quantityInput, limitOrderInputs, tabs, asksBodyEl, bidsBodyEl, tapeBodyEl, chartEl, overlayEl });

    // --- CHART INITIALIZATION ---
    let chart, candleSeries;
    if (chartEl && window.LightweightCharts) {
        chart = LightweightCharts.createChart(chartEl, {
            layout: { backgroundColor: 'transparent', textColor: '#eaecef' },
            grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
            timeScale: { borderColor: 'rgba(255,255,255,0.12)' },
            crosshair: { mode: 0 },
        });

        candleSeries = chart.addCandlestickSeries({
            upColor: '#089981', // green
            downColor: '#f23645', // red
            borderDownColor: '#f23645',
            borderUpColor: '#089981',
            wickDownColor: '#f23645',
            wickUpColor: '#089981',
        });
        
        // Resize chart with window
        new ResizeObserver(entries => {
            if (entries.length === 0 || entries[0].contentRect.width === 0) return;
            chart.applyOptions({ width: entries[0].contentRect.width });
        }).observe(chartEl);
    }

    // --- LEDGER & ACCOUNT METRICS LOGIC ---
    /**
     * Adds an entry to the ledger and updates walletBalance.
     * @param {"FEE" | "REALIZED_PNL" | "DEPOSIT" | "WITHDRAW" | "LIQUIDATION_FEE"} type
     * @param {number} deltaWalletBalance
     * @param {object} ref
     */
    function addToLedger(type, deltaWalletBalance, ref = {}) {
        const entry = {
            id: state.nextLedgerId++,
            type,
            deltaWalletBalance,
            ref,
            createdAt: new Date(),
        };
        state.ledger.push(entry);
        state.user.walletBalance += deltaWalletBalance;
        state.user.updatedAt = new Date();
        updateAccountMetrics(); // Re-calculate all derived user metrics
        renderBalance();
        return entry;
    }

    function updateAccountMetrics() {
        // 1. Calculate unrealizedPnlTotal & maintenanceMarginTotal for all positions
        let unrealizedPnlTotal = 0;
        let maintenanceMarginTotal = 0;

        Object.values(state.positions).forEach(pos => {
            if (pos.status === 'OPEN' && pos.qty > 0) {
                // Update position-specific markPrice and unrealizedPnl
                pos.markPrice = state.ui.currentPrice; // Using markPrice as currentPrice for MVP
                pos.unrealizedPnl = calcUnrealizedPnl(pos, pos.markPrice);
                
                unrealizedPnlTotal += pos.unrealizedPnl;

                // Update position-specific notional and maintenanceMargin
                pos.notional = Math.abs(pos.qty) * pos.markPrice;
                pos.maintenanceMargin = pos.notional * MMR; // Assuming MMR is constant for all tiers for MVP
                maintenanceMarginTotal += pos.maintenanceMargin;
            }
        });
        state.user.unrealizedPnlTotal = unrealizedPnlTotal;
        state.user.maintenanceMarginTotal = maintenanceMarginTotal;

        // 2. Calculate equity
        state.user.equity = state.user.walletBalance + state.user.unrealizedPnlTotal;

        // 3. Calculate availableBalance (funds not locked by orders)
        let lockedByOrders = 0;
        Object.values(state.orders).forEach(o => {
            // Only count NEW or PARTIAL orders that haven't been filled yet
            if ((o.status === 'NEW' || o.status === 'PARTIAL') && o.lockedMarginAmount > 0) {
                lockedByOrders += o.lockedMarginAmount;
            }
        });
        state.user.availableBalance = state.user.walletBalance - lockedByOrders;
    }

    // --- BID/ASK & ORDER BOOK CALCULATION ---
    function updateBidAskFromMid(mid) {
        const halfSpread = mid * (SPREAD_BPS / 10000) / 2;
        state.ui.bidPrice = Math.max(0.01, mid - halfSpread);
        state.ui.askPrice = Math.max(state.ui.bidPrice + 0.01, mid + halfSpread); // Ensure ask > bid
    }

    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function roundToTick(price) {
        return Math.round(price / TICK_SIZE) * TICK_SIZE;
    }

    function rebuildOrderBookFromMid(mid) {
        const bestBid = state.ui.bidPrice;
        const bestAsk = state.ui.askPrice;

        const bids = [];
        const asks = [];

        for (let i = 0; i < BOOK_LEVELS; i++) {
            const bidPrice = roundToTick(Math.max(0.01, bestBid - i * TICK_SIZE));
            const askPrice = roundToTick(Math.max(bidPrice + TICK_SIZE, bestAsk + i * TICK_SIZE));

            bids.push({ price: bidPrice, qty: +rand(LEVEL_QTY_MIN, LEVEL_QTY_MAX).toFixed(4), userOrders: [] });
            asks.push({ price: askPrice, qty: +rand(LEVEL_QTY_MIN, LEVEL_QTY_MAX).toFixed(4), userOrders: [] });
        }

        state.orderBook.bids = bids;
        state.orderBook.asks = asks;
    }

    function pushTape(side, price, qty) {
        state.tape.unshift({
            ts: new Date(),
            side,
            price,
            qty,
        });
        if (state.tape.length > 30) state.tape.pop(); // 최근 30개만
    }

    // --- ORDER BOOK MANIPULATION ---
    function findLevel(side, price) {
        const levels = (side === 'BUY') ? state.orderBook.bids : state.orderBook.asks;
        const p = roundToTick(price);
        // Find level where price matches rounded price
        return levels.find(l => Math.abs(l.price - p) < 1e-9) || null;
    }

    function addLimitOrderToBook(order) {
        const lvl = findLevel(order.side, order.price);
        if (!lvl) {
            order.status = 'REJECTED';
            console.warn("LIMIT price out of book range, rejected:", order.price);
            return false;
        }

        lvl.userOrders.push(order.orderId);
        order.onBook = true; // Mark order as being on the book
        return true;
    }

    function removeOrderFromBook(order) {
        if (!order || !order.onBook) return;

        const lvl = findLevel(order.side, order.price);
        if (!lvl) return; // Level might have disappeared due to book rebuild

        lvl.userOrders = lvl.userOrders.filter(id => id !== order.orderId);
        order.onBook = false;
    }

    // --- CORE FINANCIAL LOGIC FUNCTIONS (from user's prompt) ---
    /**
     * Applies a fill to a position and returns the updated position and any realized PnL.
     * @param {Position} pos
     * @param {Fill} fill
     * @returns {{pos: Position, realizedPnl: number}}
     */
    function applyFillNet(pos, fill) {
        let realizedPnl = 0;

        // If no existing position or FLAT
        if (pos.side === "FLAT" || pos.qty === 0) {
            const newSide = fill.side === "BUY" ? "LONG" : "SHORT";
            return {
                pos: { side: newSide, qty: fill.qty, entryPrice: fill.price, status: "OPEN" },
                realizedPnl
            };
        }

        const sameDir =
            (pos.side === "LONG" && fill.side === "BUY") ||
            (pos.side === "SHORT" && fill.side === "SELL");

        if (sameDir) {
            // 평균단가 가중평균
            const newQty = pos.qty + fill.qty;
            const newEntry =
                (pos.qty * pos.entryPrice + fill.qty * fill.price) / newQty;
            return { pos: { ...pos, qty: newQty, entryPrice: newEntry }, realizedPnl };
        }

        // 반대 방향 체결 = 상쇄(청산) + (남으면 반전 오픈)
        const closeQty = Math.min(pos.qty, fill.qty);

        if (pos.side === "LONG") {
            realizedPnl += closeQty * (fill.price - pos.entryPrice);
        } else { // pos.side === "SHORT"
            realizedPnl += closeQty * (pos.entryPrice - fill.price);
        }

        const remainingPosQty = pos.qty - closeQty;
        const remainingFillQty = fill.qty - closeQty;

        if (remainingPosQty > 0) {
            // 포지션 일부만 줄고 방향 유지
            return {
                pos: { ...pos, qty: remainingPosQty },
                realizedPnl
            };
        }

        if (remainingFillQty > 0) {
            // 포지션 반전 오픈 (남은 물량이 새 포지션)
            const newSide = fill.side === "BUY" ? "LONG" : "SHORT";
            return {
                pos: { side: newSide, qty: remainingFillQty, entryPrice: fill.price, status: "OPEN" },
                realizedPnl
            };
        }

        // 완전 청산
        return { pos: { side: "FLAT", qty: 0, entryPrice: 0, status: "CLOSED" }, realizedPnl };
    }

    /**
     * Calculates the unrealized PnL for a position.
     * @param {Position} pos
     * @param {number} markPrice
     * @returns {number}
     */
    function calcUnrealizedPnl(pos, markPrice) {
        if (pos.side === "FLAT" || pos.qty === 0) return 0;
        const diff = markPrice - pos.entryPrice;
        return pos.side === "LONG" ? pos.qty * diff : pos.qty * (-diff);
    }


    // --- RENDER FUNCTIONS ---
    function renderBalance() {
        try {
            if (balanceDisplayEl) {
                balanceDisplayEl.innerText = `Wallet: ${state.user.walletBalance.toFixed(2)} | Avail: ${state.user.availableBalance.toFixed(2)} | Equity: ${state.user.equity.toFixed(2)} USDT`;
            }
        } catch (error) {
            console.error("Error rendering balance:", error);
        }
    }
    
    function renderPrice() {
        try {
            if (bidPriceEl && askPriceEl) {
                bidPriceEl.textContent = state.ui.bidPrice.toFixed(2);
                askPriceEl.textContent = state.ui.askPrice.toFixed(2);
            }
            updateAccountMetrics(); // Metrics depend on current price
            renderOrders(); // Re-render orders as they might be filled
            renderPositions(); // PnL updates with price
            renderOrderBook(); // Render order book with new data
            renderTape(); // Render trade tape with new data
            syncPositionLines(); // Update chart lines (ENTRY, TP, SL)
            syncLimitOrderLines(); // Update chart lines for LIMIT orders
        } catch (error) {
            console.error("Error rendering price:", error);
        }
    }

    function renderOrders() {
        try {
            const orders = Object.values(state.orders).filter(o => o.status === 'NEW' || o.status === 'PARTIAL');
            if (!ordersBodyEl) return;

            ordersBodyEl.innerHTML = '';
            if (orders.length === 0) {
                ordersBodyEl.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-secondary);">No open orders.</td></tr>`;
                return;
            }
            orders.forEach(order => {
                const tr = document.createElement('tr');
                const color = order.side === 'BUY' ? 'var(--price-up)' : 'var(--price-down)';
                tr.innerHTML = `
                    <td style="color: ${color}">${order.type} ${order.side}</td>
                    <td>${order.price.toFixed(2)}</td>
                    <td>${order.filledQty}/${order.qty}</td>
                    <td>${order.createdAt.toLocaleTimeString()}</td>
                    <td><button class="cancel-btn" data-id="${order.orderId}">Cancel</button></td>
                `;
                ordersBodyEl.appendChild(tr);
            });
        } catch (error) {
            console.error("Error rendering orders:", error);
        }
    }

    function renderPositions() {
        try {
            const positions = Object.values(state.positions).filter(p => p.status === 'OPEN' && p.qty > 0);
            if (!positionsBodyEl) return;

            positionsBodyEl.innerHTML = '';
            if (positions.length === 0) {
                positionsBodyEl.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-secondary);">No open positions.</td></tr>`; 
                return;
            }
            positions.forEach(pos => {
                // unrealizedPnl is already updated in updateAccountMetrics
                const pnlColor = pos.unrealizedPnl >= 0 ? 'var(--price-up)' : 'var(--price-down)';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: ${pos.side === 'LONG' ? 'var(--price-up)' : 'var(--price-down)'}">${pos.side}</td>
                    <td>${pos.entryPrice.toFixed(2)}</td>
                    <td>${state.ui.currentPrice.toFixed(2)}</td>
                    <td>${pos.qty}</td>
                    <td style="color: ${pnlColor}">${pos.unrealizedPnl.toFixed(2)}</td>
                    <td><button class="close-btn" data-symbol="${pos.symbol}">Close</button></td>
                `;
                positionsBodyEl.appendChild(tr);
            });
        } catch (error) {
            console.error("Error rendering positions:", error);
        }
    }

    function getMaxLevelQty(levels) {
        let max = 0;
        levels.forEach(l => { if (l.qty > max) max = l.qty; });
        return max || 1;
    }

    function countMyOrdersAtLevel(level) {
        return Array.isArray(level.userOrders) ? level.userOrders.length : 0;
    }

    function levelHasMyOrders(level) {
        return Array.isArray(level.userOrders) && level.userOrders.length > 0;
    }

    let lastTapeKey = ""; // Track for flashing trade tape entries

    function renderOrderBook() {
        try {
            if (!asksBodyEl || !bidsBodyEl) return;

            const asks = state.orderBook.asks || [];
            const bids = state.orderBook.bids || [];

            const maxAsk = getMaxLevelQty(asks);
            const maxBid = getMaxLevelQty(bids);

            // Asks
            asksBodyEl.innerHTML = '';
            // Sort asks from high to low price for display consistent with traditional order books
            [...asks].sort((a,b) => b.price - a.price).forEach(lvl => {
                const tr = document.createElement('tr');
                tr.className = `ob-row ${levelHasMyOrders(lvl) ? 'ob-own' : ''}`;
                tr.dataset.price = lvl.price;

                const pct = Math.max(0, Math.min(100, (lvl.qty / maxAsk) * 100));
                const myCount = countMyOrdersAtLevel(lvl);

                // Flash for order book level fills
                const lf = state.ui.lastFill;
                if (lf && (Date.now() - lf.ts) < 500 && Math.abs(lf.price - lvl.price) < 1e-9) {
                    tr.classList.add(lf.side === 'BUY' ? 'flash-dn' : 'flash-up'); // Market BUY fills ASKS (flash down for ask side)
                }

                tr.innerHTML = `
                <td class="ob-cell ob-ask" style="--w:${pct.toFixed(1)}%">
                    <span class="ob-bar ask"></span>
                    <span class="ob-text">${(+lvl.qty).toFixed(4)}</span>
                </td>
                <td class="ob-cell ob-ask" style="--w:${pct.toFixed(1)}%">
                    <span class="ob-bar ask"></span>
                    <span class="ob-text">
                    ${(+lvl.price).toFixed(2)}
                    ${myCount ? `<span class="ob-badge">MY ${myCount}</span>` : ``}
                    </span>
                </td>
                `;
                asksBodyEl.appendChild(tr);
            });

            // Bids
            bidsBodyEl.innerHTML = '';
            // Sort bids from high to low price for display
            [...bids].sort((a,b) => b.price - a.price).forEach(lvl => {
                const tr = document.createElement('tr');
                tr.className = `ob-row ${levelHasMyOrders(lvl) ? 'ob-own' : ''}`;
                tr.dataset.price = lvl.price;

                const pct = Math.max(0, Math.min(100, (lvl.qty / maxBid) * 100));
                const myCount = countMyOrdersAtLevel(lvl);

                // Flash for order book level fills
                const lf = state.ui.lastFill;
                if (lf && (Date.now() - lf.ts) < 500 && Math.abs(lf.price - lvl.price) < 1e-9) {
                    tr.classList.add(lf.side === 'BUY' ? 'flash-up' : 'flash-dn'); // Market SELL fills BIDS (flash up for bid side)
                }

                tr.innerHTML = `
                <td class="ob-cell ob-bid" style="--w:${pct.toFixed(1)}%">
                    <span class="ob-bar bid"></span>
                    <span class="ob-text">
                    ${(+lvl.price).toFixed(2)}
                    ${myCount ? `<span class="ob-badge">MY ${myCount}</span>` : ``}
                    </span>
                </td>
                <td class="ob-cell ob-bid" style="--w:${pct.toFixed(1)}%">
                    <span class="ob-bar bid"></span>
                    <span class="ob-text">${(+lvl.qty).toFixed(4)}</span>
                </td>
                `;
                bidsBodyEl.appendChild(tr);
            });
        } catch (error) {
            console.error("Error rendering order book:", error);
        }
    }

    function attachOrderBookClick() {
        const handler = (e) => {
            const row = e.target.closest('tr');
            if (!row || !row.dataset.price) return;

            const p = parseFloat(row.dataset.price);
            if (!Number.isFinite(p)) return;

            if (priceInput) priceInput.value = p.toFixed(2);
        };

        if (asksBodyEl) asksBodyEl.addEventListener('click', handler);
        if (bidsBodyEl) bidsBodyEl.addEventListener('click', handler);
    }

    function renderTape() {
        try {
            if (!tapeBodyEl) return;

            tapeBodyEl.innerHTML = '';
            if (!state.tape.length) {
                tapeBodyEl.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;">No trades yet.</td></tr>`;
                return;
            }

            const top = state.tape[0];
            const topKey = `${top.ts.getTime()}-${top.side}-${top.price}-${top.qty}`;

            state.tape.forEach((t, idx) => {
                const tr = document.createElement('tr');
                const sideColor = (t.side === 'BUY') ? 'var(--buy)' : 'var(--sell)';

                // ✅ 새로 들어온 맨 위 체결이면 flash
                if (idx === 0 && topKey !== lastTapeKey) {
                    tr.classList.add(t.side === 'BUY' ? 'flash-up' : 'flash-dn');
                }

                tr.innerHTML = `
                <td class="muted">${t.ts.toLocaleTimeString()}</td>
                <td style="color:${sideColor}">${t.side}</td>
                <td>${t.price.toFixed(2)}</td>
                <td>${(+t.qty).toFixed(4)}</td>
                `;
                tapeBodyEl.appendChild(tr);
            });

            lastTapeKey = topKey;
        } catch (error) {
            console.error("Error rendering tape:", error);
        }
    }


    // --- CHART PRICE LINE MANAGEMENT ---
    let entryLine = null, tpLine = null, slLine = null;
    let entryTag = null, tpTag = null, slTag = null;

    // LIMIT 주문 라인 관리 (orderId -> { line, tag })
    const limitLines = new Map(); // key: orderId

    // Helper to create or get an overlay tag element for TP/SL/Entry
    function ensureTag(kind) {
        if (!overlayEl) return null;
        let el = overlayEl.querySelector(`.line-tag.${kind.toLowerCase()}`);
        if (!el) {
            el = document.createElement('div');
            el.className = `line-tag ${kind.toLowerCase()}`;
            el.dataset.kind = kind;
            overlayEl.appendChild(el);
        }
        return el;
    }

    // Helper to create or get an overlay tag element for LIMIT orders
    function ensureLimitTag(orderId, side) {
        if (!overlayEl) return null;
        let el = overlayEl.querySelector(`.line-tag[data-order-id="${orderId}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = `line-tag ${side === 'BUY' ? 'tp' : 'sl'}`; // Reuse tp/sl for color
            el.dataset.kind = 'limit';
            el.dataset.orderId = String(orderId);
            overlayEl.appendChild(el);
        }
        return el;
    }

    // Helper to set position and text of a tag
    function setTag(el, y, text) {
        if (!el) return;
        el.style.top = `${y}px`;
        el.textContent = text;
        el.style.display = 'block';
    }

    // Helper to hide a tag
    function hideTag(el){ if (el) el.style.display = 'none'; }

    // Convert price to Y coordinate on the chart
    function priceToY(price){
        if (!candleSeries) return null;
        // Check for NaN or non-finite numbers before conversion
        if (!Number.isFinite(price)) return null;
        return candleSeries.priceToCoordinate(price);
    }

    // Convert Y coordinate to price on the chart
    function yToPrice(y){
        if (!candleSeries) return null;
        return candleSeries.coordinateToPrice(y);
    }

    function syncPositionLines() {
        if (!chart || !candleSeries || !overlayEl) return;

        const pos = state.positions[SYMBOL];
        if (!pos || pos.qty <= 0 || pos.side === "FLAT") {
            // If no position, hide all lines and tags
            if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
            if (tpLine) { candleSeries.removePriceLine(tpLine); tpLine = null; }
            if (slLine) { candleSeries.removePriceLine(slLine); slLine = null; }
            hideTag(entryTag); hideTag(tpTag); hideTag(slTag);
            state.ui.tpPrice = null; state.ui.slPrice = null; // Reset TP/SL state
            return;
        }

        // Initialize TP/SL prices if not set
        if (state.ui.tpPrice == null || state.ui.slPrice == null) {
            const base = pos.entryPrice;
            const step = base * 0.004; // 0.4% default
            if (pos.side === "LONG") {
                state.ui.tpPrice = base + step;
                state.ui.slPrice = base - step;
            } else { // SHORT
                state.ui.tpPrice = base - step;
                state.ui.slPrice = base + step;
            }
        }

        // ENTRY Line
        if (!entryLine) {
            entryLine = candleSeries.createPriceLine({ price: pos.entryPrice, color: '#f7a600', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY' });
            entryTag = ensureTag('entry');
        } else {
            entryLine.applyOptions({ price: pos.entryPrice });
        }

        // TP Line
        if (!tpLine) {
            tpLine = candleSeries.createPriceLine({ price: state.ui.tpPrice, color: '#0ecb81', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'TP' });
            tpTag = ensureTag('tp');
        } else {
            tpLine.applyOptions({ price: state.ui.tpPrice });
        }

        // SL Line
        if (!slLine) {
            slLine = candleSeries.createPriceLine({ price: state.ui.slPrice, color: '#f6465d', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
            slTag = ensureTag('sl');
        } else {
            slLine.applyOptions({ price: state.ui.slPrice });
        }

        // Update tag positions and text
        const ey = priceToY(pos.entryPrice);
        const ty = priceToY(state.ui.tpPrice);
        const sy = priceToY(state.ui.slPrice);

        if (ey != null) setTag(entryTag, ey, `ENTRY ${pos.entryPrice.toFixed(2)}`); else hideTag(entryTag);
        if (ty != null) setTag(tpTag, ty, `TP ${state.ui.tpPrice.toFixed(2)}`); else hideTag(tpTag);
        if (sy != null) setTag(slTag, sy, `SL ${state.ui.slPrice.toFixed(2)}`); else hideTag(slTag);
    }

    // Sync chart lines for open LIMIT orders
    function syncLimitOrderLines() {
        if (!candleSeries) return;

        // 1) Get current open LIMIT orders
        const openLimits = Object.values(state.orders).filter(o =>
            o.type === 'LIMIT' && (o.status === 'NEW' || o.status === 'PARTIAL') && o.symbol === SYMBOL
        );

        const aliveIds = new Set(openLimits.map(o => o.orderId));

        // 2) Remove lines/tags for orders that are no longer active
        for (const [orderId, obj] of limitLines.entries()) {
            if (!aliveIds.has(orderId)) {
                try { candleSeries.removePriceLine(obj.line); } catch (e) { console.warn("Error removing price line:", e); }
                if (obj.tag && obj.tag.parentNode) obj.tag.parentNode.removeChild(obj.tag);
                limitLines.delete(orderId);
            }
        }

        // 3) Create/Update lines and tags for active LIMIT orders
        openLimits.forEach(order => {
            const existing = limitLines.get(order.orderId);

            const color = (order.side === 'BUY') ? '#0ecb81' : '#f6465d'; // Green for BUY, Red for SELL
            const title = `${order.side} LIMIT`;

            if (!existing) {
                const line = candleSeries.createPriceLine({
                    price: order.price,
                    color,
                    lineWidth: 1, // Thinner line for limit orders
                    lineStyle: 2, // Dotted line
                    axisLabelVisible: true,
                    title,
                });

                const tag = ensureLimitTag(order.orderId, order.side);
                limitLines.set(order.orderId, { line, tag, side: order.side });
            } else {
                existing.line.applyOptions({ price: order.price });
                existing.side = order.side;
            }

            // Update tag position and text
            const y = priceToY(order.price);
            const obj = limitLines.get(order.orderId);
            if (obj && obj.tag && y != null) {
                const remaining = (order.qty - order.filledQty);
                obj.tag.style.top = `${y}px`;
                obj.tag.style.display = 'block';
                obj.tag.textContent = `${order.side} LIMIT ${order.price.toFixed(2)} (${remaining.toFixed(4)})`;
            } else if (obj && obj.tag) {
                hideTag(obj.tag);
            }
        });
    }

    // --- TP/SL DRAG LOGIC ---
    function pickLineKindByY(y) {
        const tol = 8; // Tolerance in pixels

        const tpY = state.ui.tpPrice != null ? priceToY(state.ui.tpPrice) : null;
        const slY = state.ui.slPrice != null ? priceToY(state.ui.slPrice) : null;

        if (tpY != null && Math.abs(y - tpY) <= tol) return "TP";
        if (slY != null && Math.abs(y - slY) <= tol) return "SL";
        return null;
    }

    // Pick nearest LIMIT order line for dragging
    function pickNearestLimitLine(y) {
        let best = null; // { orderId, dist }
        for (const [orderId, obj] of limitLines.entries()) {
            const order = state.orders[orderId];
            if (!order || order.status !== 'NEW' && order.status !== 'PARTIAL') continue;
            const ly = priceToY(order.price);
            if (ly == null) continue;

            const d = Math.abs(y - ly);
            if (d <= 8 && (!best || d < best.dist)) {
                best = { orderId, dist: d };
            }
        }
        return best ? best.orderId : null;
    }

    function clampTpSlToDirection(kind, price) {
        const pos = state.positions[SYMBOL];
        if (!pos || pos.qty <= 0 || pos.side === "FLAT") return price;

        const minDistance = TICK_SIZE; // Min distance from entry price

        if (pos.side === "LONG") {
            if (kind === "TP") return Math.max(price, pos.entryPrice + minDistance);
            if (kind === "SL") return Math.min(price, pos.entryPrice - minDistance);
        } else { // SHORT
            if (kind === "TP") return Math.min(price, pos.entryPrice - minDistance);
            if (kind === "SL") return Math.max(price, pos.entryPrice + minDistance);
        }
        return price;
    }

    function attachTpSlDrag() {
        if (!overlayEl) return;

        overlayEl.addEventListener('mousemove', (e) => {
            const rect = overlayEl.getBoundingClientRect();
            const y = e.clientY - rect.top;

            if (state.ui.drag.active) {
                const p = yToPrice(y);
                if (p == null) return;

                const newPrice = roundToTick(p); // Snap to tick size

                if (state.ui.drag.kind === "TP" || state.ui.drag.kind === "SL") {
                    const fixed = clampTpSlToDirection(state.ui.drag.kind, newPrice);
                    if (state.ui.drag.kind === "TP") state.ui.tpPrice = fixed;
                    if (state.ui.drag.kind === "SL") state.ui.slPrice = fixed;

                    syncPositionLines();
                    overlayEl.classList.add('dragging');
                    return;
                }

                if (state.ui.drag.kind === "LIMIT") {
                    const orderId = state.ui.drag.orderId;
                    const order = state.orders[orderId];
                    if (!order || order.type !== 'LIMIT') return;

                    // Update order price and re-add to order book
                    removeOrderFromBook(order);
                    order.price = newPrice;
                    addLimitOrderToBook(order);

                    // Update UI immediately (line and order list)
                    syncLimitOrderLines();
                    renderOrders();
                    overlayEl.classList.add('dragging');
                    return;
                }
            }

            // If not dragging, show cursor hint
            const k = pickLineKindByY(y);
            const oid = pickNearestLimitLine(y);

            if (k || oid != null) { overlayEl.style.cursor = 'ns-resize'; return; }
            overlayEl.style.cursor = 'default';
        });

        overlayEl.addEventListener('mousedown', (e) => {
            const rect = overlayEl.getBoundingClientRect();
            const y = e.clientY - rect.top;

            // 1) Prioritize TP/SL first
            const k = pickLineKindByY(y);
            if (k) {
                state.ui.drag.active = true;
                state.ui.drag.kind = k;
                state.ui.drag.orderId = null;
                overlayEl.classList.add('dragging');
                e.preventDefault();
                return;
            }

            // 2) Then check for LIMIT lines
            const oid = pickNearestLimitLine(y);
            if (oid != null) {
                state.ui.drag.active = true;
                state.ui.drag.kind = "LIMIT";
                state.ui.drag.orderId = oid;
                overlayEl.classList.add('dragging');
                e.preventDefault();
                return;
            }
        });

        window.addEventListener('mouseup', () => {
            if (!state.ui.drag.active) return;
            state.ui.drag.active = false;
            state.ui.drag.kind = null;
            state.ui.drag.orderId = null; // Clear orderId for LIMIT orders
            overlayEl.classList.remove('dragging');
        });
    }

    // --- TP/SL TRIGGER LOGIC ---
    // Helper to place reduce-only market close orders for TP/SL
    function placeReduceOnlyMarketClose(symbol, reason) {
        const position = state.positions[symbol];
        if (!position || position.qty <= 0 || position.side === "FLAT") return;

        // Prevent duplicate TP/SL close orders
        const activeId = state.ui.tpSl?.activeCloseOrderId;
        if (activeId && state.orders[activeId] && (state.orders[activeId].status === 'NEW' || state.orders[activeId].status === 'PARTIAL')) {
            return;
        }

        const orderId = state.nextOrderId++;
        const side = (position.side === 'LONG') ? 'SELL' : 'BUY';

        const order = {
            orderId,
            symbol,
            type: 'MARKET',
            side,
            qty: position.qty,          // Close entire position
            price: state.ui.currentPrice, // Will be filled at bid/ask
            filledQty: 0,
            status: 'NEW',
            reduceOnly: true,           // Important for backend
            lockedMarginAmount: 0,
            createdAt: new Date(),
            reason,                     // For logging/display
        };

        state.orders[orderId] = order;
        state.ui.tpSl.activeCloseOrderId = orderId;
        state.ui.tpSl.lastTrigger = reason;

        console.log(`[TP/SL] Triggered ${reason} close order ${orderId} for ${symbol}, qty=${order.qty}`);
        renderOrders();

        // Flash TP/SL tag
        if (reason === "TP" && tpTag) { tpTag.classList.remove('flash-up'); void tpTag.offsetWidth; tpTag.classList.add('flash-up'); }
        if (reason === "SL" && slTag) { slTag.classList.remove('flash-dn'); void slTag.offsetWidth; slTag.classList.add('flash-dn'); }
    }

    // Check if TP/SL conditions are met
    function checkTpSlTriggers() {
        const pos = state.positions[SYMBOL];
        if (!pos || pos.qty <= 0 || pos.side === "FLAT") return;

        const tp = state.ui.tpPrice;
        const sl = state.ui.slPrice;
        if (!(Number.isFinite(tp) && Number.isFinite(sl))) return;

        // Position close is opposite direction market order
        // LONG close (SELL) triggers on bid price
        // SHORT close (BUY) triggers on ask price
        const bid = state.ui.bidPrice;
        const ask = state.ui.askPrice;

        if (pos.side === "LONG") {
            // TP: current bid >= TP price
            // SL: current bid <= SL price
            if (bid >= tp) placeReduceOnlyMarketClose(SYMBOL, "TP");
            else if (bid <= sl) placeReduceOnlyMarketClose(SYMBOL, "SL");
        } else { // SHORT
            // TP: current ask <= TP price
            // SL: current ask >= SL price
            if (ask <= tp) placeReduceOnlyMarketClose(SYMBOL, "TP");
            else if (ask >= sl) placeReduceOnlyMarketClose(SYMBOL, "SL");
        }
    }


    // --- CORE TRADING LOGIC ---
    function placeOrder(side) {
        const type = state.ui.orderType.toUpperCase();
        // Use bid/ask for market orders
        const marketPrice = (side === 'BUY') ? state.ui.askPrice : state.ui.bidPrice; 
        const price = type === 'MARKET' ? marketPrice : parseFloat(priceInput.value);
        const qty = parseFloat(quantityInput.value);
        const symbol = SYMBOL; 

        // --- Client-side Safety Checks ---
        if (isNaN(qty) || qty <= 0) { alert('Invalid quantity. Must be a positive number.'); return; }
        if (type === 'LIMIT' && (isNaN(price) || price <= 0)) { alert('Invalid price. Must be a positive number for Limit orders.'); return; }
        // For market orders, check the derived marketPrice (bid/ask)
        if (type === 'MARKET' && (isNaN(marketPrice) || marketPrice <= 0)) { alert('Current market price (bid/ask) is invalid. Cannot place Market order.'); return; }
        
        const initialOrderMargin = (price * qty) / LEVERAGE;
        if (initialOrderMargin <= 0) { alert('Calculated order margin is zero or negative. Please check price/quantity.'); return; }
        // Check against available balance (calculated by updateAccountMetrics)
        if (initialOrderMargin > state.user.availableBalance) {
            alert(`Insufficient available balance. Available: ${state.user.availableBalance.toFixed(2)} USDT, Required: ${initialOrderMargin.toFixed(2)} USDT.`);
            return;
        }

        const orderId = state.nextOrderId++;
        const order = {
            orderId, symbol, type, side, qty,
            price: price, // Use the price determined by order type (limit or bid/ask)
            filledQty: 0,
            status: 'NEW',
            lockedMarginAmount: initialOrderMargin, // Store the exact amount locked for this order
            createdAt: new Date(),
            onBook: false, // For limit orders, track if it's on the order book
        };
        state.orders[orderId] = order;

        // availableBalance is calculated by updateAccountMetrics. Do not manually modify here.
        
        if (type === 'LIMIT') {
            addLimitOrderToBook(order); // Add to order book
        }
        updateAccountMetrics(); // Re-calculate metrics after order changes lockedByOrders implicitly
        
        console.log(`Placed ${side} ${type} order for ${qty} ${symbol} @ ${order.price.toFixed(2)}. Margin locked: ${order.lockedMarginAmount.toFixed(2)}`);
        
        renderAll();
        if (type === 'LIMIT') priceInput.value = '';
        quantityInput.value = '';
    }

    function cancelOrder(orderId) {
        const order = state.orders[orderId];
        if (!order || (order.status !== 'NEW' && order.status !== 'PARTIAL')) return; // Can cancel NEW or PARTIAL orders

        removeOrderFromBook(order); // Remove from order book if it's a limit order
        order.status = 'CANCELED';
        
        // availableBalance is calculated by updateAccountMetrics. Do not manually modify here.
        updateAccountMetrics(); // Re-calculate metrics after order changes lockedByOrders implicitly
        
        console.log(`Order ${orderId} canceled. Margin unlocked: ${order.lockedMarginAmount.toFixed(2)}`);
        
        renderAll();
    }
    
    function closePosition(symbol) {
        const position = state.positions[symbol];
        if (!position || position.qty === 0) return;
        
        // Create a market order to close the position
        const orderId = state.nextOrderId++;
        const order = {
            orderId, symbol, type: 'MARKET', side: position.side === 'LONG' ? 'SELL' : 'BUY', qty: position.qty,
            price: position.side === 'LONG' ? state.ui.bidPrice : state.ui.askPrice, // Market close uses current opposite bid/ask
            filledQty: 0, status: 'NEW', reduceOnly: true, 
            lockedMarginAmount: 0, // Closing orders don't lock new margin from available
            createdAt: new Date(),
        };
        state.orders[orderId] = order;

        console.log(`Placed market order ${orderId} to close ${symbol} position.`);
        renderOrders(); 
    }

    function tryFillOrders() {
        Object.values(state.orders).forEach(order => {
            // Only process MARKET orders here. LIMIT orders are handled by matchLimitOrdersAgainstPrice
            if (order.type !== 'MARKET') return;
            if (order.status !== 'NEW' && order.status !== 'PARTIAL') return;

            fillMarketOrderUsingBook(order); // Market orders consume from order book
        });
    }

    function matchLimitOrdersAgainstPrice() {
        Object.values(state.orders).forEach(order => {
            if (order.type !== 'LIMIT') return;
            if (order.status !== 'NEW' && order.status !== 'PARTIAL') return;
            if (!order.onBook) return; // Only process orders currently on the book

            const remaining = order.qty - order.filledQty;
            if (remaining <= 1e-12) return;

            const shouldFill =
                (order.side === 'BUY' && state.ui.bidPrice >= order.price) || // Buy limit hits when current bid >= limit price
                (order.side === 'SELL' && state.ui.askPrice <= order.price); // Sell limit hits when current ask <= limit price

            if (shouldFill) {
                // Limit orders that are hit by market price are considered Taker orders
                executeFill(order, order.price, remaining, TAKER_FEE_RATE);
                removeOrderFromBook(order); // Remove from book once filled/partial
            }
        });
    }

    function checkLiquidation() {
        // Cross liquidation trigger: equity <= maintenanceMarginTotal
        if (Object.keys(state.positions).length > 0 && state.user.equity > 0 && state.user.equity <= state.user.maintenanceMarginTotal) {
            console.warn(`ACCOUNT LIQUIDATED! Equity: ${state.user.equity.toFixed(2)}, Maintenance Margin Total: ${state.user.maintenanceMarginTotal.toFixed(2)}`);
            alert(`Your account has been liquidated! Your wallet balance was ${state.user.walletBalance.toFixed(2)} USDT.`);
            
            // --- MVP Liquidation: Create market orders to close all positions ---
            // For each open position, create a market order to close it
            Object.values(state.positions).forEach(pos => {
                const orderId = state.nextOrderId++;
                const order = {
                    orderId, symbol: pos.symbol, type: 'MARKET', side: pos.side === 'LONG' ? 'SELL' : 'BUY', qty: pos.qty,
                    price: pos.side === 'LONG' ? state.ui.bidPrice : state.ui.askPrice, // Market close uses current opposite bid/ask
                    filledQty: 0, status: 'NEW', reduceOnly: true, 
                    lockedMarginAmount: 0, 
                    createdAt: new Date(),
                };
                state.orders[orderId] = order;
            });
            
            state.positions = {}; // Force clear positions for immediate UI update. Ledger records will capture exact losses.
            
            // Record a liquidation fee/loss based on the walletBalance at time of liquidation
            addToLedger('LIQUIDATION_FEE', -state.user.walletBalance, { uid: state.user.uid, description: "Account full liquidation" });
            
            updateAccountMetrics(); 
        }
    }


    // --- EVENT LISTENERS ---
    tabs.forEach(tab => {
        if (tab) { 
            tab.addEventListener('click', (e) => {
                tabs.forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                state.ui.orderType = e.target.dataset.orderType;
                if (limitOrderInputs) { 
                    limitOrderInputs.style.display = state.ui.orderType === 'limit' ? 'block' : 'none';
                }
            });
        }
    });
    
    if (buyBtn) buyBtn.addEventListener('click', () => placeOrder('BUY'));
    if (sellBtn) sellBtn.addEventListener('click', () => placeOrder('SELL'));

    if (ordersBodyEl) {
        ordersBodyEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('cancel-btn')) {
                cancelOrder(parseInt(e.target.dataset.id, 10));
            }
        });
    }

    if (positionsBodyEl) {
        positionsBodyEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('close-btn')) {
                closePosition(e.target.dataset.symbol);
            }
        });
    }

    // Attach order book click handler
    attachOrderBookClick();
    // Attach TP/SL drag handler
    attachTpSlDrag();


    // --- SIMULATION ---
    function startSimulation() {
        setInterval(() => {
            state.ui.lastPrice = state.ui.currentPrice; // Save mark price
            
            const baseChange = (Math.random() - 0.5) * 50; 
            state.ui.currentPrice += baseChange; // markPrice (mid-price)
            if(state.ui.currentPrice <= 0) state.ui.currentPrice = 100;

            updateBidAskFromMid(state.ui.currentPrice);
            rebuildOrderBookFromMid(state.ui.currentPrice);

            checkTpSlTriggers();              // Check TP/SL conditions first
            tryFillOrders();              // Process market orders
            matchLimitOrdersAgainstPrice(); // Then check for limit order fills
            checkLiquidation(); 
            renderPrice(); // This calls updateAccountMetrics, renderOrders and renderPositions
        }, 1500);
    }

    // --- INITIALIZATION ---
    // Fetch initial historical data for chart (example placeholder)
    if (candleSeries) {
        // In a real app, you'd fetch actual historical data
        const historicalData = []; // Replace with actual data fetch
        let time = Date.now() / 1000 - 1000 * 60 * 60 * 24; // 24 hours ago
        for (let i = 0; i < 100; i++) { // 100 bars
            const open = state.ui.currentPrice + rand(-500, 500);
            const close = open + rand(-50, 50);
            const high = Math.max(open, close) + rand(0, 100);
            const low = Math.min(open, close) - rand(0, 100);
            historicalData.push({ time: time + i * 60 * 60, open, high, low, close });
        }
        candleSeries.setData(historicalData);
        chart.timeScale().fitContent(); // Fit chart to data
    }

    updateBidAskFromMid(state.ui.currentPrice); 
    rebuildOrderBookFromMid(state.ui.currentPrice);
    updateAccountMetrics(); // Initial calculation of equity/available
    renderAll();
    startSimulation();
    console.log('Script initialized and simulation started.');
});