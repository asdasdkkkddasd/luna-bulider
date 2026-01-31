document.addEventListener('DOMContentLoaded', () => {
    console.log('Script started: DOMContentLoaded');

    // --- CONSTANTS ---
    const LEVERAGE = 20; // Fixed leverage for MVP
    const MMR = 0.005; // Maintenance Margin Rate (0.5%)
    const FEE_RATE = 0.0004; // 0.04% fee per trade
    const SPREAD_BPS = 2; // 2 bps = 0.02% (2/10000) - for spread calculation
    const SYMBOL = 'BTC-USDT'; // Hardcoded symbol

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
        
        // --- Client-side UI state ---
        ui: {
            orderType: 'limit',
            lastPrice: 60000, // Last markPrice
            currentPrice: 60000, // Current markPrice (mid-price)
            bidPrice: 59995,   // ✅ Added for spread
            askPrice: 60005,   // ✅ Added for spread
        },
        
        // --- Sequence for IDs ---
        nextOrderId: 1,
        nextTradeId: 1,
        nextLedgerId: 1,
    };

    // --- DOM ELEMENTS ---
    const bidPriceEl = document.getElementById('bid-price'); // New
    const askPriceEl = document.getElementById('ask-price'); // New
    const balanceDisplayEl = document.getElementById('balance-display');
    const ordersBodyEl = document.getElementById('orders-body');
    const positionsBodyEl = document.getElementById('positions-body');
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');
    const priceInput = document.getElementById('price');
    const quantityInput = document.getElementById('quantity');
    const limitOrderInputs = document.getElementById('limit-order-inputs');
    const tabs = document.querySelectorAll('.tab-btn');
    console.log('DOM Elements obtained:', { bidPriceEl, askPriceEl, balanceDisplayEl, ordersBodyEl, positionsBodyEl, buyBtn, sellBtn, priceInput, quantityInput, limitOrderInputs, tabs });


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

    // --- BID/ASK CALCULATION ---
    function updateBidAskFromMid(mid) {
        const halfSpread = mid * (SPREAD_BPS / 10000) / 2;
        state.ui.bidPrice = Math.max(0.01, mid - halfSpread);
        state.ui.askPrice = Math.max(state.ui.bidPrice + 0.01, mid + halfSpread); // Ensure ask > bid
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
                positionsBodyEl.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-secondary);">No open positions.</td></tr>`; // 5 columns as Liquidation Price removed
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

    function renderAll() {
        console.log('Rendering all UI components...');
        // updateAccountMetrics is called by renderPrice and addToLedger, ensuring latest metrics
        renderBalance();
        renderPrice();
        // renderOrders and renderPositions are called by renderPrice, no need to call twice
    }

    // --- EXECUTE FILL FUNCTION (from user's prompt) ---
    /**
     * Executes a single fill for an order.
     * @param {object} order - The order object.
     * @param {number} fillPrice - The price at which to fill.
     * @param {number} fillQty - The quantity to fill.
     */
    function executeFill(order, fillPrice, fillQty) {
        // 1) tradeId 하나만 생성
        const tradeId = state.nextTradeId++;

        // 2) 포지션 업데이트
        const currentPosition = state.positions[order.symbol] || { side: "FLAT", qty: 0, entryPrice: 0, status: "CLOSED" };
        const fill = { side: /** @type {Side} */(order.side), qty: fillQty, price: fillPrice };
        const { pos: updatedPosition, realizedPnl } = applyFillNet(currentPosition, fill);

        // 3) realized pnl
        if (realizedPnl !== 0) addToLedger('REALIZED_PNL', realizedPnl, { orderId: order.orderId, tradeId, symbol: order.symbol });

        // 4) fee
        const fee = Math.abs(fillPrice * fillQty) * FEE_RATE;
        addToLedger('FEE', -fee, { orderId: order.orderId, tradeId, symbol: order.symbol });

        // 5) 포지션 저장
        if (updatedPosition.qty === 0 || updatedPosition.side === "FLAT") {
            delete state.positions[order.symbol];
        } else {
            state.positions[order.symbol] = {
                ...updatedPosition,
                symbol: order.symbol,
                leverage: LEVERAGE,
                marginMode: 'CROSS',
                status: 'OPEN',
                updatedAt: new Date(),
            };
        }

        // 6) 주문 업데이트
        order.filledQty += fillQty;
        order.status = (order.filledQty >= order.qty) ? 'FILLED' : 'PARTIAL';
    }


    // --- CORE TRADING LOGIC ---
    function placeOrder(side) {
        const type = state.ui.orderType.toUpperCase();
        // Use bid/ask for market orders
        const marketPrice = (side === 'BUY') ? state.ui.askPrice : state.ui.bidPrice; 
        const price = type === 'MARKET' ? marketPrice : parseFloat(priceInput.value);
        const qty = parseFloat(quantityInput.value);
        const symbol = SYMBOL; 

        // --- Client-side Safety Checks (from user's prompt #6 and #0) ---
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
        };
        state.orders[orderId] = order;

        // availableBalance is calculated by updateAccountMetrics. Do not manually modify here.
        updateAccountMetrics(); // Re-calculate metrics after order changes lockedByOrders implicitly
        
        console.log(`Placed ${side} ${type} order for ${qty} ${symbol} @ ${order.price.toFixed(2)}. Margin locked: ${order.lockedMarginAmount.toFixed(2)}`);
        
        renderAll();
        if (type === 'LIMIT') priceInput.value = '';
        quantityInput.value = '';
    }

    function cancelOrder(orderId) {
        const order = state.orders[orderId];
        if (!order || order.status !== 'NEW') return;

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
            if (order.status !== 'NEW') return;
            
            // Determine fill price based on order type and side
            let fillPrice;
            if (order.type === 'MARKET') {
                fillPrice = (order.side === 'BUY') ? state.ui.askPrice : state.ui.bidPrice;
            } else { // LIMIT order
                fillPrice = order.price;
            }

            const shouldFill = (order.type === 'MARKET') ||
                               (order.side === 'BUY' && state.ui.bidPrice >= order.price) || // Buy limit hits when current bid >= limit price
                               (order.side === 'SELL' && state.ui.askPrice <= order.price); // Sell limit hits when current ask <= limit price
            
            if (shouldFill) {
                executeFill(order, fillPrice, order.qty);
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
            // These liquidation orders will be filled in the next tryFillOrders cycle.
            // All positions will be effectively removed when their closing orders are filled.
            // The walletBalance will naturally adjust via REALIZED_PNL and FEE from these fills.
            
            // Simplified: Force clear positions from state immediately for UI, but the ledger records the PnL/Fee from fills.
            state.positions = {}; 

            // Record a liquidation fee/loss based on the walletBalance at time of liquidation
            // This is a simplified approach, real exchanges have insurance funds etc.
            addToLedger('LIQUIDATION_FEE', -state.user.walletBalance, { uid: state.user.uid, description: "Account full liquidation" });
            
            // After this, walletBalance will be adjusted by the above ledger entry.
            // All other metrics will be recalculated by updateAccountMetrics().
            
            updateAccountMetrics(); // Recalculate everything after liquidation orders are created
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

    // --- SIMULATION ---
    function startSimulation() {
        setInterval(() => {
            state.ui.lastPrice = state.ui.currentPrice; // Save mark price
            
            const baseChange = (Math.random() - 0.5) * 50; 
            state.ui.currentPrice += baseChange; // markPrice (mid-price)
            if(state.ui.currentPrice <= 0) state.ui.currentPrice = 100;

            // ✅ Update bid/ask based on currentPrice(=mid)
            updateBidAskFromMid(state.ui.currentPrice);
            
            tryFillOrders();
            checkLiquidation(); 
            renderPrice(); // This calls updateAccountMetrics, renderOrders and renderPositions
        }, 1500);
    }

    // --- INITIALIZATION ---
    // ✅ Initial call to set bid/ask
    updateBidAskFromMid(state.ui.currentPrice); 
    updateAccountMetrics(); // Initial calculation of equity/available
    renderAll();
    startSimulation();
    console.log('Script initialized and simulation started.');
});